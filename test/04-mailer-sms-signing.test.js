// Email providers, bounce mapping, SMS normalisation, and the public signing route.
// No network: fetch is injected.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { makeProviders, makeMailer, verifyWebhook, postmarkEventToOutbox, graphNdrToOutbox } = require('../backend/mailer');
const { makeSms, toE164 } = require('../backend/sms');
const { makePublicSigning, newCode, hashCode, MAX_TRIES } = require('../backend/signing-public');

const msg = () => ({
  id: 'ob_1', from: { name: 'North Lane', email: 'office@example.test' },
  to: [{ name: 'Alice', email: 'alice@example.test' }],
  subject: 'Rent receipt NL-R-0432', text: 'Thank you.',
  attachments: [{ name: 'NL-R-0432.pdf', type: 'application/pdf', read: async () => Buffer.from('%PDF-1.4') }],
});

function fakeFetch(script) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const step = script.shift();
    return { status: step.status, ok: step.status < 300, json: async () => step.json || {}, text: async () => step.text || '' };
  };
  f.calls = calls;
  return f;
}

test('Microsoft 365 provider: gets a token, posts sendMail as the office mailbox, tags the message with the outbox id', async () => {
  const fetch = fakeFetch([{ status: 200, json: { access_token: 'tok' } }, { status: 202 }]);
  const env = { GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', GRAPH_MAILBOX: 'office@northlane.test' };
  const { ref } = await makeProviders({ fetch, env }).graph.send(msg());
  assert.equal(ref, 'graph:ob_1');
  assert.match(fetch.calls[1].url, /users\/office%40northlane\.test\/sendMail$/);
  const body = JSON.parse(fetch.calls[1].init.body);
  assert.equal(body.message.from.emailAddress.address, 'office@northlane.test');
  assert.deepEqual(body.message.internetMessageHeaders, [{ name: 'X-NL-Outbox', value: 'ob_1' }]);
  assert.equal(body.message.attachments[0].contentBytes, Buffer.from('%PDF-1.4').toString('base64'));
});

test('a refusal from the provider becomes a plain message for staff, and after 3 tries the line is Failed', async () => {
  const fetch = fakeFetch([{ status: 200, json: { access_token: 'tok' } }, { status: 403, text: 'Forbidden' }]);
  const env = { GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', GRAPH_MAILBOX: 'o@x' };
  const updates = [];
  const store = { asServer: async (fn) => fn({ query: async (sql, params) => updates.push({ sql, params }) }) };
  const mailer = makeMailer({ provider: makeProviders({ fetch, env }).graph, store, log: { warn() {} } });
  const r = await mailer.sendOne({ id: 'ob_1', attempts: 2 }, msg());
  assert.equal(r.ok, false);
  assert.match(r.error, /Microsoft 365 refused the email \(403\)/);
  assert.match(updates[0].sql, /status=\$2/);
  assert.equal(updates[0].params[1], 'failed');
});

test('Postmark provider and its bounce webhook update the right outbox line', async () => {
  const fetch = fakeFetch([{ status: 200, json: { MessageID: 'pm-123', ErrorCode: 0 } }]);
  const { ref } = await makeProviders({ fetch, env: { POSTMARK_TOKEN: 'x', POSTMARK_FROM: 'office@northlane.test' } }).postmark.send(msg());
  assert.equal(ref, 'pm-123');
  assert.deepEqual(postmarkEventToOutbox({ RecordType: 'Bounce', Type: 'HardBounce', Description: 'bad address', Metadata: { outbox: 'ob_1' } }),
    { outboxId: 'ob_1', status: 'bounced', error: 'HardBounce: bad address' });
  assert.deepEqual(postmarkEventToOutbox({ RecordType: 'Delivery', Tag: 'ob_1' }), { outboxId: 'ob_1', status: 'delivered' });
  assert.equal(postmarkEventToOutbox({ RecordType: 'Open' }), null);
});

test('webhook key check is constant-time and refuses a missing secret', () => {
  assert.equal(verifyWebhook({ 'x-nl-webhook-key': 'abc' }, 'abc'), true);
  assert.equal(verifyWebhook({ 'x-nl-webhook-key': 'abd' }, 'abc'), false);
  assert.equal(verifyWebhook({}, 'abc'), false);
  assert.equal(verifyWebhook({ 'x-nl-webhook-key': '' }, ''), false, 'an unset secret never verifies');
});

test('Microsoft 365 non-delivery reports are matched to the outbox by our header', () => {
  assert.deepEqual(graphNdrToOutbox({ subject: 'Undeliverable: Rent receipt', internetMessageHeaders: [{ name: 'X-NL-Outbox', value: 'ob_9' }] }),
    { outboxId: 'ob_9', status: 'bounced', error: 'Undeliverable: Rent receipt' });
  assert.deepEqual(graphNdrToOutbox({ subject: 'Undeliverable', body: { content: '...\nX-NL-Outbox: ob_7\n...' } }),
    { outboxId: 'ob_7', status: 'bounced', error: 'Undeliverable' });
  assert.equal(graphNdrToOutbox({ subject: 'Hello' }), null);
});

test('test provider writes the email to disk and nothing leaves', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
  await makeProviders({ env: { OUTBOX_TEST_DIR: dir } }).test.send(msg());
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'ob_1.json'), 'utf8'));
  assert.equal(j.to[0].email, 'alice@example.test');
  assert.deepEqual(j.attachments, ['NL-R-0432.pdf']);
});

