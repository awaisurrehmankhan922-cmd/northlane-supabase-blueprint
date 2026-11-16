// test/helpers.js · run SQL "as" a signed-in person, the way PostgREST / the Node API do.
//
// Supabase sets two things per request: `set local role authenticated` and
// `request.jwt.claims`. auth.jwt() just reads that setting. We do exactly the same here
// against plain Postgres, so the policies under test are the real ones.

const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');

const DB_NAME = process.env.TEST_DB || 'northlane_test';
const pool = new Pool({ database: DB_NAME });

// ---------------------------------------------------------------------------
// The office. Two branches, the people the briefing describes.
// ---------------------------------------------------------------------------
const B1 = 'B1';
const B2 = 'B2';

function person(name, branch, roles, switches = [], areas = {}) {
  return { id: randomUUID(), name, branch, roles, switches, areas };
}

const ALL_AREAS = ['add', 'change', 'delete'];
const people = {
  founder: person('Founder', B1, ['founder', 'basic']),
  ceo:     person('CEO', B1, ['ceo', 'basic'], ['seeAccounts'], { contacts: ALL_AREAS }),
  b1_lets: person('B1 lettings', B1, ['lettings_manager', 'basic'], ['takeRent'],
                  { tenancies: ALL_AREAS, contacts: ['add', 'change'], appts: ALL_AREAS, properties: ['add', 'change'] }),
  b1_acc:  person('B1 accounts', B1, ['branch_manager', 'basic'], ['takeRent', 'seeAccounts', 'seeBank', 'restoreArchive', 'readSecurityLog'],
                  { tenancies: ALL_AREAS, contacts: ALL_AREAS, appts: ALL_AREAS }),
  b1_basic: person('B1 basic', B1, ['basic'], [], { contacts: ['add'] }),
  b2_lets: person('B2 lettings', B2, ['lettings_manager', 'basic'], ['takeRent'],
                  { tenancies: ALL_AREAS, contacts: ['add', 'change'], appts: ALL_AREAS }),
};

function claimsFor(p, aal = 'aal2') {
  return {
    sub: p.id,
    role: 'authenticated',
    aal,
    app_metadata: { branch: p.branch, roles: p.roles, switches: p.switches, areas: p.areas },
  };
}

// Run fn(client) inside one transaction as `p`. Commits unless fn throws; then rolls back
// and rethrows, so a test can assert on the refusal.
async function as(p, fn, { aal = 'aal2' } = {}) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claimsFor(p, aal))]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// The Node API acting as the server itself (phone events, outbox, team changes).
async function asService(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role service_role');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Plain superuser (migrations and seeding only).
async function asAdmin(fn) {
  const c = await pool.connect();
  try { return await fn(c); } finally { c.release(); }
}

// Expect a query to be refused. Returns the error message so tests can check the reason.
async function refused(promise, pattern) {
  try {
    await promise;
  } catch (e) {
    if (pattern && !pattern.test(e.message)) {
      throw new Error(`refused for the wrong reason: ${e.message}`);
    }
    return e.message;
  }
  throw new Error('expected a refusal, but it was allowed');
}

async function seedOffice() {
  await asAdmin(async (c) => {
    await c.query(`insert into public.branches (id, code, name) values ('B1', '', 'Bradford'), ('B2', 'B2', 'Leeds')
                   on conflict (id) do nothing`);
    for (const p of Object.values(people)) {
      await c.query(
        `insert into public.staff (user_id, branch, name, roles, switches, areas) values ($1,$2,$3,$4,$5,$6)
         on conflict (user_id) do nothing`,
        [p.id, p.branch, p.name, p.roles, p.switches, JSON.stringify(p.areas)]
      );
    }
  });
}

module.exports = { pool, people, B1, B2, as, asService, asAdmin, refused, seedOffice, claimsFor };
