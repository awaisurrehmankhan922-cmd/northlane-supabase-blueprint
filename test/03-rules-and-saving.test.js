// Deposit caps (SQL and JS agree), the change trail, archive/restore, bank masking,
// the save batch (stale versions refused, nothing saved if one op is refused).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, people, as, asService, asAdmin, refused, seedOffice } = require('./helpers');
const caps = require('../shared/caps');

before(seedOffice);
after(() => pool.end());

// ---------------------------------------------------------------------------
test('deposit cap: the SQL function and shared/caps.js give the same pence for 200 rents', async () => {
  const cases = [];
  for (let i = 0; i < 200; i++) {
    const period = ['monthly', 'quarterly', 'yearly'][i % 3];
    const rentP = 30000 + i * 7919; // odd numbers so rounding matters
    cases.push({ rentP, period });
  }
  // one case either side of the £50,000 line
  cases.push({ rentP: 416666, period: 'monthly' }); // £4,166.66 × 12 = £49,999.92
  cases.push({ rentP: 416667, period: 'monthly' }); // £50,000.04

  const sql = await as(people.founder, (c) => c.query(
    `select app.deposit_cap_p(r, p)::text as dep, app.holding_cap_p(r, p)::text as hold
       from unnest($1::bigint[], $2::text[]) as t(r, p)`,
    [cases.map((x) => x.rentP), cases.map((x) => x.period)]));
  cases.forEach((k, i) => {
    assert.equal(Number(sql.rows[i].dep), caps.depositCapP(k.rentP, k.period), `deposit ${JSON.stringify(k)}`);
    assert.equal(Number(sql.rows[i].hold), caps.holdingCapP(k.rentP, k.period), `holding ${JSON.stringify(k)}`);
  });
  // and the cliff is where the law puts it
  assert.equal(caps.depositCapP(416666, 'monthly'), Math.floor((416666 * 12) / 52 * 5));
  assert.equal(caps.depositCapP(416667, 'monthly'), Math.floor((416667 * 12) / 52 * 6));
});

test('a tenancy with a deposit over the cap is refused by the database, whatever the screen did', async () => {
  const rent = 100000; // £1,000 a month → cap £1,153.84
  const cap = caps.depositCapP(rent, 'monthly');
  await as(people.b1_lets, (c) => c.query(
    `insert into public.records (coll,id,branch,data) values ('tenancies','t_ok','B1',$1)`,
    [JSON.stringify({ rent_p: rent, period: 'monthly', deposit_p: cap })]));
  await refused(as(people.b1_lets, (c) => c.query(
    `insert into public.records (coll,id,branch,data) values ('tenancies','t_bad','B1',$1)`,
    [JSON.stringify({ rent_p: rent, period: 'monthly', deposit_p: cap + 1 })])), /DEPOSIT_CAP/);
  await refused(as(people.b1_lets, (c) => c.query(
    `insert into public.records (coll,id,branch,data) values ('tenancies','t_hold','B1',$1)`,
    [JSON.stringify({ rent_p: rent, period: 'monthly', holding_p: caps.holdingCapP(rent, 'monthly') + 1 })])), /HOLDING_CAP/);
  await refused(as(people.b1_lets, (c) => c.query(
    `insert into public.records (coll,id,branch,data) values ('tenancies','t_wk','B1',$1)`,
    [JSON.stringify({ rent_p: 25000, period: 'weekly' })])), /NO_WEEKLY_RENT/);
});

// ---------------------------------------------------------------------------
test('every save is kept with who, before and after; the trail cannot be edited', async () => {
  await as(people.b1_lets, (c) => c.query(`insert into public.records (coll,id,branch,data) values ('contacts','c_trail','B1','{"name":"v1"}')`));
  await as(people.b1_lets, (c) => c.query(`update public.records set data = '{"name":"v2"}' where id = 'c_trail'`));
  const trail = await as(people.founder, (c) => c.query(
    `select who, before, after from public.changes where coll='contacts' and rec_id='c_trail' order by id`));
  assert.equal(trail.rowCount, 2);
  assert.equal(trail.rows[0].before, null);
  assert.equal(trail.rows[0].after.name, 'v1');
  assert.equal(trail.rows[1].before.name, 'v1');
  assert.equal(trail.rows[1].after.name, 'v2');
  assert.equal(trail.rows[1].who, people.b1_lets.id);
  const rev = await as(people.b1_lets, (c) => c.query(`select rev::int as rev from public.records where id = 'c_trail'`));
  assert.equal(rev.rows[0].rev, 2);
  // the trail is Founder-only reading
  const hidden = await as(people.b1_lets, (c) => c.query(`select count(*)::int as n from public.changes`));
  assert.equal(hidden.rows[0].n, 0);
});

