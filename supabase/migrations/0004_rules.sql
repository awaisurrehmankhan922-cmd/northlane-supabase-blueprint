-- 0004 · The rules that move from rules.js into the database
--
-- The briefing (page 18): "Each rule becomes a policy, a check constraint, a trigger, or a
-- check inside a security definer function that saves the record." This file holds the ones
-- that must be true even if the Node API has a bug:
--
--   · money lines, changes and logs are append-only (triggers)
--   · Reverse writes the mirror entry in one transaction (function)
--   · reference numbers never repeat, even across two people at once (function + unique index)
--   · nothing is dated into a closed month except by a Founder (trigger)
--   · deposit caps in pence, rounded down (trigger + the same formula as shared/caps.js)
--   · every save is kept with before and after (trigger)
--   · bank details masked unless the role may see them; every view logged (view + function)
--   · a delete is an Archive entry; restore needs the switch (functions)
--   · one transaction per save batch, refused whole if any op is refused (function)

-- ---------------------------------------------------------------------------
-- Append-only
-- ---------------------------------------------------------------------------
create or replace function app.refuse_change() returns trigger
language plpgsql as $$
begin
  -- "Rewritten only by the law: erasure and Right to Rent removal" (page 15). The change
  -- trail may be redacted, never deleted, and only inside app.erase_person(), which sets
  -- this transaction-local flag. Money and the security log are never rewritten at all.
  if tg_op = 'UPDATE' and tg_table_name = 'changes'
     and current_setting('app.lawful_rewrite', true) = 'erasure' then
    return new;
  end if;
  raise exception 'KEPT_FOR_GOOD: % lines are never changed or deleted', tg_table_name
    using errcode = 'P0001';
end $$;

