// Money: insert-only, reversals, reference numbers, closed months, pence.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, people, as, asAdmin, refused, seedOffice } = require('./helpers');

before(seedOffice);
after(() => pool.end());

async function takeRent(p, amountP, extra = {}) {
  return as(p, async (c) => {
    const ref = (await c.query(`select app.next_ref('R') as ref`)).rows[0].ref;
    const r = await c.query(
      `insert into public.ledger (branch, ref, kind, account, amount_p, dated, tenancy, note)
       values ($1, $2, 'rent_in', 'client', $3, $4, 'ten_1', 'Rent') returning id, ref`,
      [p.branch, ref, amountP, extra.dated || new Date()]
    );
    return r.rows[0];
  });
}

test('taking rent needs the "takeRent" switch', async () => {
  const line = await takeRent(people.b1_lets, 95000);
  assert.match(line.ref, /^NL-R-\d{4}$/);
  await refused(takeRent(people.b1_basic, 95000), /REFUSED|row-level security/);
});

test('reading the books needs "See Accounts"; without it you see only the receipts you issued', async () => {
  const theirs = await takeRent(people.b1_acc, 60000);
  const mine = await as(people.b1_lets, (c) => c.query(`select ref, created_by from public.ledger`));
  assert.ok(mine.rowCount >= 1, 'sees own receipt');
  assert.ok(mine.rows.every((r) => r.created_by === people.b1_lets.id), 'only own lines');
  assert.ok(!mine.rows.some((r) => r.ref === theirs.ref), 'not the accounts person\'s line');
  const all = await as(people.b1_acc, (c) => c.query(`select count(*)::int as n from public.ledger`));
  assert.ok(all.rows[0].n > mine.rowCount);
});

test('a money line is never changed or deleted: not by staff, not by the table owner', async () => {
  const line = await takeRent(people.b1_acc, 120000);
  // staff: no policy, so zero rows touched
  const r = await as(people.b1_acc, (c) => c.query(`update public.ledger set amount_p = 1 where id = $1`, [line.id]));
  assert.equal(r.rowCount, 0);
  await refused(as(people.founder, (c) => c.query(`delete from public.ledger where id = $1`, [line.id])), /permission denied/);
  // even a superuser running raw SQL hits the trigger
  await refused(asAdmin((c) => c.query(`update public.ledger set amount_p = 1 where id = $1`, [line.id])), /KEPT_FOR_GOOD/);
  await refused(asAdmin((c) => c.query(`delete from public.ledger where id = $1`, [line.id])), /KEPT_FOR_GOOD/);
});

test('Reverse writes the mirror entry; the two sum to zero; it is logged', async () => {
  const line = await takeRent(people.b1_acc, 80000);
  const rvId = (await as(people.b1_acc, (c) => c.query(`select app.reverse_entry($1, 'Wrong tenant') as id`, [line.id]))).rows[0].id;
  const rows = await as(people.b1_acc, (c) => c.query(
    `select ref, amount_p::int as p, reverses from public.ledger where id in ($1,$2) order by id`, [line.id, rvId]));
  assert.equal(rows.rows[0].p + rows.rows[1].p, 0);
  assert.match(rows.rows[1].ref, /^NL-RV-\d{4}$/);
  assert.equal(Number(rows.rows[1].reverses), Number(line.id));
  const log = await as(people.b1_acc, (c) => c.query(`select detail from public.security_log where event = 'ledger.reverse' and detail->>'of' = $1`, [line.ref]));
  assert.equal(log.rowCount, 1);
});

test('Reverse is refused twice, refused on a reversal, refused without "See Accounts", refused without a reason', async () => {
  const line = await takeRent(people.b1_acc, 50000);
  await refused(as(people.b1_lets, (c) => c.query(`select app.reverse_entry($1, 'x')`, [line.id])), /See Accounts/);
  await refused(as(people.b1_acc, (c) => c.query(`select app.reverse_entry($1, '')`, [line.id])), /say why/);
  const rv = (await as(people.b1_acc, (c) => c.query(`select app.reverse_entry($1, 'dup test') as id`, [line.id]))).rows[0].id;
  await refused(as(people.b1_acc, (c) => c.query(`select app.reverse_entry($1, 'again')`, [line.id])), /already reversed/);
  await refused(as(people.b1_acc, (c) => c.query(`select app.reverse_entry($1, 'again')`, [rv])), /not itself reversed/);
});

test('Reverse across branches is refused unless shared role', async () => {
  const line = await takeRent(people.b2_lets, 70000);
  await refused(as(people.b1_acc, (c) => c.query(`select app.reverse_entry($1, 'x')`, [line.id])), /REFUSED/);
  await as(people.founder, (c) => c.query(`select app.reverse_entry($1, 'founder fixes B2')`, [line.id]));
});

