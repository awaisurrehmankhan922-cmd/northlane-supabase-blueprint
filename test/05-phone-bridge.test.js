// The phone bridge: AMI events become the CRM's four events; webhooks and Yealink URLs
// are verified before anything is read; the CRM receives exactly what page 21 specifies.
// Runs a fake AMI server and a fake CRM on local ports; no phone system needed.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.PHONE_EVENT_KEY = 'k-' + crypto.randomBytes(8).toString('hex');
process.env.WEBHOOK_KEY = 'w-' + crypto.randomBytes(8).toString('hex');
process.env.EXTENSIONS = '201,202,203';
const bridge = require('../phone-bridge/bridge');

// ---- a fake CRM that records what it receives --------------------------------
const received = [];
let crm;
before(async () => {
  crm = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (req.headers['x-phone-key'] !== process.env.PHONE_EVENT_KEY) { res.writeHead(403); return res.end('bad key'); }
      received.push(JSON.parse(b));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
  });
  await new Promise((r) => crm.listen(0, r));
  bridge.cfg.crmUrl = `http://127.0.0.1:${crm.address().port}/api/phone/event`;
});
after(() => { crm.closeAllConnections(); crm.close(); });

const waitFor = (n) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() { if (received.length >= n) return resolve(); if (Date.now() - t0 > 3000) return reject(new Error(`only ${received.length}/${n} events reached the CRM`)); setTimeout(poll, 10); })();
});

// ---- pure mapping -------------------------------------------------------------
test('numbers normalise to +44; withheld is kept as a word', () => {
  assert.equal(bridge.normaliseNumber('01274 123456'), '+441274123456');
  assert.equal(bridge.normaliseNumber('+44 7700 900123'), '+447700900123');
  assert.equal(bridge.normaliseNumber('0044 7700900123'), '+447700900123');
  assert.equal(bridge.normaliseNumber('anonymous'), 'withheld');
});

test('AMI: ring → answer by another extension → transfer; internal calls are ignored', () => {
  const out = [], calls = new Map(), e = (ev) => out.push(ev);
  bridge.handleAmiEvent({ Event: 'Newchannel', Linkedid: 'L1', CallerIDNum: '07700900123', Exten: '201' }, calls, e);
  bridge.handleAmiEvent({ Event: 'Newchannel', Linkedid: 'L1', CallerIDNum: '07700900123', Exten: '201' }, calls, e); // duplicate from Asterisk
  bridge.handleAmiEvent({ Event: 'BridgeEnter', Linkedid: 'L1', CallerIDNum: '202', ConnectedLineNum: '07700900123' }, calls, e);
  bridge.handleAmiEvent({ Event: 'BlindTransfer', Linkedid: 'L1', Extension: '203' }, calls, e);
  bridge.handleAmiEvent({ Event: 'Hangup', Linkedid: 'L1' }, calls, e);
  assert.deepEqual(out, [
    { type: 'ringing', call: 'L1', from: '+447700900123', ext: '201' },
    { type: 'ringing', call: 'L1', from: '+447700900123', ext: '201' }, // de-duplication happens in emit(), tested below
    { type: 'answered', call: 'L1', from: '+447700900123', ext: '202' },
    { type: 'transferred', call: 'L1', from: '+447700900123', ext: '203' },
  ]);
  // internal ext-to-ext: nothing
  const out2 = [];
  bridge.handleAmiEvent({ Event: 'Newchannel', Linkedid: 'L2', CallerIDNum: '201', Exten: '202' }, new Map(), (ev) => out2.push(ev));
  assert.deepEqual(out2, []);
});

test('AMI: a hangup before anyone answers is "missed"; after an answer it is nothing', () => {
  const out = [], calls = new Map(), e = (ev) => out.push(ev);
  bridge.handleAmiEvent({ Event: 'Newchannel', Linkedid: 'L3', CallerIDNum: '07700900999', Exten: '201' }, calls, e);
  bridge.handleAmiEvent({ Event: 'Hangup', Linkedid: 'L3' }, calls, e);
  assert.equal(out[1].type, 'missed');
  assert.equal(calls.size, 0, 'state is cleaned up');
});

