// backend/mailer.js · the "post van" for the outbox (briefing page 20)
//
// Matches the contract the CRM's mailer.js already defines:
//
//   send(msg) gets { id, from: {name,email}, to: [{name,email}], subject, text,
//                    attachments: [{ name, type, read() /* Buffer */ }] }
//   resolve { ref } (the service's id), or throw an Error whose message is shown to staff.
//
// Two real providers plus the existing test/off ones. Pick with EMAIL_PROVIDER.
// Secrets come from the environment only, never from Settings.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// `fetch` is injectable so the tests run without the network.
function makeProviders({ fetch = globalThis.fetch, env = process.env } = {}) {
  return {
    // Writes what would have gone, for the office to inspect.
    test: {
      name: 'Test (nothing leaves the CRM)',
      async send(msg) {
        const dir = env.OUTBOX_TEST_DIR || 'data/outbox-test';
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${msg.id}.json`), JSON.stringify({ ...msg, attachments: msg.attachments?.map((a) => a.name) }, null, 2));
        return { ref: `test-${msg.id}` };
      },
    },

    off: {
      name: 'Off',
      async send() { throw new Error('Email is not set up yet'); },
    },

    // Microsoft 365, sending as the office mailbox through Microsoft Graph.
    // Azure app registration: application permission Mail.Send, restricted to the one
    // mailbox with an Exchange ApplicationAccessPolicy, so the key can send as nobody else.
    graph: {
      name: 'Microsoft 365',
      async send(msg) {
        const tenant = need(env, 'GRAPH_TENANT_ID');
        const token = await graphToken(fetch, tenant, need(env, 'GRAPH_CLIENT_ID'), need(env, 'GRAPH_CLIENT_SECRET'));
        const mailbox = need(env, 'GRAPH_MAILBOX'); // e.g. office@northlane.example
        const body = {
          message: {
            subject: msg.subject,
            body: { contentType: 'Text', content: msg.text },
            from: { emailAddress: { name: msg.from.name, address: mailbox } },
            toRecipients: msg.to.map((t) => ({ emailAddress: { name: t.name, address: t.email } })),
            internetMessageHeaders: [{ name: 'X-NL-Outbox', value: msg.id }],
            attachments: await Promise.all((msg.attachments || []).map(async (a) => ({
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: a.name, contentType: a.type,
              contentBytes: Buffer.from(await a.read()).toString('base64'),
            }))),
          },
          saveToSentItems: true,
        };
        const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (r.status !== 202) throw new Error(`Microsoft 365 refused the email (${r.status}): ${await safeText(r)}`);
        // Graph returns no message id on sendMail; our header X-NL-Outbox is the join key for bounces.
        return { ref: `graph:${msg.id}` };
      },
    },

    // A transactional service. Postmark shown; Resend/SES are the same shape.
    // Gives real delivery and bounce webhooks, which Graph does not.
    postmark: {
      name: 'Postmark',
      async send(msg) {
        const r = await fetch('https://api.postmarkapp.com/email', {
          method: 'POST',
          headers: { 'X-Postmark-Server-Token': need(env, 'POSTMARK_TOKEN'), 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            From: `${msg.from.name} <${need(env, 'POSTMARK_FROM')}>`,
            To: msg.to.map((t) => `${t.name} <${t.email}>`).join(', '),
            Subject: msg.subject, TextBody: msg.text,
            MessageStream: 'outbound', Tag: msg.id, Metadata: { outbox: msg.id },
            Attachments: await Promise.all((msg.attachments || []).map(async (a) => ({
              Name: a.name, ContentType: a.type, Content: Buffer.from(await a.read()).toString('base64'),
            }))),
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ErrorCode) throw new Error(`Postmark refused the email: ${j.Message || r.status}`);
        return { ref: j.MessageID };
      },
    },
  };
}

async function graphToken(fetch, tenant, clientId, secret) {
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  if (!r.ok) throw new Error(`Microsoft 365 sign-in failed (${r.status})`);
  return (await r.json()).access_token;
}

// ---------------------------------------------------------------------------
// Bounces and deliveries: a webhook from the provider updates the outbox line.
// Verified before anything is read: Postmark uses HTTP basic auth on the webhook URL
// plus an IP allow-list; here we also require a shared secret header so the URL alone
// is not enough.
// ---------------------------------------------------------------------------
function verifyWebhook(headers, secret) {
  const given = headers['x-nl-webhook-key'] || '';
  const a = Buffer.from(given), b = Buffer.from(secret || '');
  return !!secret && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Map a Postmark webhook body to an outbox update: { outboxId, status, error } or null. */
function postmarkEventToOutbox(body) {
  const outboxId = body?.Metadata?.outbox || body?.Tag;
  if (!outboxId) return null;
  switch (body.RecordType) {
    case 'Delivery': return { outboxId, status: 'delivered' };
    case 'Bounce':
    case 'SpamComplaint': return { outboxId, status: 'bounced', error: `${body.Type || body.RecordType}: ${body.Description || ''}`.trim() };
    default: return null;
  }
}

// Microsoft 365 has no bounce webhook. The job reads non-delivery reports from the office
// mailbox through Graph and matches them to outbox lines by the X-NL-Outbox header we set.
function graphNdrToOutbox(ndrMessage) {
  const hdr = (ndrMessage.internetMessageHeaders || []).find((h) => /x-nl-outbox/i.test(h.name));
  const fromBody = /X-NL-Outbox:\s*([A-Za-z0-9_-]+)/.exec(ndrMessage.body?.content || '');
  const outboxId = hdr?.value || fromBody?.[1];
  return outboxId ? { outboxId, status: 'bounced', error: ndrMessage.subject } : null;
}

// ---------------------------------------------------------------------------
// The sender the jobs call: tries, retries twice a minute apart, records the result.
// ---------------------------------------------------------------------------
function makeMailer({ provider, store, log = console }) {
  return {
    async sendOne(line, msg) {
      try {
        const { ref } = await provider.send(msg);
        await store.asServer((c) => c.query(
          `update public.outbox set status='sent', provider_ref=$2, sent_at=now(), attempts=attempts+1, updated_at=now(), error=null where id=$1`, [line.id, ref]));
        return { ok: true, ref };
      } catch (e) {
        const attempts = line.attempts + 1;
        const status = attempts >= 3 ? 'failed' : 'queued'; // Failed goes to "Emails to send by hand"
        await store.asServer((c) => c.query(
          `update public.outbox set status=$2, attempts=$3, error=$4, updated_at=now() where id=$1`, [line.id, status, attempts, e.message]));
        log.warn('email', line.id, 'attempt', attempts, e.message);
        return { ok: false, error: e.message };
      }
    },
  };
}

function need(env, k) { if (!env[k]) throw new Error(`${k} is not set`); return env[k]; }
async function safeText(r) { try { return (await r.text()).slice(0, 200); } catch { return ''; } }

module.exports = { makeProviders, makeMailer, verifyWebhook, postmarkEventToOutbox, graphNdrToOutbox };