test('reference numbers never repeat: 25 people taking a number at the same instant', async () => {
  const refs = await Promise.all(Array.from({ length: 25 }, () =>
    as(people.b1_acc, async (c) => (await c.query(`select app.next_ref('ST') as ref`)).rows[0].ref)));
  assert.equal(new Set(refs).size, 25);
  const nums = refs.map((r) => Number(r.split('-').pop())).sort((a, b) => a - b);
  assert.equal(nums[nums.length - 1] - nums[0], 24, 'consecutive, no gaps');
});

test('a later branch carries its code: NL-B2-R-0001', async () => {
  const ref = (await as(people.b2_lets, (c) => c.query(`select app.next_ref('J') as ref`))).rows[0].ref;
  assert.match(ref, /^NL-B2-J-\d{4}$/);
  await refused(as(people.b1_lets, (c) => c.query(`select app.next_ref('J', 'B2')`)), /REFUSED/);
});

test('a number stays used even if the record is gone (numbers_kept is append-only)', async () => {
  const ref = (await as(people.b1_acc, (c) => c.query(`select app.next_ref('R') as ref`))).rows[0].ref;
  await refused(asAdmin((c) => c.query(`delete from public.numbers_kept where ref = $1`, [ref])), /KEPT_FOR_GOOD/);
  await refused(asAdmin((c) => c.query(`insert into public.numbers_kept (ref, kind, branch) values ($1, 'R', 'B1')`, [ref])), /duplicate key/);
});

test('closed months: no new money dated into one, except by a Founder', async () => {
  await as(people.founder, (c) => c.query(`insert into public.closed_months (branch, month) values ('B1', '2026-09-01') on conflict do nothing`));
  await refused(takeRent(people.b1_acc, 1000, { dated: '2026-09-15' }), /MONTH_CLOSED/);
  await takeRent(people.founder, 1000, { dated: '2026-09-15' });
  await refused(as(people.b1_acc, (c) => c.query(`insert into public.closed_months (branch, month) values ('B1', '2026-08-01')`)), /row-level security/);
});

test('a money line must move some pence, and pence are whole', async () => {
  await refused(takeRent(people.b1_acc, 0), /MONEY_ZERO/);
  await refused(
    as(people.b1_lets, (c) => c.query(`insert into public.records (coll,id,branch,data) values ('payments','pay_frac','B1','{"amount_p": 1234.5}')`)),
    /PENCE_ONLY/
  );
});

test('two accounts: rent always lands in the client account; fees reach the business account only by a recorded move', async () => {
  await refused(as(people.b1_acc, async (c) => {
    const ref = (await c.query(`select app.next_ref('R') as ref`)).rows[0].ref;
    await c.query(`insert into public.ledger (branch, ref, kind, account, amount_p, tenancy) values ('B1', $1, 'rent_in', 'business', 95000, 'ten_2')`, [ref]);
  }), /CLIENT_MONEY: rent_in always goes to the client account/);
  await refused(as(people.b1_acc, async (c) => {
    const ref = (await c.query(`select app.next_ref('F') as ref`)).rows[0].ref;
    await c.query(`insert into public.ledger (branch, ref, kind, account, amount_p, tenancy) values ('B1', $1, 'fee', 'business', 9500, 'ten_2')`, [ref]);
  }), /only a recorded fee move/);
  await as(people.b1_acc, async (c) => {
    const ref = (await c.query(`select app.next_ref('F') as ref`)).rows[0].ref;
    await c.query(`insert into public.ledger (branch, ref, kind, account, amount_p, tenancy) values ('B1', $1, 'fee_move', 'business', 9500, 'ten_2')`, [ref]);
  });
});

test('the client account never pays out money that is not really there', async () => {
  const pay = (kind, amount, tenancy) => as(people.b1_acc, async (c) => {
    const ref = (await c.query(`select app.next_ref('P') as ref`)).rows[0].ref;
    await c.query(`insert into public.ledger (branch, ref, kind, account, amount_p, tenancy) values ('B1', $1, $2, 'client', $3, $4)`, [ref, kind, amount, tenancy]);
  });
  await pay('rent_in', 100000, 'ten_3');                       // £1,000 held
  await refused(pay('landlord_out', -100001, 'ten_3'), /only 100000p is held/);
  await pay('fee_move', -15000, 'ten_3');                       // our fee out: £150
  await pay('landlord_out', -85000, 'ten_3');                   // the rest to the landlord
  await refused(pay('landlord_out', -1, 'ten_3'), /only 0p is held/);
  // another tenancy's money cannot be used
  await pay('rent_in', 50000, 'ten_4');
  await refused(pay('landlord_out', -1, 'ten_3'), /only 0p is held/);
});
