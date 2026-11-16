// Who sees what. The same cases matrix.test.js runs against the Node API today,
// pointed at the database directly: if the API had a bug, these would still hold.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, people, as, asService, refused, seedOffice } = require('./helpers');

const TABLES = ['records', 'docs', 'appts', 'archive', 'changes', 'ledger', 'closed_months', 'counters',
  'numbers_kept', 'bank_details', 'files', 'outbox', 'calls', 'security_log', 'breaches', 'rights_requests', 'staff'];

before(async () => {
  await seedOffice();
  await asService(async (c) => {
    await c.query(`insert into public.records (coll, id, branch, data) values
      ('contacts', 'c_b1_1', 'B1', '{"name":"Alice Landlord"}'),
      ('contacts', 'c_b1_2', 'B1', '{"name":"Bob Tenant"}'),
      ('contacts', 'c_b2_1', 'B2', '{"name":"Carol Vendor"}'),
      ('help', 'help_1', 'B1', '{"q":"How do I take a key out?","a":"Keys > Sign out"}')
      on conflict do nothing`);
    await c.query(`insert into public.appts (id, branch, staff, starts_at, data) values
      ('ap_b2_shared', 'B2', $1, now(), '{"what":"Viewing at Leeds, B1 lettings attending"}'),
      ('ap_b2_private', 'B2', '{}', now(), '{"what":"Leeds internal"}')
      on conflict do nothing`, [[people.b1_lets.id]]);
  });
});

after(() => pool.end());

// ---------------------------------------------------------------------------
test('aal1 (password but no authenticator code) reaches nothing, on every table', async () => {
  for (const t of TABLES) {
    const rows = await as(people.founder, (c) => c.query(`select count(*)::int as n from public.${t}`), { aal: 'aal1' });
    assert.equal(rows.rows[0].n, 0, `${t} should be empty at aal1`);
  }
  // and cannot write either
  await refused(
    as(people.founder, (c) => c.query(`insert into public.records (coll,id,branch,data) values ('contacts','x','B1','{}')`), { aal: 'aal1' }),
    /row-level security/
  );
});

test('a B1 lettings manager sees only B1 records (plus shared lists)', async () => {
  const r = await as(people.b1_lets, (c) => c.query(`select id, branch from public.records order by id`));
  const ids = r.rows.map((x) => x.id);
  assert.deepEqual(ids, ['c_b1_1', 'c_b1_2', 'help_1']);
  assert.ok(!ids.includes('c_b2_1'), 'must never see a B2 contact');
});

test('a B2 lettings manager sees only B2 records', async () => {
  const r = await as(people.b2_lets, (c) => c.query(`select id from public.records where coll = 'contacts'`));
  assert.deepEqual(r.rows.map((x) => x.id), ['c_b2_1']);
});

test('Founder and CEO see every branch', async () => {
  for (const p of [people.founder, people.ceo]) {
    const r = await as(p, (c) => c.query(`select count(*)::int as n from public.records where coll = 'contacts'`));
    assert.equal(r.rows[0].n, 3, `${p.name} should see all 3 contacts`);
  }
});

test('writing into another branch is refused, even with a hand-made request', async () => {
  await refused(
    as(people.b1_lets, (c) => c.query(`insert into public.records (coll,id,branch,data) values ('contacts','evil','B2','{"name":"x"}')`)),
    /row-level security/
  );
  // update of a B2 row silently touches nothing
  const r = await as(people.b1_lets, (c) => c.query(`update public.records set data = '{"name":"hacked"}' where id = 'c_b2_1'`));
  assert.equal(r.rowCount, 0);
  const check = await as(people.b2_lets, (c) => c.query(`select data->>'name' as name from public.records where id = 'c_b2_1'`));
  assert.equal(check.rows[0].name, 'Carol Vendor');
});

test('Add / Change / Delete per area: a basic member may add a contact but not change one', async () => {
  await as(people.b1_basic, (c) => c.query(`insert into public.records (coll,id,branch,data) values ('contacts','c_b1_3','B1','{"name":"Dan"}')`));
  const r = await as(people.b1_basic, (c) => c.query(`update public.records set data = '{"name":"Dan Changed"}' where id = 'c_b1_3'`));
  assert.equal(r.rowCount, 0, 'no Change permission on contacts');
  await refused(
    as(people.b1_basic, (c) => c.query(`insert into public.records (coll,id,branch,data) values ('tenancies','t_x','B1','{}')`)),
    /row-level security/
  );
});

test('nobody can DELETE a record; the grant does not exist', async () => {
  await refused(
    as(people.founder, (c) => c.query(`delete from public.records where id = 'c_b1_1'`)),
    /permission denied/
  );
});

test('a person named on an appointment reads it whichever branch holds it (named.js)', async () => {
  const r = await as(people.b1_lets, (c) => c.query(`select id from public.appts order by id`));
  assert.deepEqual(r.rows.map((x) => x.id), ['ap_b2_shared']);
  const r2 = await as(people.b1_acc, (c) => c.query(`select id from public.appts`));
  assert.equal(r2.rowCount, 0, 'another B1 person not named sees no B2 appointment');
});

test('security log and activity trail need their switch', async () => {
  const none = await as(people.b1_lets, (c) => c.query(`select count(*)::int as n from public.security_log`));
  assert.equal(none.rows[0].n, 0);
  await as(people.b1_acc, (c) => c.query(`select app.log_security('test.event', '{"x":1}')`));
  const some = await as(people.b1_acc, (c) => c.query(`select count(*)::int as n from public.security_log where event = 'test.event'`));
  assert.ok(some.rows[0].n >= 1);
});

test('ID copies need "View ID documents"; other files only need the branch', async () => {
  await asService((c) => c.query(`insert into public.files (key,bucket,branch,sha256,size,mime) values
    ('B1/contacts/c_b1_1/id.pdf','id-copies','B1','aa',10,'application/pdf'),
    ('B1/properties/p1/epc.pdf','documents','B1','bb',10,'application/pdf') on conflict do nothing`));
  const r = await as(people.b1_lets, (c) => c.query(`select bucket from public.files order by bucket`));
  assert.deepEqual(r.rows.map((x) => x.bucket), ['documents']);
  const f = await as(people.founder, (c) => c.query(`select bucket from public.files order by bucket`));
  assert.deepEqual(f.rows.map((x) => x.bucket), ['documents', 'id-copies']);
});
