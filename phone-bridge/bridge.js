#!/usr/bin/env node
// phone-bridge/bridge.js · the small program between the phone system and the CRM
//
// The CRM side is built (briefing page 21): POST /api/phone/event with X-Phone-Key and
//   { type: ringing|answered|transferred|missed, call, from, ext }
// This is the other side. One process, no npm packages, three ways in depending on what
// Commerce Business Systems (TINKLE, Asterisk-based) will give us:
//
//   MODE=ami       we connect out to the Asterisk Manager Interface over the office network
//                  or a VPN. AMI is never exposed to the internet. Click-to-dial uses Originate.
//   MODE=webhook   the supplier pushes call events to us. We verify a shared key (or HMAC)
//                  and an address allow-list before reading anything else.
//   MODE=yealink   the handsets themselves call our Action URLs (incoming / answered / ended).
//                  Needs the bridge reachable from the office network. No click-to-dial.
//
// Whatever the mode, every event is normalised, de-duplicated per call, queued, and posted
// to the CRM with retries. Nothing is dropped silently; a failed post is logged with its reason.

const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const cfg = {
  mode: process.env.MODE || 'ami',
  crmUrl: process.env.CRM_URL || 'https://crm.northlane.example/api/phone/event',
  phoneKey: process.env.PHONE_EVENT_KEY || '',
  // AMI
  amiHost: process.env.AMI_HOST || '127.0.0.1',
  amiPort: Number(process.env.AMI_PORT || 5038),
  amiUser: process.env.AMI_USER || '',
  amiSecret: process.env.AMI_SECRET || '',
  amiContext: process.env.AMI_CONTEXT || 'from-internal',
  // webhook / yealink listener
  listenPort: Number(process.env.LISTEN_PORT || 8088),
  webhookKey: process.env.WEBHOOK_KEY || '',
  webhookHmacSecret: process.env.WEBHOOK_HMAC_SECRET || '',
  allowFrom: (process.env.ALLOW_FROM || '').split(',').map((s) => s.trim()).filter(Boolean),
  // the office's own extensions, so we ignore internal ext-to-ext calls
  extensions: (process.env.EXTENSIONS || '').split(',').map((s) => s.trim()).filter(Boolean),
  officeNumber: process.env.OFFICE_NUMBER || '',
};

// ---------------------------------------------------------------------------
// Normalising
// ---------------------------------------------------------------------------
function normaliseNumber(raw) {
  if (!raw) return '';
  let d = String(raw).replace(/[^\d+]/g, '');
  if (/^(anonymous|unknown|withheld|private)$/i.test(raw) || d === '') return 'withheld';
  if (d.startsWith('+')) return d;
  if (d.startsWith('00')) return '+' + d.slice(2);
  if (/^0\d{9,10}$/.test(d)) return '+44' + d.slice(1);
  if (/^44\d{9,10}$/.test(d)) return '+' + d;
  return d; // leave anything odd as-is; the CRM matches on digits anyway
}

function isExtension(n) {
  return cfg.extensions.length ? cfg.extensions.includes(String(n)) : /^\d{2,4}$/.test(String(n || ''));
}

// ---------------------------------------------------------------------------
// Posting to the CRM, with a queue and retries
// ---------------------------------------------------------------------------
const seen = new Map(); // call id → Set of types already sent (stops AMI double events)
const queue = [];
let sending = false;

function emit(ev) {
  if (!ev.call || !ev.type || !ev.ext) return;
  const key = `${ev.call}`;
  const types = seen.get(key) || new Set();
  // 'transferred' may legitimately repeat with a new ext, so key those on ext too
  const dedupeKey = ev.type === 'transferred' ? `${ev.type}:${ev.ext}` : ev.type;
  if (types.has(dedupeKey)) return;
  types.add(dedupeKey);
  seen.set(key, types);
  setTimeout(() => seen.delete(key), 30 * 60 * 1000).unref();
  queue.push({ ev, tries: 0 });
  pump();
}

async function pump() {
  if (sending) return;
  sending = true;
  while (queue.length) {
    const item = queue[0];
    try {
      await postToCrm(item.ev);
      log('sent', item.ev.type, item.ev.call, item.ev.from, '→ ext', item.ev.ext);
      queue.shift();
    } catch (e) {
      item.tries++;
      log('post failed', item.tries, e.message);
      if (item.tries >= 5) { log('GIVING UP on', JSON.stringify(item.ev)); queue.shift(); continue; }
      await sleep(Math.min(30000, 250 * 2 ** item.tries));
    }
  }
  sending = false;
}