// ---------------------------------------------------------------------------
test('a delete is an Archive entry; restore needs the switch; nothing is lost', async () => {
  await as(people.b1_lets, (c) => c.query(`insert into public.records (coll,id,branch,data) values ('tenancies','t_arch','B1','{"rent_p":90000,"period":"monthly"}')`));
  await as(people.b1_lets, (c) => c.query(`select app.archive('tenancies','t_arch')`));
  const gone = await as(people.b1_lets, (c) => c.query(`select 1 from public.records where id = 't_arch'`));
  assert.equal(gone.rowCount, 0);
  const kept = await as(people.b1_lets, (c) => c.query(`select data from public.archive where id = 't_arch'`));
  assert.equal(kept.rows[0].data.rent_p, 90000);

  await refused(as(people.b1_lets, (c) => c.query(`select app.restore('tenancies','t_arch')`)), /REFUSED/);
  await as(people.b1_acc, (c) => c.query(`select app.restore('tenancies','t_arch')`));
  const back = await as(people.b1_lets, (c) => c.query(`select data, rev::int as rev from public.records where id = 't_arch'`));
  assert.equal(back.rows[0].data.rent_p, 90000);

  // no Delete permission on contacts for b1_lets → cannot archive a contact
  await as(people.b1_lets, (c) => c.query(`insert into public.records (coll,id,branch,data) values ('contacts','c_keep','B1','{}')`));
  await refused(as(people.b1_lets, (c) => c.query(`select app.archive('contacts','c_keep')`)), /REFUSED/);
  // and B2 cannot archive B1's things
  await refused(as(people.b2_lets, (c) => c.query(`select app.archive('tenancies','t_arch')`)), /REFUSED/);
});

// ---------------------------------------------------------------------------
test('bank details are masked unless the role may see them, and each full view is logged', async () => {
  await asService((c) => c.query(`insert into public.bank_details (contact, branch, account_no, sort_code) values ('c_b1_1','B1','12345678','40-47-84') on conflict do nothing`));
  const masked = await as(people.b1_lets, (c) => c.query(`select * from app.view_bank('c_b1_1')`));
  assert.equal(masked.rows[0].account_no, '****5678');
  assert.equal(masked.rows[0].sort_code, '**-**-84');
  assert.equal(masked.rows[0].unmasked, false);

  const full = await as(people.b1_acc, (c) => c.query(`select * from app.view_bank('c_b1_1')`));
  assert.equal(full.rows[0].account_no, '12345678');
  const log = await as(people.b1_acc, (c) => c.query(`select who from public.security_log where event = 'bank.view' and detail->>'contact' = 'c_b1_1'`));
  assert.equal(log.rowCount, 1);
  assert.equal(log.rows[0].who, people.b1_acc.id);

  // B2 sees nothing at all, masked or not
  const other = await as(people.b2_lets, (c) => c.query(`select * from app.view_bank('c_b1_1')`));
  assert.equal(other.rowCount, 0);
  // changing bank details needs its own switch (the second-person approval lives in the API)
  await refused(as(people.b1_lets, (c) => c.query(`insert into public.bank_details (contact, branch, account_no, sort_code) values ('c_b1_2','B1','1','2')`)), /row-level security/);
});