// ---- end to end over a fake AMI socket ---------------------------------------
test('end to end: fake Asterisk → bridge → CRM receives the four events once each, with the key header', async () => {
  received.length = 0;
  const ami = net.createServer((sock) => {
    sock.write('Asterisk Call Manager/6.0.0\r\n');
    sock.on('data', (d) => {
      if (/Action: Login/.test(String(d))) {
        sock.write('Response: Success\r\nMessage: Authentication accepted\r\n\r\n');
        const ev = (o) => sock.write(Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
        ev({ Event: 'Newchannel', Linkedid: 'E2E', CallerIDNum: '07700900123', Exten: '201' });
        ev({ Event: 'DialBegin', Linkedid: 'E2E', CallerIDNum: '07700900123', DestExten: '201' }); // Asterisk often sends both
        ev({ Event: 'BridgeEnter', Linkedid: 'E2E', CallerIDNum: '201', ConnectedLineNum: '07700900123' });
        ev({ Event: 'AttendedTransfer', Linkedid: 'E2E', TransferTargetCallerIDNum: '203' });
        ev({ Event: 'Hangup', Linkedid: 'E2E' });
      }
    });
  });
  await new Promise((r) => ami.listen(0, r));
  bridge.cfg.amiHost = '127.0.0.1'; bridge.cfg.amiPort = ami.address().port; bridge.cfg.amiUser = 'crm'; bridge.cfg.amiSecret = 's';
  const link = bridge.startAmi();
  await waitFor(3);
  assert.deepEqual(received.map((r) => r.type), ['ringing', 'answered', 'transferred']);
  assert.deepEqual(Object.keys(received[0]).sort(), ['call', 'ext', 'from', 'type'], 'exactly the four fields the CRM expects');
  assert.equal(received[0].from, '+447700900123');
  assert.equal(received[2].ext, '203');
  link.stop();
  await new Promise((r) => ami.close(r));
});

// ---- webhook and Yealink listeners --------------------------------------------
test('webhook: refused without the key; stale events ignored; a good one reaches the CRM', async () => {
  received.length = 0;
  const mk = (headers, body) => ({ method: 'POST', headers });
  const body = JSON.stringify({ event: 'ring', call_id: 'W1', caller: '07700900555', extension: '202', timestamp: new Date().toISOString() });
  assert.equal(bridge.handleWebhook(mk({}), body, bridge.emit).status, 403);
  assert.equal(bridge.handleWebhook(mk({ 'x-webhook-key': 'wrong' }), body, bridge.emit).status, 403);
  const old = JSON.stringify({ event: 'ring', call_id: 'W0', caller: '1', extension: '202', timestamp: '2020-01-01T00:00:00Z' });
  assert.match(bridge.handleWebhook(mk({ 'x-webhook-key': process.env.WEBHOOK_KEY }), old, bridge.emit).text, /stale/);
  assert.equal(bridge.handleWebhook(mk({ 'x-webhook-key': process.env.WEBHOOK_KEY }), body, bridge.emit).status, 200);
  await waitFor(1);
  assert.deepEqual(received[0], { type: 'ringing', call: 'W1', from: '+447700900555', ext: '202' });
});

test('webhook: HMAC mode verifies the body signature', () => {
  bridge.cfg.webhookHmacSecret = 'hm';
  const body = JSON.stringify({ event: 'answered', call_id: 'H1', caller: '07700900555', extension: '202' });
  const good = crypto.createHmac('sha256', 'hm').update(body).digest('hex');
  const out = [];
  assert.equal(bridge.handleWebhook({ method: 'POST', headers: { 'x-signature': good } }, body, (e) => out.push(e)).status, 200);
  assert.equal(bridge.handleWebhook({ method: 'POST', headers: { 'x-signature': 'bad' } }, body, (e) => out.push(e)).status, 403);
  assert.equal(out.length, 1);
  bridge.cfg.webhookHmacSecret = '';
});

test('Yealink Action URLs: incoming → answered, or incoming → ended = missed; key required', () => {
  const out = [];
  const req = (q) => ({ method: 'GET', url: `/yealink?${q}&key=${process.env.WEBHOOK_KEY}` });
  assert.equal(bridge.handleYealink({ method: 'GET', url: '/yealink?ev=incoming&call=Y0&from=1&ext=201&key=nope' }, (e) => out.push(e)).status, 403);
  bridge.handleYealink(req('ev=incoming&call=Y1&from=07700900777&ext=201'), (e) => out.push(e));
  bridge.handleYealink(req('ev=ended&call=Y1&from=07700900777&ext=201'), (e) => out.push(e));
  bridge.handleYealink(req('ev=incoming&call=Y2&from=07700900777&ext=201'), (e) => out.push(e));
  bridge.handleYealink(req('ev=answered&call=Y2&from=07700900777&ext=201'), (e) => out.push(e));
  bridge.handleYealink(req('ev=ended&call=Y2&from=07700900777&ext=201'), (e) => out.push(e));
  assert.deepEqual(out.map((e) => `${e.call}:${e.type}`), ['Y1:ringing', 'Y1:missed', 'Y2:ringing', 'Y2:answered']);
});

test('emit() de-duplicates per call, so Asterisk sending Newchannel and DialBegin posts one "ringing"', async () => {
  received.length = 0;
  bridge.emit({ type: 'ringing', call: 'D1', from: '+441', ext: '201' });
  bridge.emit({ type: 'ringing', call: 'D1', from: '+441', ext: '201' });
  bridge.emit({ type: 'transferred', call: 'D1', from: '+441', ext: '202' });
  bridge.emit({ type: 'transferred', call: 'D1', from: '+441', ext: '203' }); // a second transfer is real
  await waitFor(3);
  assert.deepEqual(received.map((r) => `${r.type}:${r.ext}`), ['ringing:201', 'transferred:202', 'transferred:203']);
});