function postToCrm(ev) {
  return new Promise((resolve, reject) => {
    if (!cfg.phoneKey) return reject(new Error('PHONE_EVENT_KEY is not set'));
    const u = new URL(cfg.crmUrl);
    const body = JSON.stringify({ type: ev.type, call: ev.call, from: ev.from, ext: ev.ext });
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST', timeout: 5000, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-phone-key': cfg.phoneKey, 'x-nl': '1' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error(`CRM said ${res.statusCode}: ${data.slice(0, 120)}`))));
    });
    req.on('timeout', () => req.destroy(new Error('CRM timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// MODE=ami · Asterisk Manager Interface
// ---------------------------------------------------------------------------
// Event mapping (page 21): Newchannel/DialBegin → ringing · BridgeEnter → answered
//                          BlindTransfer/AttendedTransfer → transferred · Hangup before answer → missed
function startAmi({ connect = net.connect } = {}) {
  let sock, buf = '', loggedIn = false, backoff = 1000, stopped = false, timer = null;
  const calls = new Map(); // Linkedid → { from, answered, ext }

  function send(action, fields = {}) {
    const id = crypto.randomUUID();
    sock.write(`Action: ${action}\r\nActionID: ${id}\r\n` + Object.entries(fields).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
    return id;
  }

  function onPacket(p) {
    if (p.Response === 'Success' && /Authentication accepted/i.test(p.Message || '')) { loggedIn = true; backoff = 1000; log('AMI logged in'); return; }
    if (p.Response === 'Error') { log('AMI error', p.Message); return; }
    handleAmiEvent(p, calls, emit);
  }

  function open() {
    sock = connect({ host: cfg.amiHost, port: cfg.amiPort });
    sock.setEncoding('utf8');
    sock.on('connect', () => { log('AMI connected to', cfg.amiHost); send('Login', { Username: cfg.amiUser, Secret: cfg.amiSecret, Events: 'call' }); });
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n\r\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 4);
        const p = {};
        for (const line of raw.split('\r\n')) { const j = line.indexOf(':'); if (j > 0) p[line.slice(0, j).trim()] = line.slice(j + 1).trim(); }
        if (Object.keys(p).length) onPacket(p);
      }
    });
    sock.on('close', () => {
      loggedIn = false;
      if (stopped) return;
      log('AMI closed; reconnecting in', backoff);
      timer = setTimeout(open, backoff); timer.unref();
      backoff = Math.min(60000, backoff * 2);
    });
    sock.on('error', (e) => log('AMI error', e.message));
  }
  open();

  return {
    // Click-to-dial: the person's own desk phone rings, then dials the number.
    dial(ext, number) {
      if (!loggedIn) throw new Error('Phone system link is down');
      send('Originate', { Channel: `Local/${ext}@${cfg.amiContext}`, Exten: normaliseNumber(number).replace('+44', '0'), Context: cfg.amiContext, Priority: 1, CallerID: `"North Lane" <${cfg.officeNumber}>`, Async: 'true' });
    },
    stop() { stopped = true; clearTimeout(timer); sock?.destroy(); },
    _calls: calls,
  };
}

// Pure function so it is testable without a socket.
function handleAmiEvent(p, calls, emitFn) {
  const id = p.Linkedid || p.Uniqueid;
  if (!id) return;
  switch (p.Event) {
    case 'Newchannel':
    case 'DialBegin': {
      // an outside caller ringing an extension
      const from = normaliseNumber(p.CallerIDNum);
      const ext = p.DestExten || p.Exten || p.DialString?.split('/').pop();
      if (isExtension(from) || !isExtension(ext)) return; // internal or not an extension: ignore
      calls.set(id, { from, ext, answered: false });
      emitFn({ type: 'ringing', call: id, from, ext });
      break;
    }
    case 'BridgeEnter': {
      const c = calls.get(id);
      if (!c || c.answered) return;
      // the channel that is NOT the caller is the extension that answered
      const ext = isExtension(p.CallerIDNum) ? p.CallerIDNum : (isExtension(p.ConnectedLineNum) ? p.ConnectedLineNum : c.ext);
      c.answered = true; c.ext = ext;
      emitFn({ type: 'answered', call: id, from: c.from, ext });
      break;
    }
    case 'BlindTransfer':
    case 'AttendedTransfer': {
      const c = calls.get(id);
      if (!c) return;
      const ext = p.Extension || p.TransferTargetCallerIDNum || p.TransfereeCallerIDNum;
      if (!isExtension(ext)) return;
      c.ext = ext;
      emitFn({ type: 'transferred', call: id, from: c.from, ext });
      break;
    }
    case 'Hangup': {
      const c = calls.get(id);
      if (!c) return;
      if (!c.answered) emitFn({ type: 'missed', call: id, from: c.from, ext: c.ext });
      calls.delete(id);
      break;
    }
    default:
  }
}

