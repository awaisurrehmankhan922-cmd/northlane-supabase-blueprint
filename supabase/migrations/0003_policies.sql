-- 0003 · Row-level security
--
-- Three layers, applied to every table:
--   1. needs_aal2   RESTRICTIVE  nothing is reached without the person's own second step (SEC-221)
--   2. branch_*     PERMISSIVE   your own branch, or every branch for Founder / CEO / Director
--   3. per-table    PERMISSIVE   the extra rule that table carries (named staff, switches, insert-only)
--
-- A restrictive policy must pass AND at least one permissive policy must pass.
-- There is no DELETE policy anywhere, and `authenticated` has no DELETE grant either.

-- ---------------------------------------------------------------------------
-- Turn RLS on everywhere, including for the table owner
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 1. aal2 on every table
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('drop policy if exists needs_aal2 on public.%I', t);
    execute format(
      'create policy needs_aal2 on public.%I as restrictive for all to authenticated
         using (app.aal2()) with check (app.aal2())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Branches
-- ---------------------------------------------------------------------------
create policy branches_read on public.branches for select to authenticated
  using (true);                                   -- names and codes only; no personal data
create policy branches_write on public.branches for all to authenticated
  using (app.is_founder()) with check (app.is_founder());

create policy staff_read on public.staff for select to authenticated
  using (app.sees_branch(branch));
-- Team changes go through the Node API as service_role (it must also update the JWT
-- metadata), so no insert/update policy for staff here on purpose.

-- records: the generic store
create policy records_read on public.records for select to authenticated
  using (app.sees_branch(branch) or coll = any(app.shared_lists()));

create policy records_insert on public.records for insert to authenticated
  with check (app.writes_branch(branch) and app.may(coll, 'add'));

create policy records_update on public.records for update to authenticated
  using (app.writes_branch(branch) and app.may(coll, 'change'))
  with check (app.writes_branch(branch) and app.may(coll, 'change'));
-- no delete: use app.archive()

create policy docs_read on public.docs for select to authenticated
  using (branch is null or app.sees_branch(branch));
create policy docs_write on public.docs for all to authenticated
  using (app.can('changeSettings') and (branch is null or app.writes_branch(branch)))
  with check (app.can('changeSettings') and (branch is null or app.writes_branch(branch)));

-- appts: branch rule, plus "people named on it read it whichever branch holds it"
create policy appts_read on public.appts for select to authenticated
  using (app.sees_branch(branch) or app.uid() = any(staff));
create policy appts_write on public.appts for insert to authenticated
  with check (app.writes_branch(branch) and app.may('appts', 'add'));
create policy appts_change on public.appts for update to authenticated
  using (app.writes_branch(branch) and app.may('appts', 'change'))
  with check (app.writes_branch(branch) and app.may('appts', 'change'));

-- archive: read your branch; writes only through app.archive() / app.restore()
create policy archive_read on public.archive for select to authenticated
  using (app.sees_branch(branch));

-- changes: Founders with the switch read the trail; nobody writes directly
create policy changes_read on public.changes for select to authenticated
  using (app.can('readActivityLog') and (branch is null or app.sees_branch(branch)));

-- ---------------------------------------------------------------------------
-- 3. Money
-- ---------------------------------------------------------------------------
-- You see the lines you wrote (your own receipts); the books as a whole need "See Accounts".
create policy ledger_read on public.ledger for select to authenticated
  using (app.sees_branch(branch) and (app.can('seeAccounts') or created_by = app.uid()));

create policy ledger_insert on public.ledger for insert to authenticated
  with check (app.writes_branch(branch) and app.can('takeRent') and reverses is null);
-- No update policy. No delete policy. Reverse is a function (0004).

create policy closed_months_read on public.closed_months for select to authenticated
  using (app.sees_branch(branch));
create policy closed_months_write on public.closed_months for insert to authenticated
  with check (app.is_founder());

create policy counters_read on public.counters for select to authenticated
  using (app.sees_branch(branch));
-- counters change only inside app.next_ref()

create policy numbers_kept_read on public.numbers_kept for select to authenticated
  using (app.sees_branch(branch));

-- bank details: the raw table is readable only with the switch; everyone else uses the
-- masked view (0004). Changes need the second-person flow in the API.
create policy bank_read on public.bank_details for select to authenticated
  using (app.sees_branch(branch));
create policy bank_insert on public.bank_details for insert to authenticated
  with check (app.writes_branch(branch) and app.can('changeBank'));
create policy bank_update on public.bank_details for update to authenticated
  using (app.writes_branch(branch) and app.can('changeBank'))
  with check (app.writes_branch(branch) and app.can('changeBank'));

-- ---------------------------------------------------------------------------
-- Files, outbox, calls
-- ---------------------------------------------------------------------------
create policy files_read on public.files for select to authenticated
  using (app.sees_branch(branch)
         and (bucket <> 'id-copies' or app.can('viewIdDocuments')));
create policy files_insert on public.files for insert to authenticated
  with check (app.writes_branch(branch) and uploader = app.uid());

create policy outbox_read on public.outbox for select to authenticated
  using (app.sees_branch(branch));
-- Staff never type an address: outbox lines are created by the server (service_role).

create policy calls_read on public.calls for select to authenticated
  using (app.sees_branch(branch));
create policy calls_notes on public.calls for update to authenticated
  using (app.writes_branch(branch))
  with check (app.writes_branch(branch));
-- A trigger in 0004 limits that update to notes / ended_at / answered_by.
-- Call events arrive from the phone bridge via the API (service_role), never from a browser.

-- ---------------------------------------------------------------------------
-- Security log, breaches, rights: read with the switch, append through functions
-- ---------------------------------------------------------------------------
create policy seclog_read on public.security_log for select to authenticated
  using (app.can('readSecurityLog') and (branch is null or app.sees_branch(branch)));

create policy breaches_read on public.breaches for select to authenticated
  using (app.can('readSecurityLog') and (branch is null or app.sees_branch(branch)));
create policy breaches_insert on public.breaches for insert to authenticated
  with check (app.is_founder());

create policy rights_read on public.rights_requests for select to authenticated
  using (app.can('handleRights') and (branch is null or app.sees_branch(branch)));
create policy rights_insert on public.rights_requests for insert to authenticated
  with check (app.can('handleRights'));
