-- The drift report should name tables, not only columns.
--
-- Asked to count the rows in public.account_moves the owner got `relation does not exist`, and
-- the table had been in a schema read of the same database a few days earlier. Neither it nor
-- public.backups is created by any migration in this repository: both existed in the live
-- database only, one has since gone, and nothing anywhere could have said so.
--
-- That is the same fault that produced the audit.user_id and receipts.tx_date failures, one
-- level up. sarraf_schema_drift compares columns the code depends on; it had nothing to say
-- about whole tables, so a table the repository does not know about was invisible in both
-- directions — present in the database and unmanaged, or expected by the code and absent.
--
-- The expected list is generated from the migrations rather than typed, so it cannot fall behind
-- them. Regenerate it whenever tables are added:
--
--   grep -hoiE 'create table (if not exists )?public\.\w+' supabase/migrations/*.sql \
--     | sed -E 's/.*public\.//' | sort -u
--
-- Reports; never repairs. An unmanaged table may hold something nobody has looked at in a year,
-- and a migration that drops what it was not told about is how that is lost for good.
begin;

create or replace function public.sarraf_schema_tables()
returns table(table_name text, state text)
language sql
stable
set search_path = pg_catalog, public
as $$
  with expected(t) as (values
    ('account_ledger'), ('account_transfers'), ('accounting_commands'), ('app_users'),
    ('approval_events'), ('approval_requests'), ('audit'), ('chart_of_accounts'),
    ('control_settings'), ('currencies'), ('customer_vault_events'), ('customer_vaults'),
    ('day_closes'), ('debt_events'), ('debt_settlements'), ('debts'), ('financial_commands'),
    ('journal_entries'), ('journal_lines'), ('ledger'), ('notes'), ('ocr_attestations'),
    ('office_payment_assignments'), ('office_payment_events'), ('office_payment_evidence'),
    ('office_pending_assignments'), ('partner_account_events'), ('partner_accounts'),
    ('rate_history'), ('rate_limit_counters'), ('receipt_assignment_events'),
    ('receipt_audit_events'), ('receipt_batch_transactions'), ('receipt_batches'),
    ('receipt_command_log'), ('receipt_control_policy'), ('receipt_custody'),
    ('receipt_custody_events'), ('receipt_custody_ledger'), ('receipt_daily_rates'),
    ('receipt_documents'), ('receipt_extractions'), ('receipt_forwardings'),
    ('receipt_ingestion_authorizations'), ('receipt_ingestion_commands'),
    ('receipt_intake_items'), ('receipt_match_commands'), ('receipt_notifications'),
    ('receipt_ocr_attempts'), ('receipt_operation_commands'), ('receipt_pending_conversions'),
    ('receipt_review_commands'), ('receipt_state_transitions'),
    ('receipt_transaction_assignments'), ('receipts'), ('system_event_log'),
    ('tenant_rates'), ('tenants'),
    ('transaction_payment_events'), ('tx_versions'), ('txs'), ('voucher_counters'), ('vouchers')
  ), live as (
    select c.table_name::text as t
    from information_schema.tables c
    where c.table_schema = 'public' and c.table_type = 'BASE TABLE'
  )
  -- A table the code builds on and the database has not got. This is the shape of failure that
  -- reaches a person as an error on a screen.
  select e.t, 'missing from the database'
  from expected e where not exists (select 1 from live l where l.t = e.t)
  union all
  -- A table the database has and no migration creates. Not an error, and not necessarily
  -- rubbish — but nothing in this repository maintains it, and nobody should discover that by
  -- querying it.
  select l.t, 'in the database, unmanaged by any migration'
  from live l where not exists (select 1 from expected e where e.t = l.t)
  order by 2, 1;
$$;

grant execute on function public.sarraf_schema_tables() to authenticated;

-- One call for both halves, so a person checking a deployment runs a single query and reads a
-- single answer rather than remembering there were two.
create or replace function public.sarraf_schema_report()
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'columns', coalesce((select jsonb_agg(to_jsonb(d)) from public.sarraf_schema_drift() d), '[]'::jsonb),
    'tables', coalesce((select jsonb_agg(to_jsonb(t)) from public.sarraf_schema_tables() t), '[]'::jsonb),
    'checked_at', statement_timestamp());
$$;

grant execute on function public.sarraf_schema_report() to authenticated;

commit;