// ---------------------------------------------------------------------------
test('save batch: one transaction; a stale version is refused; a refused op saves nothing', async () => {
  const first = await as(people.b1_lets, (c) => c.query(`select app.apply_ops($1) as out`, [JSON.stringify([
    { t: 'rec', coll: 'properties', id: 'p_1', data: { address: '1 High St' }, pos: 0, baseRev: 0 },
    { t: 'rec', coll: 'properties', id: 'p_2', data: { address: '2 High St' }, pos: 1, baseRev: 0 },
  ])]));
  assert.deepEqual(first.rows[0].out.map((x) => x.rev), [1, 1]);

  // two people edit p_1 from rev 1: the second is refused and the page reloads
  await as(people.b1_lets, (c) => c.query(`select app.apply_ops($1)`, [JSON.stringify([
    { t: 'rec', coll: 'properties', id: 'p_1', data: { address: '1 High Street' }, baseRev: 1 }])]));
  await refused(as(people.b1_lets, (c) => c.query(`select app.apply_ops($1)`, [JSON.stringify([
    { t: 'rec', coll: 'properties', id: 'p_1', data: { address: '1 Low St' }, baseRev: 1 }])])), /STALE/);

  // a batch with one bad op (deposit over cap) saves nothing, not even the good op
  await refused(as(people.b1_lets, (c) => c.query(`select app.apply_ops($1)`, [JSON.stringify([
    { t: 'rec', coll: 'properties', id: 'p_3', data: { address: '3 High St' }, baseRev: 0 },
    { t: 'rec', coll: 'tenancies', id: 't_batch', data: { rent_p: 100000, period: 'monthly', deposit_p: 999999 }, baseRev: 0 },
  ])])), /DEPOSIT_CAP/);
  const p3 = await as(people.b1_lets, (c) => c.query(`select 1 from public.records where id = 'p_3'`));
  assert.equal(p3.rowCount, 0, 'p_3 must not exist: the batch was refused whole');

  // order op
  await as(people.b1_lets, (c) => c.query(`select app.apply_ops($1)`, [JSON.stringify([
    { t: 'order', coll: 'properties', ids: ['p_2', 'p_1'] }])]));
  const order = await as(people.b1_lets, (c) => c.query(`select id from public.records where coll='properties' order by pos`));
  assert.deepEqual(order.rows.map((x) => x.id), ['p_2', 'p_1']);

  // a B2 person cannot save into B1 through the batch either
  await refused(as(people.b2_lets, (c) => c.query(`select app.apply_ops($1)`, [JSON.stringify([
    { t: 'rec', coll: 'properties', id: 'p_1', data: { address: 'hijack' }, baseRev: 2 }])])), /STALE|REFUSED|row-level/);
});

// ---------------------------------------------------------------------------
test('phone events arrive from the server, not a browser; staff may only add notes', async () => {
  const id = (await asService((c) => c.query(
    `insert into public.calls (branch, call_ref, type, from_no, ext) values ('B1','call-1','ringing','+447700900123','201') returning id`))).rows[0].id;
  await refused(as(people.b1_lets, (c) => c.query(`insert into public.calls (branch, call_ref, type, from_no, ext) values ('B1','x','ringing','1','201')`)), /row-level security/);
  await as(people.b1_lets, (c) => c.query(`update public.calls set notes = 'Asked about 1 High St', ended_at = now() where id = $1`, [id]));
  await refused(as(people.b1_lets, (c) => c.query(`update public.calls set from_no = '000' where id = $1`, [id])), /KEPT_FOR_GOOD/);
  const b2 = await as(people.b2_lets, (c) => c.query(`select 1 from public.calls where id = $1`, [id]));
  assert.equal(b2.rowCount, 0);
});

// ---------------------------------------------------------------------------
test('opening an ID document is logged every time; other files are not', async () => {
  await asService((c) => c.query(`insert into public.files (key,bucket,branch,sha256,size,mime,record_coll,record_id) values
    ('B1/contacts/c_b1_1/passport.pdf','id-copies','B1','cc',10,'application/pdf','contacts','c_b1_1'),
    ('B1/properties/p1/gas.pdf','documents','B1','dd',10,'application/pdf','properties','p1') on conflict do nothing`));
  await refused(as(people.b1_lets, (c) => c.query(`select * from app.open_file('B1/contacts/c_b1_1/passport.pdf')`)), /no such file/);
  await as(people.founder, (c) => c.query(`select * from app.open_file('B1/contacts/c_b1_1/passport.pdf')`));
  await as(people.founder, (c) => c.query(`select * from app.open_file('B1/contacts/c_b1_1/passport.pdf')`));
  await as(people.founder, (c) => c.query(`select * from app.open_file('B1/properties/p1/gas.pdf')`));
  const log = await as(people.founder, (c) => c.query(`select detail from public.security_log where event = 'file.id_view' and detail->>'key' = 'B1/contacts/c_b1_1/passport.pdf'`));
  assert.equal(log.rowCount, 2);
  const none = await as(people.founder, (c) => c.query(`select 1 from public.security_log where event = 'file.id_view' and detail->>'key' like '%gas.pdf'`));
  assert.equal(none.rowCount, 0);
});

