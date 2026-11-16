-- North Lane CRM · Supabase blueprint
-- 0001 · Tables
--
-- Mirrors the SQLite tables described in the developer briefing (pages 15 and 18):
-- records / docs / changes / files / outbox / calls / security_log / numbers_kept,
-- with the ledger pulled out into its own insert-only table holding whole pence.
--
-- Every row that belongs to a branch carries `branch`. Row-level security (0003)
-- does the separating; the Node API never has to remember to filter.

create schema if not exists app;

-- Roles Supabase ships with. Created here only so the same SQL runs on plain Postgres in CI.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema public, app to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- Branches and staff
-- ---------------------------------------------------------------------------
create table if not exists public.branches (
  id          text primary key,            -- 'B1', 'B2' ...
  code        text not null unique,        -- '' for the first branch, 'B2' for later ones (NL-B2-R-0001)
  name        text not null,
  created_at  timestamptz not null default now()
);

-- One row per staff member, keyed by the Supabase Auth user id.
-- Roles, switches and branch are ALSO written into the JWT (app_metadata) by the
-- Node API when a Founder changes them, so policies read the token, not this table.
-- This table is the human-readable copy for the Team screen.
create table if not exists public.staff (
  user_id     uuid primary key,
  branch      text not null references public.branches(id),
  name        text not null,
  extension   text,
  roles       text[] not null default '{}',   -- 'founder','ceo','director','branch_manager','lettings_manager','basic'
  switches    text[] not null default '{}',   -- 'takeRent','seeAccounts','seeBank','restoreArchive','readSecurityLog', ...
  areas       jsonb  not null default '{}',   -- {"tenancies":["add","change"], "contacts":["add","change","delete"]}
  retired_at  timestamptz
);

-- ---------------------------------------------------------------------------
-- The generic record store (DB.<coll> lists in the browser)
-- ---------------------------------------------------------------------------
create table if not exists public.records (
  coll        text not null,
  id          text not null,
  branch      text not null references public.branches(id),
  data        jsonb not null,
  pos         integer not null default 0,
  rev         bigint  not null default 1,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  primary key (coll, id)
);
create index if not exists records_branch_coll on public.records (branch, coll);
create index if not exists records_data_gin   on public.records using gin (data jsonb_path_ops);