// ---------------------------------------------------------------------------
test('SMS: UK numbers normalise to E.164; anything else is refused; codes are one message', async () => {
  assert.equal(toE164('07700 900123'), '+447700900123');
  assert.equal(toE164('+44 7700 900123'), '+447700900123');
  assert.equal(toE164('447700900123'), '+447700900123');
  assert.throws(() => toE164('0113 496 0000 1'), /Not a UK mobile/);
  assert.throws(() => toE164('0113 496 0000'), /Not a UK mobile/, 'a landline is not a mobile');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-'));
  const sms = makeSms({ env: { SMS_PROVIDER: 'test', SMS_TEST_DIR: dir } });
  await sms.send('07700900123', 'Your North Lane signing code is ABC234');
  const line = JSON.parse(fs.readFileSync(path.join(dir, 'sent.jsonl'), 'utf8').trim());
  assert.equal(line.to, '+447700900123');
  await assert.rejects(sms.send('07700900123', 'x'.repeat(161)), /one message/);
  await assert.rejects(makeSms({ env: {} }).send('07700900123', 'hi'), /not set up/);
});

// ---------------------------------------------------------------------------
function fakeSignings() {
  const codeA = newCode(), codeB = newCode();
  const saltA = 'saltA', saltB = 'saltB';
  const signing = {
    id: 'sg_1', title: 'Tenancy agreement, 1 High St', status: 'open',
    officeNote: 'Chase if not signed by Friday',
    signers: [
      { id: 's_a', name: 'Alice', role: 'Tenant', codeHash: hashCode(codeA, saltA), codeSalt: saltA, tries: 0, lockedAt: null, signedAt: null, turn: true },
      { id: 's_b', name: 'Bob', role: 'Guarantor', codeHash: hashCode(codeB, saltB), codeSalt: saltB, tries: 0, lockedAt: null, signedAt: null, turn: false },
    ],
    pages: [{ n: 1, signedUrl: 'https://x/1.png' }, { n: 2, signedUrl: 'https://x/2.png' }, { n: 3, signedUrl: 'https://x/3.png' }],
    boxes: [
      { id: 'b1', signerId: 's_a', page: 1, kind: 'signature', x: 1, y: 1, w: 1, h: 1, required: true },
      { id: 'b2', signerId: 's_a', page: 3, kind: 'date', x: 1, y: 1, w: 1, h: 1, required: false },
      { id: 'b3', signerId: 's_b', page: 2, kind: 'signature', x: 1, y: 1, w: 1, h: 1, required: true },
    ],
  };
  const saved = [];
  const store = {
    async bySigningId(id) { return id === 'sg_1' ? signing : null; },
    async bumpTries(id) { signing.signers.find((s) => s.id === id).tries++; },
    async lock(id) { signing.signers.find((s) => s.id === id).lockedAt = new Date(); },
    async saveBoxes(id, boxes, stamp) { saved.push({ id, boxes, stamp }); signing.signers.find((s) => s.id === id).signedAt = new Date(); },
    async allSigned() { return signing.signers.every((s) => s.signedAt); },
  };
  return { store, signing, codeA, codeB, saved };
}

