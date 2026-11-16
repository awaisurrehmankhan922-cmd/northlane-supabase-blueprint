-- 0002 · Helper functions the policies use
--
-- Everything about "who is this" is read from the JWT, never from a table the user
-- could edit. The Node API writes branch, roles, switches and areas into the user's
-- app_metadata (Supabase Admin API) when a Founder changes them; Supabase copies
-- app_metadata into every token it issues.
--
-- Token shape the policies expect:
--   { "sub": "<uuid>", "role": "authenticated", "aal": "aal1" | "aal2",
--     "app_metadata": { "branch": "B1",
--                       "roles": ["lettings_manager","basic"],
--                       "switches": ["takeRent","seeAccounts"],
--                       "areas": {"tenancies":["add","change"]} } }

create or replace function app.claims() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create or replace function app.meta() returns jsonb
language sql stable as $$
  select coalesce(app.claims() -> 'app_metadata', '{}'::jsonb)
$$;

create or replace function app.uid() returns uuid
language sql stable as $$
  select nullif(app.claims() ->> 'sub', '')::uuid
$$;

-- Passed the second step (authenticator app) in this session?
create or replace function app.aal2() returns boolean
language sql stable as $$
  select (app.claims() ->> 'aal') = 'aal2'
$$;

create or replace function app.my_branch() returns text
language sql stable as $$
  select app.meta() ->> 'branch'
$$;

create or replace function app.my_roles() returns text[]
language sql stable as $$
  select coalesce(array(select jsonb_array_elements_text(app.meta() -> 'roles')), '{}')
$$;

create or replace function app.has_role(r text) returns boolean
language sql stable as $$
  select r = any(app.my_roles())
$$;

create or replace function app.is_founder() returns boolean
language sql stable as $$
  select app.has_role('founder')
$$;

-- Founder, CEO and Director are shared across all branches (page 16).
create or replace function app.sees_all_branches() returns boolean
language sql stable as $$
  select app.my_roles() && array['founder','ceo','director']
$$;

-- A power switch: 'takeRent', 'seeAccounts', 'seeBank', 'restoreArchive', 'readSecurityLog' ...
-- Founders hold every switch.
create or replace function app.can(sw text) returns boolean
language sql stable as $$
  select app.is_founder()
      or sw = any(coalesce(array(select jsonb_array_elements_text(app.meta() -> 'switches')), '{}'))
$$;

-- Add / Change / Delete per area (access.js). Founders may do anything.
create or replace function app.may(coll text, action text) returns boolean
language sql stable as $$
  select app.is_founder()
      or (app.meta() -> 'areas' -> coll) ? action
$$;

-- Lists that every branch shares. A new branch starts fresh with its own team, roles,
-- templates, Settings and choice lists (page 16), so this holds only company-wide reference
-- data that carries no personal data: Help & FAQ answers, the lawyer-approved agreement
-- wording, company documents. A Founder decides the list; nothing is added here by code.
create or replace function app.shared_lists() returns text[]
language sql immutable as $$
  select array['help','agreements','company_docs']
$$;

-- Does this user see rows from `b`?
create or replace function app.sees_branch(b text) returns boolean
language sql stable as $$
  select app.sees_all_branches() or b = app.my_branch()
$$;

-- Does this user write rows into `b`? Founders anywhere; everyone else only their own.
create or replace function app.writes_branch(b text) returns boolean
language sql stable as $$
  select app.is_founder() or b = app.my_branch()
$$;

-- Branch code for reference numbers: '' for the first branch, 'B2-' for later ones.
create or replace function app.branch_prefix(b text) returns text
language sql stable as $$
  select case when code = '' then '' else code || '-' end from public.branches where id = b
$$;

-- Write a security-log line. SECURITY DEFINER so staff can log without an insert policy
-- on the table itself (nobody can write it directly).
create or replace function app.log_security(event text, detail jsonb default null) returns void
language sql security definer set search_path = public, app as $$
  insert into public.security_log (who, branch, event, detail)
  values (app.uid(), app.my_branch(), event, detail)
$$;
revoke all on function app.log_security(text, jsonb) from public;
grant execute on function app.log_security(text, jsonb) to authenticated, service_role;

grant execute on all functions in schema app to authenticated, anon, service_role;