-- Docs: settings, seq and other single objects. branch null = company-wide.
create table if not exists public.docs (
  key         text primary key,
  branch      text references public.branches(id),
  data        jsonb not null,
  rev         bigint not null default 1,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

-- Appointments get their own table because of the "named staff read it whichever
-- branch holds it" rule (named.js).
create table if not exists public.appts (
  id          text primary key,
  branch      text not null references public.branches(id),
  staff       uuid[] not null default '{}',
  starts_at   timestamptz not null,
  data        jsonb not null,
  rev         bigint not null default 1
);

-- Archive: a delete is a copy kept by the server, restorable with one switch.
create table if not exists public.archive (
  coll        text not null,
  id          text not null,
  branch      text not null references public.branches(id),
  data        jsonb not null,
  pos         integer not null,
  rev         bigint not null,
  archived_at timestamptz not null default now(),
  archived_by uuid,
  restored_at timestamptz,
  primary key (coll, id, archived_at)
);

-- Every change ever, with who, when, before and after. Append-only.
create table if not exists public.changes (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  who         uuid,
  branch      text,
  coll        text not null,
  rec_id      text not null,
  before      jsonb,
  after       jsonb
);
create index if not exists changes_rec on public.changes (coll, rec_id, at);

-- ---------------------------------------------------------------------------
-- Money: whole pence, insert-only, reversals
-- ---------------------------------------------------------------------------
create table if not exists public.ledger (
  id          bigint generated always as identity primary key,
  branch      text not null references public.branches(id),
  ref         text not null unique,                   -- NL-R-0432, NL-B2-ST-0001 ...
  kind        text not null,                           -- 'rent_in','fee','landlord_out','deposit_in','repair', ...
  account     text not null check (account in ('client','business')),
  amount_p    bigint not null,                         -- pence. Negative = out.
  dated       date not null default current_date,     -- the accounting date (closed months check this)
  tenancy     text,
  property    text,
  contact     text,
  reverses    bigint references public.ledger(id),    -- set on the mirror entry
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid
);
create index if not exists ledger_branch_dated on public.ledger (branch, dated);
create unique index if not exists ledger_one_reversal on public.ledger (reverses) where reverses is not null;

create table if not exists public.closed_months (
  branch      text not null references public.branches(id),
  month       date not null check (month = date_trunc('month', month)::date),
  closed_at   timestamptz not null default now(),
  closed_by   uuid,
  primary key (branch, month)
);

-- Reference numbers: one counter per kind and branch (page 18 asks for "one Postgres
-- sequence per kind and branch"; a locked counter row is the same guarantee and can be
-- created on the fly for a new branch without DDL).
create table if not exists public.counters (
  kind        text not null,       -- 'R' receipts, 'ST' statements, 'J' repair tickets ...
  branch      text not null references public.branches(id),
  n           integer not null default 0,
  primary key (kind, branch)
);

-- A number stays used even after the record is erased.
create table if not exists public.numbers_kept (
  ref         text primary key,
  kind        text not null,
  branch      text not null,
  taken_at    timestamptz not null default now(),
  taken_by    uuid
);

-- Masked unless the role may see them; every view is logged.
create table if not exists public.bank_details (
  contact     text not null,
  branch      text not null references public.branches(id),
  account_no  text not null,
  sort_code   text not null,
  approved_by uuid,                       -- the second person
  primary key (contact)
);

-- ---------------------------------------------------------------------------
-- Files, outbox, calls
-- ---------------------------------------------------------------------------
create table if not exists public.files (
  key         text primary key,           -- Storage object path
  bucket      text not null,              -- 'documents','id-copies','inspection-photos','signing-pages'
  branch      text not null references public.branches(id),
  sha256      text not null,
  size        bigint not null,
  mime        text not null,
  uploader    uuid,
  record_coll text,
  record_id   text,
  erased_at   timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists files_record on public.files (record_coll, record_id);

create table if not exists public.outbox (
  id          text primary key,
  branch      text not null references public.branches(id),
  kind        text not null,              -- 'receipt','statement','offer','s13','signed_copy','viewing'
  to_name     text,
  to_email    text not null,
  subject     text not null,
  status      text not null default 'queued' check (status in ('queued','sent','failed','bounced','delivered')),
  provider_ref text,
  attempts    integer not null default 0,
  error       text,
  record_coll text,
  record_id   text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  updated_at  timestamptz not null default now()
);
create index if not exists outbox_status on public.outbox (status, created_at);

create table if not exists public.calls (
  id          bigint generated always as identity primary key,
  branch      text not null references public.branches(id),
  call_ref    text not null,              -- the phone system's id for the call
  type        text not null check (type in ('ringing','answered','transferred','missed')),
  from_no     text not null,              -- normalised E.164 where possible
  ext         text not null,
  contact     text,                       -- matched contact id, if any
  answered_by uuid,
  at          timestamptz not null default now(),
  notes       text,
  ended_at    timestamptz
);
create index if not exists calls_ref on public.calls (call_ref, at);

-- ---------------------------------------------------------------------------
-- Security log, breach log, rights register: append-only
-- ---------------------------------------------------------------------------
create table if not exists public.security_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  who         uuid,
  branch      text,
  event       text not null,
  detail      jsonb
);

create table if not exists public.breaches (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  branch      text,
  reported_by uuid,
  detail      jsonb not null
);

create table if not exists public.rights_requests (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  branch      text,
  kind        text not null,              -- 'access','erasure','rectification'
  contact     text not null,
  handled_by  uuid,
  detail      jsonb
);

-- Grants: the API connects as `authenticated` (through the user's JWT). Policies decide rows.
grant select, insert, update on all tables in schema public to authenticated;
revoke delete on all tables in schema public from authenticated;   -- nothing is deleted for good
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
