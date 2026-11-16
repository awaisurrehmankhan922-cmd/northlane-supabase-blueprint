// backend/store-pg.js · the Postgres version of store.js
//
// The briefing says only store.js and files.js touch storage, and the plan is to keep
// their functions and what they return. This module shows the shape of that swap:
//
//   · one pool, one transaction per save batch (apply), exactly as today
//   · every statement runs AS THE SIGNED-IN PERSON: `set local role authenticated` plus
//     their JWT claims, so row-level security applies even if a route forgets a check
//   · server-only work (phone events, outbox, team changes) runs as service_role
//
// Nothing here is specific to Supabase: it is plain Postgres, which is why it also runs
// in CI against a throwaway database.

const { Pool } = require('pg');

class StorePg {
  constructor(connectionString = process.env.DATABASE_URL) {
    this.pool = new Pool({ connectionString, max: Number(process.env.PG_POOL_MAX || 10) });
  }

  // ---- running as someone -------------------------------------------------

  /** Run fn(client) in one transaction as the person whose JWT claims these are. */
  async asUser(claims, fn) {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role authenticated');
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw translate(e);
    } finally {
      c.release();
    }
  }

  /** The server acting as itself (bypasses RLS: use only from routes that have already decided). */
  async asServer(fn) {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role service_role');
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw translate(e);
    } finally {
      c.release();
    }
  }

  // ---- what GET /api/data needs -------------------------------------------

  /** Everything this person may see, shaped like DB in the browser: { coll: [records...], docs: {...} } */
  async dataFor(claims) {
    return this.asUser(claims, async (c) => {
      const recs = await c.query('select coll, id, data, pos, rev from public.records order by coll, pos, id');
      const docs = await c.query('select key, data, rev from public.docs');
      const appts = await c.query('select id, data, rev, staff, starts_at from public.appts order by starts_at');
      const out = { _rev: {} };
      for (const r of recs.rows) {
        (out[r.coll] ||= []).push({ ...r.data, id: r.id });
        out._rev[`${r.coll}/${r.id}`] = Number(r.rev);
      }
      out.appts = appts.rows.map((a) => ({ ...a.data, id: a.id, staff: a.staff, startsAt: a.starts_at }));
      for (const d of docs.rows) {
        out[d.key] = d.data;
        out._rev[d.key] = Number(d.rev);
      }
      return out;
    });
  }

  // ---- what POST /api/changes needs ---------------------------------------

  /**
   * Apply one save batch (the ops saveDB() sends) in one transaction.
   * Refused whole if any op is refused; returns the new revs.
   */
  async apply(claims, ops) {
    return this.asUser(claims, async (c) => {
      const r = await c.query('select app.apply_ops($1::jsonb) as out', [JSON.stringify(ops)]);
      return r.rows[0].out;
    });
  }

  // ---- money ---------------------------------------------------------------

  async nextRef(claims, kind) {
    return this.asUser(claims, async (c) => (await c.query('select app.next_ref($1) as ref', [kind])).rows[0].ref);
  }

  async reverse(claims, ledgerId, why) {
    return this.asUser(claims, async (c) => (await c.query('select app.reverse_entry($1, $2) as id', [ledgerId, why])).rows[0].id);
  }

  // ---- server-only ---------------------------------------------------------

  /** A phone event from the bridge. Matches the caller and writes the call line. */
  async phoneEvent(ev, branch) {
    return this.asServer(async (c) => {
      const match = await c.query(
        `select id from public.records
          where coll = 'contacts' and branch = $1
            and data->'phones' ? $2 limit 1`, [branch, ev.from]);
      const r = await c.query(
        `insert into public.calls (branch, call_ref, type, from_no, ext, contact)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [branch, ev.call, ev.type, ev.from, ev.ext, match.rows[0]?.id || null]);
      await c.query(`select pg_notify('phone', $1)`, [JSON.stringify({ ...ev, contact: match.rows[0]?.id || null, branch })]);
      return { id: r.rows[0].id, contact: match.rows[0]?.id || null };
    });
  }

  /** Queue an email. Staff never type an address: the caller resolves it from the contact. */
  async queueEmail(line) {
    return this.asServer(async (c) => {
      await c.query(
        `insert into public.outbox (id, branch, kind, to_name, to_email, subject, record_coll, record_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [line.id, line.branch, line.kind, line.toName, line.toEmail, line.subject, line.recordColl, line.recordId]);
    });
  }

  async close() { await this.pool.end(); }
}

// Turn Postgres refusals into the plain-English messages the screen already shows.
function translate(e) {
  const m = /^(STALE|REFUSED|KEPT_FOR_GOOD|MONTH_CLOSED|DEPOSIT_CAP|HOLDING_CAP|NO_WEEKLY_RENT|PENCE_ONLY|MONEY_ZERO|BAD_OP): (.*)$/.exec(e.message || '');
  if (m) { const err = new Error(m[2]); err.code = m[1]; err.status = m[1] === 'STALE' ? 409 : 403; return err; }
  if (/row-level security/.test(e.message)) { const err = new Error("You can't change that."); err.code = 'REFUSED'; err.status = 403; return err; }
  if (/permission denied/.test(e.message)) { const err = new Error("You can't do that."); err.code = 'REFUSED'; err.status = 403; return err; }
  return e;
}

module.exports = { StorePg, translate };
