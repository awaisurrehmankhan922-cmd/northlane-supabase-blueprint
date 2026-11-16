# North Lane CRM · Supabase blueprint

A working sketch of the move described in the developer briefing (15/11/2026), pages 18–22: what the Postgres side looks like, how row-level security does the separating, how the money rules stay true in the database, and the four outside links (email, desk phones, texts, public signing) plus the desktop app shell.

**None of the CRM's code or data is here.** This was written from the briefing alone, before any access, so the office can see how I think before deciding whether to let me in. Every policy and rule has a test; the suite runs on plain Postgres 16 in CI with no Supabase account needed.

```
npm install
npm test          # creates a throwaway database, applies the migrations, runs 56 tests (about 3 seconds)
```

Needs Node 22.23.4+ and a local Postgres reachable through the usual `PG*` variables.

## What is here

| Folder | What | Tests |
|---|---|---|
| `supabase/migrations/0001_schema.sql` | The tables: `records`, `docs`, `appts`, `archive`, `changes`, `ledger` (pence, insert-only), `closed_months`, `counters`, `numbers_kept`, `bank_details`, `files`, `outbox`, `calls`, `security_log`, `breaches`, `rights_requests`. | |
| `supabase/migrations/0002_app_functions.sql` | Who is this: `app.my_branch()`, `app.is_founder()`, `app.can('takeRent')`, `app.may('tenancies','change')`, `app.aal2()` … all read from the JWT, never from an editable row. | |
| `supabase/migrations/0003_policies.sql` | Row-level security: `needs_aal2` restrictive on every table; branch read/write; named staff on appointments; switches on money and logs; no DELETE anywhere. | `test/01` · 10 |
| `supabase/migrations/0004_rules.sql` | The rules that must hold even if the API has a bug: append-only triggers, `app.reverse_entry`, `app.next_ref` (unique under concurrency, branch codes), closed months, two accounts (rent to the client account; only money really held is paid out; fees move by a recorded move), deposit and holding caps, pence-only, the change trail, bank masking with logged views, ID-document opens logged, `app.archive`/`app.restore`, `app.erase_person` (the one lawful rewrite of the trail; refused under a legal hold), `app.apply_ops` (one transaction per save batch, stale versions refused), `pg_notify` on every save for a second API process. | `test/02` · 13, `test/03` · 10 |
| `supabase/storage/policies.sql` | Four private buckets and their policies (Supabase only). | |
| `shared/caps.js` | The deposit, holding, pro-rata and repair-cut formulas as one plain file both sides load. The suite proves SQL and JS agree on 202 rents, including either side of £50,000. | in `test/03` |
| `backend/store-pg.js` | The `store.js` swap: one transaction per batch, run **as the signed-in person** so RLS applies through the API. Phone events and the outbox run as the server. | |
| `backend/mailer.js` | `graph` (Microsoft 365) and `postmark` providers matching the existing `send(msg)` contract; bounce handling for both; retries then Failed. | `test/04` · 6 |
| `backend/sms.js` | Texts behind one function for Founder step-up and signing codes; UK numbers normalised. | `test/04` · 1 |
| `backend/signing-public.js` | The public signing route: 6-character code, 5 wrong tries lock, only the signer's pages and boxes, server stamps time and address, rate-limited. | `test/04` · 4 |
| `phone-bridge/` | The link to TINKLE/Asterisk: AMI, webhook or Yealink Action URL modes → the CRM's `POST /api/phone/event`. Click-to-dial via `Originate`. End-to-end test against a fake Asterisk. | `test/05` · 8 |
| `pwa/` | Manifest and a service worker that caches the shell only, never data; a test fails the build if that changes. | `test/06` · 4 |
| `docs/DECISIONS.md` | Answers to the eight interview questions, as implemented. | |
| `docs/PLAN.md` | Phases, what "done" means for each, what I need from the office. | |
| `.github/workflows/ci.yml` | Postgres 16 service, `npm run verify` on every push. | |

## The three ideas

**1. Both locks.** The Node API stays the only way in, and it runs every statement as the signed-in person (`set local role authenticated` + their JWT claims). The server checks the rule, and the database checks it again. A forgotten filter in a route returns nothing it should not.

**2. Who you are comes from the token.** Branch, roles, switches and areas sit in `app_metadata`, written by the API when a Founder changes them. No policy ever reads a `profiles` row the user could edit.

**3. Nothing is lost, in the database too.** No DELETE grant. Money, logs and the change trail have triggers that refuse UPDATE and DELETE for everyone, owner included. A delete is `app.archive()`; a money mistake is `app.reverse_entry()`; the one lawful rewrite is `app.erase_person()`, which redacts and never deletes.

## What this is not

Not the migration itself: that starts with `store.js` on Postgres and the CRM's 1,500 tests green, which needs the code. Not a Supabase project: the SQL here is what `supabase db push` would apply. Not final table shapes: `records` as `jsonb` mirrors today's design on purpose, so the move is a swap and not a rewrite; columns can be lifted out later where indexes need them.

## Running the bridge or the mailer for real

See `phone-bridge/README.md` and `.env.example`. Secrets live in the environment only, never in Settings or the repository.