do $$
declare t text;
begin
  foreach t in array array['ledger','changes','security_log','breaches','rights_requests','numbers_kept'] loop
    execute format('drop trigger if exists kept_for_good on public.%I', t);
    execute format('create trigger kept_for_good before update or delete on public.%I
                    for each row execute function app.refuse_change()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Ledger: closed months, pence, non-zero
-- ---------------------------------------------------------------------------
create or replace function app.ledger_before_insert() returns trigger
language plpgsql as $$
begin
  if new.amount_p = 0 then
    raise exception 'MONEY_ZERO: a money line must move some pence';
  end if;
  if exists (select 1 from public.closed_months cm
             where cm.branch = new.branch and cm.month = date_trunc('month', new.dated)::date)
     and not app.is_founder() then
    raise exception 'MONTH_CLOSED: % is closed; only a Founder may date a record into it',
      to_char(new.dated, 'Mon yyyy');
  end if;
  new.created_by := coalesce(new.created_by, app.uid());
  new.created_at := now();
  return new;
end $$;
drop trigger if exists ledger_rules on public.ledger;
create trigger ledger_rules before insert on public.ledger
  for each row execute function app.ledger_before_insert();

-- ---------------------------------------------------------------------------
-- Reference numbers: NL-R-0432, NL-B2-R-0001
-- ---------------------------------------------------------------------------
create or replace function app.next_ref(p_kind text, p_branch text default app.my_branch()) returns text
language plpgsql security definer set search_path = public, app as $$
declare
  v_n   integer;
  v_ref text;
begin
  if not app.aal2() or not app.writes_branch(p_branch) then
    raise exception 'REFUSED: cannot take a number for branch %', p_branch;
  end if;
  insert into public.counters as c (kind, branch, n) values (p_kind, p_branch, 1)
    on conflict (kind, branch) do update set n = c.n + 1
    returning c.n into v_n;                     -- the row lock serialises two people at once
  v_ref := 'NL-' || app.branch_prefix(p_branch) || p_kind || '-' || lpad(v_n::text, 4, '0');
  insert into public.numbers_kept (ref, kind, branch, taken_by) values (v_ref, p_kind, p_branch, app.uid());
  return v_ref;
end $$;

-- ---------------------------------------------------------------------------
-- Reverse: the only way to "undo" money
-- ---------------------------------------------------------------------------
create or replace function app.reverse_entry(entry_id bigint, why text) returns bigint
language plpgsql security definer set search_path = public, app as $$
declare
  e    public.ledger%rowtype;
  v_id bigint;
begin
  select * into e from public.ledger l where l.id = entry_id for update;
  if not found then
    raise exception 'REFUSED: no such money line';
  end if;
  if not app.aal2() or not app.can('seeAccounts') or not app.writes_branch(e.branch) then
    raise exception 'REFUSED: Reverse needs "See Accounts" in branch %', e.branch;
  end if;
  if e.reverses is not null then
    raise exception 'REFUSED: a reversal is not itself reversed; reverse the original';
  end if;
  if exists (select 1 from public.ledger where reverses = entry_id) then
    raise exception 'REFUSED: % is already reversed', e.ref;
  end if;
  if coalesce(why, '') = '' then
    raise exception 'REFUSED: say why';
  end if;
  insert into public.ledger (branch, ref, kind, account, amount_p, dated, tenancy, property, contact, reverses, note, created_by)
  values (e.branch, app.next_ref('RV', e.branch), e.kind, e.account, -e.amount_p, current_date,
          e.tenancy, e.property, e.contact, e.id, 'Reverses ' || e.ref || ': ' || why, app.uid())
  returning public.ledger.id into v_id;
  perform app.log_security('ledger.reverse', jsonb_build_object('of', e.ref, 'why', why));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Deposit caps (mirror of shared/caps.js — the test suite checks they agree)
-- ---------------------------------------------------------------------------
create or replace function app.annual_rent_p(rent_p bigint, period text) returns bigint
language sql immutable as $$
  select case period when 'monthly' then rent_p * 12
                     when 'quarterly' then rent_p * 4
                     when 'yearly' then rent_p
                     else null end
$$;

-- Tenancy deposit: at most 5 weeks' rent (6 if rent is £50,000 a year or more). Pence, rounded down.
create or replace function app.deposit_cap_p(rent_p bigint, period text) returns bigint
language sql immutable as $$
  select floor(app.annual_rent_p(rent_p, period) / 52.0
               * case when app.annual_rent_p(rent_p, period) >= 5000000 then 6 else 5 end)::bigint
$$;

-- Holding deposit: at most 1 week.
create or replace function app.holding_cap_p(rent_p bigint, period text) returns bigint
language sql immutable as $$
  select floor(app.annual_rent_p(rent_p, period) / 52.0)::bigint
$$;

create or replace function app.records_rules() returns trigger
language plpgsql as $$
declare
  rent bigint; per text; dep bigint; hold bigint;
begin
  -- pence only, anywhere in a record
  if exists (select 1 from jsonb_each(new.data) kv
             where kv.key like '%\_p' escape '\' and jsonb_typeof(kv.value) = 'number'
               and (kv.value::text)::numeric <> floor((kv.value::text)::numeric)) then
    raise exception 'PENCE_ONLY: amounts are whole pence';
  end if;

  if new.coll = 'tenancies' then
    rent := (new.data ->> 'rent_p')::bigint;
    per  := new.data ->> 'period';
    dep  := (new.data ->> 'deposit_p')::bigint;
    hold := (new.data ->> 'holding_p')::bigint;
    if per = 'weekly' then
      raise exception 'NO_WEEKLY_RENT: rent is monthly, quarterly or yearly';
    end if;
    if rent is not null and per is not null then
      if dep is not null and dep > app.deposit_cap_p(rent, per) then
        raise exception 'DEPOSIT_CAP: deposit %p is over the cap of %p', dep, app.deposit_cap_p(rent, per);
      end if;
      if hold is not null and hold > app.holding_cap_p(rent, per) then
        raise exception 'HOLDING_CAP: holding deposit %p is over one week (%p)', hold, app.holding_cap_p(rent, per);
      end if;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    new.rev := old.rev + 1;
  end if;
  new.updated_at := now();
  new.updated_by := app.uid();
  return new;
end $$;
drop trigger if exists records_rules on public.records;
create trigger records_rules before insert or update on public.records
  for each row execute function app.records_rules();

-- ---------------------------------------------------------------------------
-- Every change is kept
-- ---------------------------------------------------------------------------
create or replace function app.keep_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  insert into public.changes (who, branch, coll, rec_id, before, after)
  values (app.uid(),
          coalesce(new.branch, old.branch),
          coalesce(new.coll, old.coll),
          coalesce(new.id, old.id),
          case when tg_op = 'INSERT' then null else old.data end,
          case when tg_op = 'DELETE' then null else new.data end);
  return coalesce(new, old);
end $$;
drop trigger if exists keep_change on public.records;
create trigger keep_change after insert or update or delete on public.records
  for each row execute function app.keep_change();

-- ---------------------------------------------------------------------------
-- Calls: staff may add notes and end a call, never rewrite who called
-- ---------------------------------------------------------------------------
create or replace function app.calls_frozen() returns trigger
language plpgsql as $$
begin
  if new.branch <> old.branch or new.call_ref <> old.call_ref or new.type <> old.type
     or new.from_no <> old.from_no or new.ext <> old.ext or new.at <> old.at then
    raise exception 'KEPT_FOR_GOOD: a call line only takes notes';
  end if;
  return new;
end $$;
drop trigger if exists calls_frozen on public.calls;
create trigger calls_frozen before update on public.calls
  for each row execute function app.calls_frozen();

-- ---------------------------------------------------------------------------
-- Bank details: masked view, logged reads
-- ---------------------------------------------------------------------------
create or replace view public.bank_details_masked
with (security_invoker = true) as
select contact, branch,
       case when app.can('seeBank') then account_no else repeat('*', 4) || right(account_no, 4) end as account_no,
       case when app.can('seeBank') then sort_code  else '**-**-' || right(sort_code, 2) end        as sort_code,
       app.can('seeBank') as unmasked
from public.bank_details;
grant select on public.bank_details_masked to authenticated;

-- The screen calls this, not the view, so every full view is in the security log.
create or replace function app.view_bank(contact_id text)
returns table (contact text, account_no text, sort_code text, unmasked boolean)
language plpgsql security invoker as $$
begin
  if app.can('seeBank') then
    perform app.log_security('bank.view', jsonb_build_object('contact', contact_id));
  end if;
  return query select m.contact, m.account_no, m.sort_code, m.unmasked
               from public.bank_details_masked m where m.contact = contact_id;
end $$;

-- ---------------------------------------------------------------------------
-- Archive and restore
-- ---------------------------------------------------------------------------
create or replace function app.archive(p_coll text, p_id text) returns void
language plpgsql security definer set search_path = public, app as $$
declare r public.records%rowtype;
begin
  select * into r from public.records where coll = p_coll and id = p_id for update;
  if not found or not app.aal2() or not app.writes_branch(r.branch) or not app.may(p_coll, 'delete') then
    raise exception 'REFUSED: cannot archive %/%', p_coll, p_id;
  end if;
  insert into public.archive (coll, id, branch, data, pos, rev, archived_by)
  values (r.coll, r.id, r.branch, r.data, r.pos, r.rev, app.uid());
  delete from public.records where coll = p_coll and id = p_id;   -- keep_change writes the trail
end $$;

create or replace function app.restore(p_coll text, p_id text) returns void
language plpgsql security definer set search_path = public, app as $$
declare a public.archive%rowtype;
begin
  select * into a from public.archive
   where coll = p_coll and id = p_id and restored_at is null
   order by archived_at desc limit 1 for update;
  if not found or not app.aal2() or not app.writes_branch(a.branch) or not app.can('restoreArchive') then
    raise exception 'REFUSED: cannot restore %/%', p_coll, p_id;
  end if;
  insert into public.records (coll, id, branch, data, pos, rev)
  values (a.coll, a.id, a.branch, a.data, a.pos, a.rev + 1);
  update public.archive set restored_at = now()
   where coll = a.coll and id = a.id and archived_at = a.archived_at;
  perform app.log_security('archive.restore', jsonb_build_object('coll', p_coll, 'id', p_id));
end $$;

-- ---------------------------------------------------------------------------
-- One transaction per save batch (what saveDB() sends, page 15)
--
--   [{ "t":"rec",   "coll":"payments", "id":"pay_9f2", "data":{...}, "pos":0, "baseRev":0 },
--    { "t":"doc",   "key":"seq", "data":{...}, "baseRev":811 },
--    { "t":"del",   "coll":"appts", "id":"ap_1c" },
--    { "t":"order", "coll":"tasks", "ids":[...] }]
--
-- SECURITY INVOKER on purpose: every statement inside runs under the caller's RLS.
-- Any refusal raises, so nothing in the batch is saved.
-- ---------------------------------------------------------------------------
create or replace function app.apply_ops(ops jsonb, p_branch text default app.my_branch()) returns jsonb
language plpgsql security invoker as $$
declare
  op      jsonb;
  cur_rev bigint;
  n       integer;
  i       integer;
  out     jsonb := '[]'::jsonb;
begin
  for op in select * from jsonb_array_elements(ops) loop
    case op ->> 't'
    when 'rec' then
      select rev into cur_rev from public.records where coll = op ->> 'coll' and id = op ->> 'id';
      if found then
        if cur_rev <> coalesce((op ->> 'baseRev')::bigint, -1) then
          raise exception 'STALE: %/% is at rev %, you started from %', op ->> 'coll', op ->> 'id', cur_rev, op ->> 'baseRev';
        end if;
        update public.records set data = op -> 'data', pos = coalesce((op ->> 'pos')::int, pos)
         where coll = op ->> 'coll' and id = op ->> 'id';
        get diagnostics n = row_count;
        if n = 0 then raise exception 'REFUSED: cannot change %/%', op ->> 'coll', op ->> 'id'; end if;
      else
        begin
          insert into public.records (coll, id, branch, data, pos)
          values (op ->> 'coll', op ->> 'id', coalesce(op ->> 'branch', p_branch), op -> 'data', coalesce((op ->> 'pos')::int, 0));
        exception when unique_violation then
          -- the row exists but this person may not see it: say no more than that
          raise exception 'REFUSED: cannot change %/%', op ->> 'coll', op ->> 'id';
        end;
      end if;
      select rev into cur_rev from public.records where coll = op ->> 'coll' and id = op ->> 'id';
      out := out || jsonb_build_object('coll', op ->> 'coll', 'id', op ->> 'id', 'rev', cur_rev);

    when 'doc' then
      select rev into cur_rev from public.docs where key = op ->> 'key';
      if found then
        if cur_rev <> coalesce((op ->> 'baseRev')::bigint, -1) then
          raise exception 'STALE: doc % is at rev %', op ->> 'key', cur_rev;
        end if;
        update public.docs set data = op -> 'data', rev = rev + 1, updated_at = now(), updated_by = app.uid()
         where key = op ->> 'key';
        get diagnostics n = row_count;
        if n = 0 then raise exception 'REFUSED: cannot change doc %', op ->> 'key'; end if;
      else
        insert into public.docs (key, branch, data, updated_by)
        values (op ->> 'key', op ->> 'branch', op -> 'data', app.uid());
      end if;
      select rev into cur_rev from public.docs where key = op ->> 'key';
      out := out || jsonb_build_object('key', op ->> 'key', 'rev', cur_rev);

    when 'del' then
      perform app.archive(op ->> 'coll', op ->> 'id');

    when 'order' then
      i := 0;
      for i in 0 .. jsonb_array_length(op -> 'ids') - 1 loop
        update public.records set pos = i
         where coll = op ->> 'coll' and id = op -> 'ids' ->> i;
      end loop;

    else
      raise exception 'BAD_OP: unknown op %', op ->> 't';
    end case;
  end loop;
  return out;
end $$;

-- ---------------------------------------------------------------------------
-- Two accounts: rent and deposits always go to the client account; the client account
-- never pays out money that is not really there (clientmoney.js)
-- ---------------------------------------------------------------------------
create or replace function app.client_money_rules() returns trigger
language plpgsql as $$
declare bal bigint;
begin
  if new.kind in ('rent_in', 'deposit_in', 'holding_in') and new.account <> 'client' then
    raise exception 'CLIENT_MONEY: % always goes to the client account', new.kind;
  end if;
  -- fees reach the business account only by a recorded move out of the client account
  if new.account = 'business' and new.kind not in ('fee_move', 'repair_cut', 'sale_fee', 'referral_fee') and new.reverses is null then
    raise exception 'CLIENT_MONEY: only a recorded fee move puts money in the business account';
  end if;
  -- paying out of the client account for a tenancy or property: only what is held for it
  if new.account = 'client' and new.amount_p < 0 and new.reverses is null then
    select coalesce(sum(amount_p), 0) into bal from public.ledger
     where account = 'client' and branch = new.branch
       and ((new.tenancy is not null and tenancy = new.tenancy) or (new.tenancy is null and property = new.property));
    if bal + new.amount_p < 0 then
      raise exception 'CLIENT_MONEY: only %p is held for this %; cannot pay out %p',
        bal, case when new.tenancy is not null then 'tenancy' else 'property' end, -new.amount_p;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists client_money_rules on public.ledger;
create trigger client_money_rules before insert on public.ledger
  for each row execute function app.client_money_rules();

-- ---------------------------------------------------------------------------
-- Files: ID documents need the switch, and every open is logged (page 10)
-- ---------------------------------------------------------------------------
create or replace function app.open_file(p_key text)
returns table (key text, bucket text, mime text, size bigint, sha256 text)
language plpgsql security invoker as $$
declare f public.files%rowtype;
begin
  select * into f from public.files where public.files.key = p_key and erased_at is null;  -- RLS applies
  if not found then
    raise exception 'REFUSED: no such file';
  end if;
  if f.bucket = 'id-copies' then
    perform app.log_security('file.id_view', jsonb_build_object('key', f.key, 'contact', f.record_id));
  end if;
  return query select f.key, f.bucket, f.mime, f.size, f.sha256;
end $$;

-- ---------------------------------------------------------------------------
-- Erasure on request (erase.js): the only lawful rewrite of the trail
-- ---------------------------------------------------------------------------
create or replace function app.erase_person(p_contact text, p_why text) returns integer
language plpgsql security definer set search_path = public, app as $$
declare n integer := 0; m integer;
begin
  if not app.aal2() or not app.can('handleRights') then
    raise exception 'REFUSED: erasure needs "Handle rights requests"';
  end if;
  if exists (select 1 from public.records where coll = 'legal_holds' and data ->> 'contact' = p_contact) then
    raise exception 'REFUSED: a legal hold is in place for this person';
  end if;
  perform set_config('app.lawful_rewrite', 'erasure', true);
  -- the contact record itself: keep the id and the fact of erasure, nothing else
  update public.records set data = jsonb_build_object('erased', true, 'erased_at', now())
   where coll = 'contacts' and id = p_contact;
  get diagnostics m = row_count; n := n + m;
  -- the change trail for that record: redacted, never deleted
  update public.changes set before = case when before is null then null else '{"erased":true}'::jsonb end,
                            after  = case when after  is null then null else '{"erased":true}'::jsonb end
   where coll = 'contacts' and rec_id = p_contact;
  get diagnostics m = row_count; n := n + m;
  -- files for the person are marked erased; the retention job removes the objects
  update public.files set erased_at = now() where record_coll = 'contacts' and record_id = p_contact and erased_at is null;
  get diagnostics m = row_count; n := n + m;
  insert into public.rights_requests (branch, kind, contact, handled_by, detail)
  values (app.my_branch(), 'erasure', p_contact, app.uid(), jsonb_build_object('why', p_why, 'rows', n));
  perform app.log_security('person.erased', jsonb_build_object('contact', p_contact, 'rows', n));
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Live changes: tell every API process, so more than one can run (page 18)
-- ---------------------------------------------------------------------------
create or replace function app.notify_change() returns trigger
language plpgsql as $$
begin
  perform pg_notify('nl_changes', jsonb_build_object(
    'branch', coalesce(new.branch, old.branch), 'coll', coalesce(new.coll, old.coll),
    'id', coalesce(new.id, old.id), 'rev', new.rev, 'op', lower(tg_op), 'by', app.uid())::text);
  return null;
end $$;
drop trigger if exists notify_change on public.records;
create trigger notify_change after insert or update or delete on public.records
  for each row execute function app.notify_change();

grant execute on all functions in schema app to authenticated, service_role;
revoke execute on function app.log_security(text, jsonb) from anon;