// ---------------------------------------------------------------------------
test('erasure: the only lawful rewrite of the trail; needs the switch; refused under a legal hold', async () => {
  await as(people.b1_lets, (c) => c.query(`insert into public.records (coll,id,branch,data) values ('contacts','c_erase','B1','{"name":"Eve Private","phones":["+447700900000"]}')`));
  await as(people.b1_lets, (c) => c.query(`update public.records set data = '{"name":"Eve Private-Smith"}' where id = 'c_erase'`));
  // nobody can rewrite the trail directly, not even a superuser
  await refused(asAdmin((c) => c.query(`update public.changes set before = null where rec_id = 'c_erase'`)), /KEPT_FOR_GOOD/);
  // and setting the flag by hand does not help someone without the function's rights
  const sneaky = await as(people.b1_lets, async (c) => {
    await c.query(`select set_config('app.lawful_rewrite', 'erasure', true)`);
    return c.query(`update public.changes set before = null where rec_id = 'c_erase'`);
  });
  assert.equal(sneaky.rowCount, 0, 'no update policy on changes, flag or not');
  // the switch is needed
  await refused(as(people.b1_lets, (c) => c.query(`select app.erase_person('c_erase', 'asked by email 12/11')`)), /Handle rights requests/);
  const handler = { ...people.founder };
  const n = (await as(handler, (c) => c.query(`select app.erase_person('c_erase', 'asked by email 12/11') as n`))).rows[0].n;
  assert.ok(n >= 3, `rows touched: ${n}`);
  const rec = await as(people.founder, (c) => c.query(`select data from public.records where id = 'c_erase'`));
  assert.equal(rec.rows[0].data.erased, true);
  assert.equal(rec.rows[0].data.name, undefined);
  const trail = await as(people.founder, (c) => c.query(`select before, after from public.changes where rec_id = 'c_erase' order by id`));
  assert.ok(trail.rowCount >= 3, 'the trail is kept, including the erasure itself');
  assert.ok(trail.rows.every((r) => JSON.stringify(r).includes('Eve') === false), 'no name left anywhere in the trail');
  const rights = await as(people.founder, (c) => c.query(`select kind, contact from public.rights_requests where contact = 'c_erase'`));
  assert.equal(rights.rows[0].kind, 'erasure');
  // a legal hold stops it
  await asService((c) => c.query(`insert into public.records (coll,id,branch,data) values ('legal_holds','lh_1','B1','{"contact":"c_b1_2","why":"court case"}')`));
  await refused(as(people.founder, (c) => c.query(`select app.erase_person('c_b1_2', 'x')`)), /legal hold/);
});

// ---------------------------------------------------------------------------
test('every save is announced on nl_changes, so a second API process can relay it', async () => {
  const listener = await pool.connect();
  const got = [];
  try {
    listener.on('notification', (m) => got.push(JSON.parse(m.payload)));
    await listener.query('listen nl_changes');
    await as(people.b1_lets, (c) => c.query(`select app.apply_ops($1)`, [JSON.stringify([
      { t: 'rec', coll: 'tenancies', id: 'ten_live_1', data: { rent_p: 80000, period: 'monthly' }, baseRev: 0 }])]));
    await new Promise((r) => setTimeout(r, 200));
    await listener.query('unlisten nl_changes');
  } finally {
    listener.release();
  }
  const mine = got.find((g) => g.id === 'ten_live_1');
  assert.ok(mine, 'notification received');
  assert.equal(mine.branch, 'B1');
  assert.equal(mine.op, 'insert');
  assert.equal(mine.by, people.b1_lets.id);
  assert.equal(mine.rev, 1);
});