test('public signing: the signer sees only their own pages and boxes, never the office note', async () => {
  const { store, codeA } = fakeSignings();
  const api = makePublicSigning({ signings: store });
  const r = await api.view('sg_1', codeA, '1.2.3.4');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.pages.map((p) => p.n), [1, 3], 'page 2 belongs to Bob');
  assert.deepEqual(r.body.boxes.map((b) => b.id), ['b1', 'b2']);
  assert.equal(JSON.stringify(r.body).includes('Chase if not signed'), false);
  assert.equal(JSON.stringify(r.body).includes('Bob'), false);
});

test('public signing: not your turn yet, wrong code, lock after 5 wrong tries, staff reissue', async () => {
  const { store, signing, codeB } = fakeSignings();
  const api = makePublicSigning({ signings: store });
  assert.equal((await api.view('sg_1', codeB, '1.1.1.1')).status, 425);
  for (let i = 0; i < MAX_TRIES; i++) assert.equal((await api.view('sg_1', 'ZZZZZZ', '1.1.1.1')).status, 403);
  assert.ok(signing.signers.every((s) => s.lockedAt), 'both open signers locked after 5 wrong tries');
  signing.signers[1].turn = true;
  assert.equal((await api.view('sg_1', codeB, '1.1.1.1')).status, 423);
  // staff issue a fresh code
  const fresh = newCode();
  Object.assign(signing.signers[1], { codeHash: hashCode(fresh, 'saltB'), tries: 0, lockedAt: null });
  assert.equal((await api.view('sg_1', fresh, '1.1.1.1')).status, 200);
});

test('public signing: saves only this signer\'s boxes, refuses another\'s, requires the required ones, stamps time and address', async () => {
  const { store, codeA, saved } = fakeSignings();
  const api = makePublicSigning({ signings: store, now: () => new Date('2026-11-16T14:00:00Z') });
  const png = 'data:image/png;base64,' + 'A'.repeat(400);
  assert.equal((await api.submit('sg_1', codeA, [{ id: 'b3', value: png }], '9.9.9.9')).status, 403);
  assert.equal((await api.submit('sg_1', codeA, [{ id: 'b2', value: '16/11/2026' }], '9.9.9.9')).status, 400, 'signature missing');
  const ok = await api.submit('sg_1', codeA, [{ id: 'b1', value: png }, { id: 'b2', value: '16/11/2026' }], '9.9.9.9', 'Safari');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { signed: true, everyoneSigned: false });
  assert.equal(saved[0].id, 's_a');
  assert.deepEqual(saved[0].stamp, { at: '2026-11-16T14:00:00.000Z', ip: '9.9.9.9', userAgent: 'Safari' });
  assert.equal((await api.submit('sg_1', codeA, [], '9.9.9.9')).status, 409, 'already signed');
});

test('public signing: 20 tries a minute from one address, then 429', async () => {
  const { store, codeA } = fakeSignings();
  const api = makePublicSigning({ signings: store });
  // right code, wrong signing id: counts against the address but locks nobody
  let last;
  for (let i = 0; i < 21; i++) last = await api.view('nope', codeA, '5.5.5.5');
  assert.equal(last.status, 429);
  assert.equal((await api.view('sg_1', codeA, '6.6.6.6')).status, 200, 'another address is fine');
});
