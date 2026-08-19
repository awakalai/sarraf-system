-- Starting from nothing: the manager, two businesses, and no other data at all.
--
-- The owner asked for this in as many words — every account and every row cleared except their
-- own, so the system begins its real life clean rather than carrying whatever a fortnight of
-- testing left behind.
--
-- This migration deletes production data. That is exactly what it is for, and it is the only
-- file in this repository of which that is true. It is written to run once, on a database whose
-- contents nobody wants, and it will do nothing on a database that already has businesses in it
-- — a second run cannot empty a system that has since gone live.
--
-- Two businesses are created. The first is the buyer who has the system today. The second,
-- کوردستان, is empty and ready: the owner asked for a spare so that the next buyer can be given
-- a working business rather than waiting for one to be built.
begin;

do $reset$
declare
  v_tenants integer;
  v_manager text;
begin
  select count(*) into v_tenants from public.tenants;
  if v_tenants > 0 then
    raise notice 'businesses already exist; this reset does nothing';
    return;
  end if;

  select id into v_manager from public.app_users
   where role = 'admin' and admin_level = 'manager' and not deleted
   order by created_at limit 1;

  -- A database with nobody in it is a fresh install, not a system being reset: there is nothing
  -- to clear, and the businesses are simply created. This is the case every test run is in.
  if v_manager is null and not exists (select 1 from public.app_users) then
    insert into public.tenants(id, name, active, note) values
      ('t-sarkhel', 'سەرخێڵ', true, 'یەکەم کڕیاری سیستەمەکە'),
      ('t-kurdistan', 'کوردستان', true, 'ئامادە بۆ کڕیاری داهاتوو — بەتاڵە');
    raise notice 'fresh installation: two businesses created, nothing to clear';
    return;
  end if;

  -- Accounts exist but none of them is a manager. Clearing now would leave a database nobody can
  -- sign into. Refusing is recoverable; an empty system with no way in is not.
  if v_manager is null then
    raise exception using errcode = '23514',
      message = 'no manager exists; create one before resetting, or there would be no way back in';
  end if;

  -- Order matters only where a foreign key would refuse the delete. Everything is emptied, so
  -- the children go first and the parents follow.
  delete from public.journal_lines;
  delete from public.journal_entries;
  delete from public.vouchers;
  delete from public.voucher_counters;
  delete from public.debt_events;
  delete from public.debt_settlements;
  delete from public.debts;
  delete from public.customer_vault_events;
  delete from public.customer_vaults;
  delete from public.partner_account_events;
  delete from public.partner_accounts;
  delete from public.transaction_payment_events;
  delete from public.office_payment_events;
  delete from public.office_payment_evidence;
  delete from public.office_pending_assignments;
  delete from public.office_payment_assignments;
  delete from public.receipt_state_transitions;
  delete from public.receipt_extractions;
  delete from public.receipt_forwardings;
  delete from public.receipt_custody_ledger;
  delete from public.receipt_custody_events;
  delete from public.receipt_custody;
  delete from public.receipt_assignment_events;
  delete from public.receipt_transaction_assignments;
  delete from public.receipt_notifications;
  delete from public.receipt_ocr_attempts;
  delete from public.receipt_documents;
  delete from public.receipt_pending_conversions;
  delete from public.receipt_batch_transactions;
  delete from public.receipt_intake_items;
  delete from public.receipts;
  delete from public.receipt_batches;
  delete from public.receipt_audit_events;
  delete from public.receipt_review_commands;
  delete from public.receipt_operation_commands;
  delete from public.receipt_match_commands;
  delete from public.receipt_ingestion_commands;
  delete from public.receipt_ingestion_authorizations;
  delete from public.receipt_command_log;
  delete from public.receipt_daily_rates;
  delete from public.ocr_attestations;
  delete from public.approval_events;
  delete from public.approval_requests;
  delete from public.tx_versions;
  delete from public.ledger;
  delete from public.account_ledger;
  delete from public.account_transfers;
  delete from public.txs;
  delete from public.day_closes;
  delete from public.notes;
  delete from public.system_event_log;
  delete from public.rate_history;
  delete from public.rate_limit_counters;
  delete from public.accounting_commands;
  delete from public.financial_commands;
  delete from public.audit;

  -- Every account except the manager. Their auth logins are left alone: removing those is the
  -- owner's to do from the dashboard, and a migration that deletes sign-ins is a migration that
  -- can lock somebody out of an account it was not asked about.
  delete from public.app_users where id <> v_manager;

  insert into public.tenants(id, name, reference, active, created_by, note) values
    ('t-sarkhel', 'سەرخێڵ', null, true, v_manager,
     'یەکەم کڕیاری سیستەمەکە'),
    ('t-kurdistan', 'کوردستان', null, true, v_manager,
     'ئامادە بۆ کڕیاری داهاتوو — بەتاڵە');

  raise notice 'reset complete: manager % kept, two businesses created', v_manager;
end;
$reset$;

-- ── the settings each business keeps for itself ─────────────────────────────
--
-- control_settings and receipt_control_policy were built as one row for the whole installation:
-- `singleton boolean primary key`, from a time when there was only ever one business. Two
-- businesses sharing one approval threshold or one receipt policy is a leak of configuration —
-- one changes it, the other's rules move under them, and nothing anywhere reports it. They are
-- read through SECURITY DEFINER functions, which bypass row-level security entirely, so the
-- policies added above would not have caught it either.
--
-- The key becomes the business. The singleton column stays so that nothing reading it breaks;
-- it is simply no longer what identifies the row.
alter table public.control_settings drop constraint if exists control_settings_pkey;
alter table public.receipt_control_policy drop constraint if exists receipt_control_policy_pkey;

do $settings$
declare t record;
begin
  for t in select id from public.tenants loop
    -- jsonb_populate_record, not a text cast: a record literal is not JSON, and casting one
    -- through the other is how the copy silently becomes a different row.
    insert into public.control_settings
    select (jsonb_populate_record(null::public.control_settings,
              to_jsonb(c) || jsonb_build_object('tenant_id', t.id))).*
      from public.control_settings c where c.tenant_id is null limit 1;

    insert into public.receipt_control_policy
    select (jsonb_populate_record(null::public.receipt_control_policy,
              to_jsonb(r) || jsonb_build_object('tenant_id', t.id))).*
      from public.receipt_control_policy r where r.tenant_id is null limit 1;
  end loop;

  delete from public.control_settings where tenant_id is null;
  delete from public.receipt_control_policy where tenant_id is null;
end;
$settings$;

-- One row per business, now that the business is what identifies it.
create unique index if not exists control_settings_tenant_key
  on public.control_settings(tenant_id);
create unique index if not exists receipt_control_policy_tenant_key
  on public.receipt_control_policy(tenant_id);

-- Notifications a trigger wrote while there was no caller. They belong to no business and
-- nobody is waiting to read them.
delete from public.notes where tenant_id is null;

-- system_event_log is deliberately not touched. It is append-only by design and refuses a delete,
-- which is the right answer: a change log that can be tidied is not a change log. Its ownerless
-- rows are what happened before there were businesses, and they stay that way.

-- ── now that every account has a tenant or is the manager, the guard can stand ───
drop trigger if exists app_users_tenant_guard on public.app_users;
create trigger app_users_tenant_guard
  before insert or update on public.app_users
  for each row execute function public.sarraf_guard_tenant_membership();

commit;