// ---------------------------------------------------------------------------
// MODE=webhook · the supplier pushes events to us
// MODE=yealink · the handsets call Action URLs (GET with query parameters)
// ---------------------------------------------------------------------------
function startListener({ listen = true } = {}) {
  const server = http.createServer((req, res) => {
    const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
    if (cfg.allowFrom.length && !cfg.allowFrom.includes(ip)) { res.writeHead(403); return res.end('no'); }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        const out = cfg.mode === 'yealink' ? handleYealink(req, emit) : handleWebhook(req, body, emit);
        res.writeHead(out.status, { 'content-type': 'text/plain' }); res.end(out.text);
      } catch (e) { res.writeHead(400); res.end(e.message); }
    });
  });
  if (listen) server.listen(cfg.listenPort, () => log(`${cfg.mode} listener on :${cfg.listenPort}`));
  return server;
}

function handleWebhook(req, body, emitFn) {
  if (req.method !== 'POST') return { status: 405, text: 'POST only' };
  // Shared key, or HMAC-SHA256 over the raw body if the supplier supports signing.
  const sigOk = cfg.webhookHmacSecret
    ? safeEqual(req.headers['x-signature'] || '', crypto.createHmac('sha256', cfg.webhookHmacSecret).update(body).digest('hex'))
    : safeEqual(req.headers['x-webhook-key'] || '', cfg.webhookKey);
  if (!sigOk) return { status: 403, text: 'bad signature' };
  const j = JSON.parse(body);
  // replay guard: events older than 2 minutes are ignored
  if (j.timestamp && Math.abs(Date.now() - new Date(j.timestamp).getTime()) > 120000) return { status: 200, text: 'stale, ignored' };
  const type = ({ ring: 'ringing', ringing: 'ringing', answer: 'answered', answered: 'answered', transfer: 'transferred', transferred: 'transferred', missed: 'missed', noanswer: 'missed' })[String(j.event || j.type).toLowerCase()];
  if (!type) return { status: 200, text: 'ignored' };
  emitFn({ type, call: String(j.call_id || j.callId || j.id), from: normaliseNumber(j.caller || j.from), ext: String(j.extension || j.ext) });
  return { status: 200, text: 'ok' };
}

// Yealink Action URL examples (set on each handset's web UI under Features > Action URL):
//   Incoming call:  http://bridge:8088/yealink?ev=incoming&call=$call_id&from=$remote&ext=$active_user&key=KEY
//   Call answered:  http://bridge:8088/yealink?ev=answered&call=$call_id&from=$remote&ext=$active_user&key=KEY
//   Call ended:     http://bridge:8088/yealink?ev=ended&call=$call_id&from=$remote&ext=$active_user&key=KEY
function handleYealink(req, emitFn) {
  const u = new URL(req.url, 'http://x');
  if (!safeEqual(u.searchParams.get('key') || '', cfg.webhookKey)) return { status: 403, text: 'bad key' };
  const ev = u.searchParams.get('ev'), call = u.searchParams.get('call'), from = normaliseNumber(u.searchParams.get('from')), ext = u.searchParams.get('ext');
  const state = yealinkState.get(call) || { answered: false };
  if (ev === 'incoming') { yealinkState.set(call, state); emitFn({ type: 'ringing', call, from, ext }); }
  else if (ev === 'answered') { state.answered = true; yealinkState.set(call, state); emitFn({ type: 'answered', call, from, ext }); }
  else if (ev === 'ended') { if (!state.answered) emitFn({ type: 'missed', call, from, ext }); yealinkState.delete(call); }
  return { status: 200, text: 'ok' };
}
const yealinkState = new Map();

// ---------------------------------------------------------------------------
function safeEqual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return !!b && x.length === y.length && crypto.timingSafeEqual(x, y); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms).unref()); }
function log(...a) { console.log(new Date().toISOString(), ...a); }

if (require.main === module) {
  if (!cfg.phoneKey) { console.error('PHONE_EVENT_KEY is required'); process.exit(2); }
  if (cfg.mode === 'ami') startAmi();
  else startListener();
}

module.exports = { cfg, normaliseNumber, handleAmiEvent, handleWebhook, handleYealink, startAmi, startListener, emit, _queue: queue, _seen: seen };
