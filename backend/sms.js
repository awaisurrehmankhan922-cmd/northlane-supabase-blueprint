// backend/sms.js · texts for Founder step-up codes and signing codes (briefing page 23)
//
// "Plugs into stepup.use(); behind one function." That function is send(to, text).
// Provider chosen by SMS_PROVIDER. Numbers are normalised to E.164 before sending so a
// code never goes to a mistyped number that happens to match another contact.

const fs = require('node:fs');
const path = require('node:path');

function toE164(uk) {
  const d = String(uk).replace(/[^\d+]/g, '');
  // UK mobiles only (07xxx): a code must never go to the office landline or a mistyped number
  if (/^\+447\d{9}$/.test(d)) return d;
  if (/^07\d{9}$/.test(d)) return '+44' + d.slice(1);
  if (/^447\d{9}$/.test(d)) return '+' + d;
  throw new Error('Not a UK mobile number');
}

function makeSms({ fetch = globalThis.fetch, env = process.env } = {}) {
  const providers = {
    test: async (to, text) => {
      const dir = env.SMS_TEST_DIR || 'data/sms-test';
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'sent.jsonl'), JSON.stringify({ at: new Date().toISOString(), to, text }) + '\n');
      return { ref: `test-${Date.now()}` };
    },
    off: async () => { throw new Error('Texts are not set up yet'); },

    // Twilio shown; any HTTP SMS API is a few lines.
    twilio: async (to, text) => {
      const sid = need(env, 'TWILIO_SID'), tok = need(env, 'TWILIO_TOKEN'), from = need(env, 'TWILIO_FROM');
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: from, Body: text }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Text not sent: ${j.message || r.status}`);
      return { ref: j.sid };
    },
  };

  const provider = providers[env.SMS_PROVIDER || 'off'] || providers.off;

  return {
    /** The one function. Never logs the text itself (it holds a code). */
    async send(to, text) {
      const e164 = toE164(to);
      if (text.length > 160) throw new Error('A code text is one message');
      return provider(e164, text);
    },
    toE164,
  };
}

function need(env, k) { if (!env[k]) throw new Error(`${k} is not set`); return env[k]; }

module.exports = { makeSms, toE164 };
