# Decisions, and the reasons

Answers to the eight questions on page 24 of the briefing, as this blueprint implements them.

## 1. Keep the Node API in front of Supabase, or let the browser talk to Postgres?

**Keep the Node API, and make it act as the person.** Both locks, not one.

The CRM has roughly 48,000 lines of tested server rules. Rewriting every one as SQL before anything ships is months of risk for no business gain, and some rules (merging two people's edits field by field, building a signed PDF, posting to the phone system) do not belong in a database anyway. But the server must not be the only thing standing between a bug and a tenant's bank details. So:

- The browser signs in with Supabase Auth (email + password + TOTP). It gets a JWT.
- The browser talks only to the Node API, as today.
- The API opens its transaction with `set local role authenticated` and that person's JWT claims (`backend/store-pg.js`). Postgres then applies row-level security to every statement. A route that forgot to filter by branch would still return only that branch's rows.
- Server-only work (phone events, the outbox, team changes) runs as `service_role`, from routes that have already decided.

Rules move into the database **one at a time, where a bug would be worst**: branch separation, the second step (aal2), money insert-only with reversals, reference numbers, closed months, deposit caps, the change trail, bank masking. Those are in `supabase/migrations/0003` and `0004`, with tests.

**What first, and how to prove nothing broke:** code onto a private repository with CI; then `store.js` on Postgres with the existing 1,500-case server suite green before touching Auth, Storage or RLS. The suite is the proof. The RLS layer has its own suite (`test/01`–`03`) that runs on plain Postgres in CI, so a policy change cannot merge without the access matrix passing.

## 2. RLS for fully separate branches, with Founder, CEO and Director shared

Every row carries `branch`. The person's branch and roles are in their JWT `app_metadata`, written by the API when a Founder changes them; the person cannot edit it. Two policies on every table:

```sql
needs_aal2   RESTRICTIVE  using (app.aal2())                 -- nothing without the second step
branch_read  PERMISSIVE   using (app.sees_branch(branch))    -- own branch, or every branch for founder/ceo/director
```

plus the table's own rule (named staff on appointments, switches on money, Add/Change/Delete per area). There is no DELETE policy and no DELETE grant anywhere: a delete is `app.archive()`. Shared lists are company-wide reference data only (Help & FAQ, agreement wording, company documents); templates, Settings and choice lists stay per branch, as page 16 says a new branch starts fresh.

"Rewritten only by the law" (page 15): the change trail's trigger allows an UPDATE only inside `app.erase_person()`, which redacts the person's record, trail and files, records the rights request and logs it; it is refused without "Handle rights requests" or under a legal hold. Nothing else can rewrite the trail, and nothing can delete it.

**Tested** (`test/01-access-matrix.test.js`): a B1 lettings manager lists records and sees only B1 plus shared lists; inserting into B2 is refused; updating a B2 row touches zero rows; Founder and CEO see all; a B1 person named on a B2 viewing sees that one appointment and no other; at aal1 every table is empty and every write is refused.

## 3. Money insert-only with reversals, in Postgres

Three layers (`0004_rules.sql`):

1. **Policy:** `ledger` has INSERT (with `takeRent`, own branch, `reverses is null`) and SELECT (`seeAccounts`, or your own receipts). No UPDATE or DELETE policy.
2. **Grant:** `authenticated` has no DELETE on any table.
3. **Trigger:** `kept_for_good` raises on UPDATE or DELETE of `ledger`, `changes`, `security_log`, `breaches`, `rights_requests`, `numbers_kept`, for *everyone including the table owner*.

Two accounts (`client_money_rules` trigger): `rent_in`, `deposit_in` and `holding_in` are refused on the business account; a business-account line must be a recorded move (`fee_move`, `repair_cut`, `sale_fee`, `referral_fee`); a payment out of the client account for a tenancy or property is refused if more than what is held for it (`CLIENT_MONEY: only 100000p is held for this tenancy`).

Reverse is `app.reverse_entry(id, why)`: a `security definer` function that checks `seeAccounts` and the branch, refuses a second reversal and the reversal of a reversal, takes an `NL-RV-` number, writes the mirror line with `reverses = id` in the same transaction, and logs it. Amounts are `bigint` pence; a `_p` field with a fraction anywhere in a record is refused. Closed months are a table; a trigger refuses new lines dated into one unless the person is a Founder.

**Tested** (`test/02-money.test.js`): a superuser's raw `UPDATE` hits the trigger; 25 simultaneous `next_ref('ST')` calls give 25 consecutive unique numbers; `NL-B2-J-0001` for the second branch; a reversal sums to zero with the original.

## 4. Email through Microsoft 365, and bounces

`backend/mailer.js` adds a `graph` provider to the existing `providers` table, matching the `send(msg)` contract exactly. Azure app registration with the **application** permission `Mail.Send`, locked to the one office mailbox by an Exchange `ApplicationAccessPolicy`, so the secret can send as nobody else. Token by client credentials; `POST /users/{mailbox}/sendMail` with attachments as base64; `saveToSentItems: true` so the office sees everything in Outlook too. Each message carries an `X-NL-Outbox` header with the outbox line id.

**Bounces:** Graph has no bounce webhook. Two honest options, the office chooses:

- *Stay on Microsoft 365.* An hourly job reads non-delivery reports from the mailbox through Graph and matches them to outbox lines by the `X-NL-Outbox` header (`graphNdrToOutbox`). Works; a few minutes' delay; depends on Exchange's NDR format.
- *Transactional service (Postmark shown).* Real delivery and bounce webhooks within seconds (`postmarkEventToOutbox`), verified by a shared key before anything is read. Costs a few pounds a month; mail does not appear in Sent Items.

Either way: SPF, DKIM and DMARC on the domain before the first real send, or the receipts land in spam.

## 5. The phone link: AMI only? Webhooks only? Nothing?

See `phone-bridge/README.md`. One program, three modes, same output. AMI over the office network or a VPN, never the internet; webhooks verified by key or HMAC plus IP allow-list plus a replay window; Yealink Action URLs as the fallback. Click-to-dial through AMI `Originate`. The bridge never sees contact data; matching happens on the CRM server under the negotiator's own permissions. Tested end to end against a fake Asterisk.

The first task is a 30-minute call with Commerce Business Systems to learn which mode applies.

## 6. A plain-JavaScript code base of this size

**Keep:** the shape (thick browser, strict server), the shared rule files that both sides load, the no-framework no-build front end, the test suite, the `ROUTES` table, the one-transaction-per-save design, Prettier. Rewriting to React or TypeScript would be a year of churn with nothing the office could see.

**Change (in order):** code onto a repository with CI (there is none today); `store.js` and `files.js` internals (the two files meant to change); roles and branch into JWT claims; the money rules above into the database; paging for the big lists when the office grows past about 30,000 records; browser-side tidy-ups into server jobs.

**Leave alone:** everything else that works and has a test. Small, reviewable changes, each with a test and a plain-English note. Design changes shown as two or three looks first.

## 7. The first two weeks

See `docs/PLAN.md`.

## 8. Something I built that handled money or personal data

To be answered in person. The lesson this blueprint is built on: the rule has to live where the data lives. A screen hides a button; a server checks a request; only the database refuses the row. When all three agree, a mistake in any one of them is caught by the other two.
