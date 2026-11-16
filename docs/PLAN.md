# The work ahead, in phases

Each phase ends with something the office can see working and a fixed price agreed before the next one starts. Dummy data only until the dated move in Phase 2.

## Phase 0 · Access and foundations (week 1)

| Day | Work | Done means |
|---|---|---|
| 1 | NDA and DPA signed. Code onto a private GitHub repository; branch protection; CI running `npm run verify` and the Playwright browser test on every push. | A red/green tick on every change. |
| 1–2 | Read `docs/ARCHITECTURE`, `DATA`, `RULES`, `API`, the security review and the open should-fix list. Write down every question. | A short list of questions for the office, none guessed. |
| 2 | Supabase project in the London region, Pro plan, with a second project for staging. Secrets in the host's environment only. | Two empty projects; nobody but the Founders holds the owner login. |
| 3–5 | Postgres schema mirroring today's tables (`records`, `docs`, `changes`, `files` …). `store.js` on Postgres: same functions, same return values. | **The full 1,500-case server suite passes against Postgres.** |

## Phase 1 · Auth, RLS, Storage, hosting (weeks 2–4)

| Work | Done means |
|---|---|
| `files.js` on Supabase Storage: private buckets per kind, signed URLs, upload checks unchanged. | Documents, ID copies, inspection photos and signing pages open as today. |
| Supabase Auth alongside the current sign-in, then switched over. Password rules kept (12+, breached list). TOTP for everyone who must use codes today; trusted browser 7 days. | A sign-in with password but no code is **refused on every table**. |
| Roles, switches, areas and branch written into JWT `app_metadata` by the API when a Founder changes them. | Team screen works; a changed role takes effect on next token refresh (≤ 1 hour) or immediately with a forced sign-out. |
| RLS: aal2 everywhere, branch separation, named staff, switches, insert-only money, archive instead of delete. Rules into the database one at a time (this blueprint's `0003`/`0004`). | **One branch's user cannot read or write another's rows, even with a hand-made request.** `test/01`–`03` green in CI. |
| Money to whole pence in `bigint`. Any stored value with part of a penny listed for a person to fix. | Sums in SQL match the browser's totals to the penny. |
| Hosting: Node 22 API on a small VPS with systemd + Caddy (or Render/Fly), HTTPS, `PUBLIC_HOST`, `TRUST_PROXY`. Uptime check on `/api/health`. Error logging that never records personal data. | The staging CRM reachable at an HTTPS address; an alert fires when it is not. |
| Backups: Supabase point-in-time recovery, plus the existing encrypted signed copies to a versioned bucket elsewhere, private key held offline by the Founders. First restore drill done and written up. | A restore into a scratch project keeps erasures erased and numbers unique. |
| Text provider behind `stepup.use()` for Founder step-up and signing codes. | A Founder step-up receives its texted code. |

## Phase 2 · Independent review and the move (weeks 5–6)

| Work | Done means |
|---|---|
| Hand the staging CRM and the Supabase set-up to the independent security reviewer. Fix what they find; re-test. | Their sign-off in writing. |
| A dated move of the office's data, on a weekend, with a rollback plan and the Founders present. | Monday morning works. The office PC copy is kept read-only for 30 days. |

## Phase 3 · Email, phones, signing, desktop app (weeks 7–10, in whatever order the office prefers)

| Work | Done means |
|---|---|
| Real email through the outbox (`backend/mailer.js`): Microsoft 365 or Postmark, SPF/DKIM/DMARC, bounces updating the outbox line. Remaining "Have you emailed it?" screens onto the outbox. | A rent receipt arrives in a tenant's inbox; a bad address shows as Failed with the reason. |
| Phone bridge (`phone-bridge/`) in whichever mode the supplier allows. Click-to-dial if AMI. | A test call pops the right contact on the right screen; the call log fills itself. |
| Public signing page (`backend/signing-public.js`): a signing code, the signer's own pages and boxes only, texts for codes and reminders. | A tenant signs an agreement on their own phone; the signed PDF files itself. |
| Branch code sign-in for shared office devices. | A shared device picks its branch; it never counts as a second step. |
| PWA (`pwa/`): manifest, service worker caching only the shell. | Installs from the Start menu and the Dock; updates cleanly on deploy. |

## Then · Looking after it

Monthly: Node security releases, `npm audit` on dev packages, jsPDF and pdf.js advisories, the restore drill actually done and recorded, a one-page status note. Move to Node 24 LTS before 30/04/2027. Quarterly: re-run the RLS suite against production with a scratch user per role, and share the result with the independent reviewer.

## What I would need from the office before each phase

- Phase 0: repository access, the Supabase organisation created under a Founder's email, the open should-fix list.
- Phase 1: the real extension list and role list; a decision on Microsoft 365 vs a transactional email service.
- Phase 2: the independent reviewer's name and dates; a weekend for the move.
- Phase 3: the supplier's answer on AMI / webhook / nothing; the text provider account; the lawyer-approved agreement wording already in place.
