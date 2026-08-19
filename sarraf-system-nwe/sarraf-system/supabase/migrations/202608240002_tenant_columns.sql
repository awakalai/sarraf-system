-- The tenant column, on every table that holds a business's own data.
--
-- Fifty-eight tables, one column each, one policy each. Generated from the list of tables the
-- migrations create rather than typed, because a table missed here is a table two businesses
-- share without knowing it — the single worst outcome this change exists to prevent.
-- 202608240004 asserts that none was missed.
--
-- The column defaults to the caller's own business, so an insert made by a signed-in person
-- stamps itself and a hundred call sites do not have to remember. A migration or service write
-- has no caller and leaves it null, which is visible to the manager alone — the safe direction to
-- fail in, and countable afterwards by sarraf_tenant_orphans.
--
-- **The tenant policy is RESTRICTIVE, and that is the whole of why this works.** PostgreSQL
-- combines permissive policies with OR: a permissive tenant policy would not narrow what a
-- customer may see, it would *widen* it to everything in their business, quietly undoing every
-- role rule this schema has. A restrictive policy is ANDed with the rest — you must be entitled
-- to the row by role, *and* it must belong to your business.
--
-- A restrictive policy alone grants nothing, so any table that had no permissive policy before
-- is given one that keeps its previous behaviour. Those tables were reachable by anyone with the
-- table grant; they still are, now within one business.
--
-- Deliberately absent: currencies and chart_of_accounts, which are definitions every business
-- shares, and app_users and tenants, which carry their tenancy already. Rates are a business's
-- own and are dealt with in 202608240005 — a rate is not a definition, it is a price, and two
-- businesses do not quote the same one.
begin;

alter table public.account_ledger add column if not exists tenant_id text references public.tenants(id);
alter table public.account_ledger alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_account_ledger_tenant on public.account_ledger(tenant_id);
alter table public.account_ledger enable row level security;

drop policy if exists account_ledger_tenant on public.account_ledger;
create policy account_ledger_tenant on public.account_ledger as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'account_ledger' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy account_ledger_open on public.account_ledger for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.account_transfers add column if not exists tenant_id text references public.tenants(id);
alter table public.account_transfers alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_account_transfers_tenant on public.account_transfers(tenant_id);
alter table public.account_transfers enable row level security;

drop policy if exists account_transfers_tenant on public.account_transfers;
create policy account_transfers_tenant on public.account_transfers as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'account_transfers' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy account_transfers_open on public.account_transfers for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.accounting_commands add column if not exists tenant_id text references public.tenants(id);
alter table public.accounting_commands alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_accounting_commands_tenant on public.accounting_commands(tenant_id);
alter table public.accounting_commands enable row level security;

drop policy if exists accounting_commands_tenant on public.accounting_commands;
create policy accounting_commands_tenant on public.accounting_commands as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'accounting_commands' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy accounting_commands_open on public.accounting_commands for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.approval_events add column if not exists tenant_id text references public.tenants(id);
alter table public.approval_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_approval_events_tenant on public.approval_events(tenant_id);
alter table public.approval_events enable row level security;

drop policy if exists approval_events_tenant on public.approval_events;
create policy approval_events_tenant on public.approval_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'approval_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy approval_events_open on public.approval_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.approval_requests add column if not exists tenant_id text references public.tenants(id);
alter table public.approval_requests alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_approval_requests_tenant on public.approval_requests(tenant_id);
alter table public.approval_requests enable row level security;

drop policy if exists approval_requests_tenant on public.approval_requests;
create policy approval_requests_tenant on public.approval_requests as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'approval_requests' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy approval_requests_open on public.approval_requests for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.audit add column if not exists tenant_id text references public.tenants(id);
alter table public.audit alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_audit_tenant on public.audit(tenant_id);
alter table public.audit enable row level security;

drop policy if exists audit_tenant on public.audit;
create policy audit_tenant on public.audit as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'audit' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy audit_open on public.audit for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.control_settings add column if not exists tenant_id text references public.tenants(id);
alter table public.control_settings alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_control_settings_tenant on public.control_settings(tenant_id);
alter table public.control_settings enable row level security;

drop policy if exists control_settings_tenant on public.control_settings;
create policy control_settings_tenant on public.control_settings as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'control_settings' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy control_settings_open on public.control_settings for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.customer_vault_events add column if not exists tenant_id text references public.tenants(id);
alter table public.customer_vault_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_customer_vault_events_tenant on public.customer_vault_events(tenant_id);
alter table public.customer_vault_events enable row level security;

drop policy if exists customer_vault_events_tenant on public.customer_vault_events;
create policy customer_vault_events_tenant on public.customer_vault_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'customer_vault_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy customer_vault_events_open on public.customer_vault_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.customer_vaults add column if not exists tenant_id text references public.tenants(id);
alter table public.customer_vaults alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_customer_vaults_tenant on public.customer_vaults(tenant_id);
alter table public.customer_vaults enable row level security;

drop policy if exists customer_vaults_tenant on public.customer_vaults;
create policy customer_vaults_tenant on public.customer_vaults as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'customer_vaults' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy customer_vaults_open on public.customer_vaults for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.day_closes add column if not exists tenant_id text references public.tenants(id);
alter table public.day_closes alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_day_closes_tenant on public.day_closes(tenant_id);
alter table public.day_closes enable row level security;

drop policy if exists day_closes_tenant on public.day_closes;
create policy day_closes_tenant on public.day_closes as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'day_closes' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy day_closes_open on public.day_closes for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.debt_events add column if not exists tenant_id text references public.tenants(id);
alter table public.debt_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_debt_events_tenant on public.debt_events(tenant_id);
alter table public.debt_events enable row level security;

drop policy if exists debt_events_tenant on public.debt_events;
create policy debt_events_tenant on public.debt_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'debt_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy debt_events_open on public.debt_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.debt_settlements add column if not exists tenant_id text references public.tenants(id);
alter table public.debt_settlements alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_debt_settlements_tenant on public.debt_settlements(tenant_id);
alter table public.debt_settlements enable row level security;

drop policy if exists debt_settlements_tenant on public.debt_settlements;
create policy debt_settlements_tenant on public.debt_settlements as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'debt_settlements' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy debt_settlements_open on public.debt_settlements for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.debts add column if not exists tenant_id text references public.tenants(id);
alter table public.debts alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_debts_tenant on public.debts(tenant_id);
alter table public.debts enable row level security;

drop policy if exists debts_tenant on public.debts;
create policy debts_tenant on public.debts as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'debts' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy debts_open on public.debts for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.financial_commands add column if not exists tenant_id text references public.tenants(id);
alter table public.financial_commands alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_financial_commands_tenant on public.financial_commands(tenant_id);
alter table public.financial_commands enable row level security;

drop policy if exists financial_commands_tenant on public.financial_commands;
create policy financial_commands_tenant on public.financial_commands as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'financial_commands' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy financial_commands_open on public.financial_commands for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.journal_entries add column if not exists tenant_id text references public.tenants(id);
alter table public.journal_entries alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_journal_entries_tenant on public.journal_entries(tenant_id);
alter table public.journal_entries enable row level security;

drop policy if exists journal_entries_tenant on public.journal_entries;
create policy journal_entries_tenant on public.journal_entries as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'journal_entries' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy journal_entries_open on public.journal_entries for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.journal_lines add column if not exists tenant_id text references public.tenants(id);
alter table public.journal_lines alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_journal_lines_tenant on public.journal_lines(tenant_id);
alter table public.journal_lines enable row level security;

drop policy if exists journal_lines_tenant on public.journal_lines;
create policy journal_lines_tenant on public.journal_lines as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'journal_lines' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy journal_lines_open on public.journal_lines for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.ledger add column if not exists tenant_id text references public.tenants(id);
alter table public.ledger alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_ledger_tenant on public.ledger(tenant_id);
alter table public.ledger enable row level security;

drop policy if exists ledger_tenant on public.ledger;
create policy ledger_tenant on public.ledger as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'ledger' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy ledger_open on public.ledger for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.notes add column if not exists tenant_id text references public.tenants(id);
alter table public.notes alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_notes_tenant on public.notes(tenant_id);
alter table public.notes enable row level security;

drop policy if exists notes_tenant on public.notes;
create policy notes_tenant on public.notes as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'notes' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy notes_open on public.notes for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.ocr_attestations add column if not exists tenant_id text references public.tenants(id);
alter table public.ocr_attestations alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_ocr_attestations_tenant on public.ocr_attestations(tenant_id);
alter table public.ocr_attestations enable row level security;

drop policy if exists ocr_attestations_tenant on public.ocr_attestations;
create policy ocr_attestations_tenant on public.ocr_attestations as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'ocr_attestations' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy ocr_attestations_open on public.ocr_attestations for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.office_payment_assignments add column if not exists tenant_id text references public.tenants(id);
alter table public.office_payment_assignments alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_office_payment_assignments_tenant on public.office_payment_assignments(tenant_id);
alter table public.office_payment_assignments enable row level security;

drop policy if exists office_payment_assignments_tenant on public.office_payment_assignments;
create policy office_payment_assignments_tenant on public.office_payment_assignments as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'office_payment_assignments' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy office_payment_assignments_open on public.office_payment_assignments for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.office_payment_events add column if not exists tenant_id text references public.tenants(id);
alter table public.office_payment_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_office_payment_events_tenant on public.office_payment_events(tenant_id);
alter table public.office_payment_events enable row level security;

drop policy if exists office_payment_events_tenant on public.office_payment_events;
create policy office_payment_events_tenant on public.office_payment_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'office_payment_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy office_payment_events_open on public.office_payment_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.office_payment_evidence add column if not exists tenant_id text references public.tenants(id);
alter table public.office_payment_evidence alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_office_payment_evidence_tenant on public.office_payment_evidence(tenant_id);
alter table public.office_payment_evidence enable row level security;

drop policy if exists office_payment_evidence_tenant on public.office_payment_evidence;
create policy office_payment_evidence_tenant on public.office_payment_evidence as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'office_payment_evidence' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy office_payment_evidence_open on public.office_payment_evidence for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.office_pending_assignments add column if not exists tenant_id text references public.tenants(id);
alter table public.office_pending_assignments alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_office_pending_assignments_tenant on public.office_pending_assignments(tenant_id);
alter table public.office_pending_assignments enable row level security;

drop policy if exists office_pending_assignments_tenant on public.office_pending_assignments;
create policy office_pending_assignments_tenant on public.office_pending_assignments as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'office_pending_assignments' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy office_pending_assignments_open on public.office_pending_assignments for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.partner_account_events add column if not exists tenant_id text references public.tenants(id);
alter table public.partner_account_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_partner_account_events_tenant on public.partner_account_events(tenant_id);
alter table public.partner_account_events enable row level security;

drop policy if exists partner_account_events_tenant on public.partner_account_events;
create policy partner_account_events_tenant on public.partner_account_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'partner_account_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy partner_account_events_open on public.partner_account_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.partner_accounts add column if not exists tenant_id text references public.tenants(id);
alter table public.partner_accounts alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_partner_accounts_tenant on public.partner_accounts(tenant_id);
alter table public.partner_accounts enable row level security;

drop policy if exists partner_accounts_tenant on public.partner_accounts;
create policy partner_accounts_tenant on public.partner_accounts as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'partner_accounts' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy partner_accounts_open on public.partner_accounts for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.rate_history add column if not exists tenant_id text references public.tenants(id);
alter table public.rate_history alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_rate_history_tenant on public.rate_history(tenant_id);
alter table public.rate_history enable row level security;

drop policy if exists rate_history_tenant on public.rate_history;
create policy rate_history_tenant on public.rate_history as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'rate_history' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy rate_history_open on public.rate_history for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.rate_limit_counters add column if not exists tenant_id text references public.tenants(id);
alter table public.rate_limit_counters alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_rate_limit_counters_tenant on public.rate_limit_counters(tenant_id);
alter table public.rate_limit_counters enable row level security;

drop policy if exists rate_limit_counters_tenant on public.rate_limit_counters;
create policy rate_limit_counters_tenant on public.rate_limit_counters as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'rate_limit_counters' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy rate_limit_counters_open on public.rate_limit_counters for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_assignment_events add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_assignment_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_assignment_events_tenant on public.receipt_assignment_events(tenant_id);
alter table public.receipt_assignment_events enable row level security;

drop policy if exists receipt_assignment_events_tenant on public.receipt_assignment_events;
create policy receipt_assignment_events_tenant on public.receipt_assignment_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_assignment_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_assignment_events_open on public.receipt_assignment_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_audit_events add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_audit_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_audit_events_tenant on public.receipt_audit_events(tenant_id);
alter table public.receipt_audit_events enable row level security;

drop policy if exists receipt_audit_events_tenant on public.receipt_audit_events;
create policy receipt_audit_events_tenant on public.receipt_audit_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_audit_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_audit_events_open on public.receipt_audit_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_batch_transactions add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_batch_transactions alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_batch_transactions_tenant on public.receipt_batch_transactions(tenant_id);
alter table public.receipt_batch_transactions enable row level security;

drop policy if exists receipt_batch_transactions_tenant on public.receipt_batch_transactions;
create policy receipt_batch_transactions_tenant on public.receipt_batch_transactions as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_batch_transactions' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_batch_transactions_open on public.receipt_batch_transactions for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_batches add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_batches alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_batches_tenant on public.receipt_batches(tenant_id);
alter table public.receipt_batches enable row level security;

drop policy if exists receipt_batches_tenant on public.receipt_batches;
create policy receipt_batches_tenant on public.receipt_batches as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_batches' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_batches_open on public.receipt_batches for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_command_log add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_command_log alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_command_log_tenant on public.receipt_command_log(tenant_id);
alter table public.receipt_command_log enable row level security;

drop policy if exists receipt_command_log_tenant on public.receipt_command_log;
create policy receipt_command_log_tenant on public.receipt_command_log as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_command_log' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_command_log_open on public.receipt_command_log for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_control_policy add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_control_policy alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_control_policy_tenant on public.receipt_control_policy(tenant_id);
alter table public.receipt_control_policy enable row level security;

drop policy if exists receipt_control_policy_tenant on public.receipt_control_policy;
create policy receipt_control_policy_tenant on public.receipt_control_policy as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_control_policy' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_control_policy_open on public.receipt_control_policy for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_custody add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_custody alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_custody_tenant on public.receipt_custody(tenant_id);
alter table public.receipt_custody enable row level security;

drop policy if exists receipt_custody_tenant on public.receipt_custody;
create policy receipt_custody_tenant on public.receipt_custody as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_custody' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_custody_open on public.receipt_custody for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_custody_events add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_custody_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_custody_events_tenant on public.receipt_custody_events(tenant_id);
alter table public.receipt_custody_events enable row level security;

drop policy if exists receipt_custody_events_tenant on public.receipt_custody_events;
create policy receipt_custody_events_tenant on public.receipt_custody_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_custody_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_custody_events_open on public.receipt_custody_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_custody_ledger add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_custody_ledger alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_custody_ledger_tenant on public.receipt_custody_ledger(tenant_id);
alter table public.receipt_custody_ledger enable row level security;

drop policy if exists receipt_custody_ledger_tenant on public.receipt_custody_ledger;
create policy receipt_custody_ledger_tenant on public.receipt_custody_ledger as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_custody_ledger' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_custody_ledger_open on public.receipt_custody_ledger for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_daily_rates add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_daily_rates alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_daily_rates_tenant on public.receipt_daily_rates(tenant_id);
alter table public.receipt_daily_rates enable row level security;

drop policy if exists receipt_daily_rates_tenant on public.receipt_daily_rates;
create policy receipt_daily_rates_tenant on public.receipt_daily_rates as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_daily_rates' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_daily_rates_open on public.receipt_daily_rates for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_documents add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_documents alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_documents_tenant on public.receipt_documents(tenant_id);
alter table public.receipt_documents enable row level security;

drop policy if exists receipt_documents_tenant on public.receipt_documents;
create policy receipt_documents_tenant on public.receipt_documents as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_documents' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_documents_open on public.receipt_documents for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_extractions add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_extractions alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_extractions_tenant on public.receipt_extractions(tenant_id);
alter table public.receipt_extractions enable row level security;

drop policy if exists receipt_extractions_tenant on public.receipt_extractions;
create policy receipt_extractions_tenant on public.receipt_extractions as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_extractions' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_extractions_open on public.receipt_extractions for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_forwardings add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_forwardings alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_forwardings_tenant on public.receipt_forwardings(tenant_id);
alter table public.receipt_forwardings enable row level security;

drop policy if exists receipt_forwardings_tenant on public.receipt_forwardings;
create policy receipt_forwardings_tenant on public.receipt_forwardings as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_forwardings' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_forwardings_open on public.receipt_forwardings for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_ingestion_authorizations add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_ingestion_authorizations alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_ingestion_authorizations_tenant on public.receipt_ingestion_authorizations(tenant_id);
alter table public.receipt_ingestion_authorizations enable row level security;

drop policy if exists receipt_ingestion_authorizations_tenant on public.receipt_ingestion_authorizations;
create policy receipt_ingestion_authorizations_tenant on public.receipt_ingestion_authorizations as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_ingestion_authorizations' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_ingestion_authorizations_open on public.receipt_ingestion_authorizations for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_ingestion_commands add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_ingestion_commands alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_ingestion_commands_tenant on public.receipt_ingestion_commands(tenant_id);
alter table public.receipt_ingestion_commands enable row level security;

drop policy if exists receipt_ingestion_commands_tenant on public.receipt_ingestion_commands;
create policy receipt_ingestion_commands_tenant on public.receipt_ingestion_commands as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_ingestion_commands' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_ingestion_commands_open on public.receipt_ingestion_commands for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_intake_items add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_intake_items alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_intake_items_tenant on public.receipt_intake_items(tenant_id);
alter table public.receipt_intake_items enable row level security;

drop policy if exists receipt_intake_items_tenant on public.receipt_intake_items;
create policy receipt_intake_items_tenant on public.receipt_intake_items as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_intake_items' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_intake_items_open on public.receipt_intake_items for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_match_commands add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_match_commands alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_match_commands_tenant on public.receipt_match_commands(tenant_id);
alter table public.receipt_match_commands enable row level security;

drop policy if exists receipt_match_commands_tenant on public.receipt_match_commands;
create policy receipt_match_commands_tenant on public.receipt_match_commands as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_match_commands' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_match_commands_open on public.receipt_match_commands for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_notifications add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_notifications alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_notifications_tenant on public.receipt_notifications(tenant_id);
alter table public.receipt_notifications enable row level security;

drop policy if exists receipt_notifications_tenant on public.receipt_notifications;
create policy receipt_notifications_tenant on public.receipt_notifications as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_notifications' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_notifications_open on public.receipt_notifications for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_ocr_attempts add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_ocr_attempts alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_ocr_attempts_tenant on public.receipt_ocr_attempts(tenant_id);
alter table public.receipt_ocr_attempts enable row level security;

drop policy if exists receipt_ocr_attempts_tenant on public.receipt_ocr_attempts;
create policy receipt_ocr_attempts_tenant on public.receipt_ocr_attempts as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_ocr_attempts' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_ocr_attempts_open on public.receipt_ocr_attempts for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_operation_commands add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_operation_commands alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_operation_commands_tenant on public.receipt_operation_commands(tenant_id);
alter table public.receipt_operation_commands enable row level security;

drop policy if exists receipt_operation_commands_tenant on public.receipt_operation_commands;
create policy receipt_operation_commands_tenant on public.receipt_operation_commands as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_operation_commands' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_operation_commands_open on public.receipt_operation_commands for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_pending_conversions add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_pending_conversions alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_pending_conversions_tenant on public.receipt_pending_conversions(tenant_id);
alter table public.receipt_pending_conversions enable row level security;

drop policy if exists receipt_pending_conversions_tenant on public.receipt_pending_conversions;
create policy receipt_pending_conversions_tenant on public.receipt_pending_conversions as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_pending_conversions' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_pending_conversions_open on public.receipt_pending_conversions for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_review_commands add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_review_commands alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_review_commands_tenant on public.receipt_review_commands(tenant_id);
alter table public.receipt_review_commands enable row level security;

drop policy if exists receipt_review_commands_tenant on public.receipt_review_commands;
create policy receipt_review_commands_tenant on public.receipt_review_commands as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_review_commands' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_review_commands_open on public.receipt_review_commands for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_state_transitions add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_state_transitions alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_state_transitions_tenant on public.receipt_state_transitions(tenant_id);
alter table public.receipt_state_transitions enable row level security;

drop policy if exists receipt_state_transitions_tenant on public.receipt_state_transitions;
create policy receipt_state_transitions_tenant on public.receipt_state_transitions as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_state_transitions' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_state_transitions_open on public.receipt_state_transitions for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_transaction_assignments add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_transaction_assignments alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_transaction_assignments_tenant on public.receipt_transaction_assignments(tenant_id);
alter table public.receipt_transaction_assignments enable row level security;

drop policy if exists receipt_transaction_assignments_tenant on public.receipt_transaction_assignments;
create policy receipt_transaction_assignments_tenant on public.receipt_transaction_assignments as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_transaction_assignments' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_transaction_assignments_open on public.receipt_transaction_assignments for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipts add column if not exists tenant_id text references public.tenants(id);
alter table public.receipts alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipts_tenant on public.receipts(tenant_id);
alter table public.receipts enable row level security;

drop policy if exists receipts_tenant on public.receipts;
create policy receipts_tenant on public.receipts as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipts' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipts_open on public.receipts for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.system_event_log add column if not exists tenant_id text references public.tenants(id);
alter table public.system_event_log alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_system_event_log_tenant on public.system_event_log(tenant_id);
alter table public.system_event_log enable row level security;

drop policy if exists system_event_log_tenant on public.system_event_log;
create policy system_event_log_tenant on public.system_event_log as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'system_event_log' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy system_event_log_open on public.system_event_log for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.transaction_payment_events add column if not exists tenant_id text references public.tenants(id);
alter table public.transaction_payment_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_transaction_payment_events_tenant on public.transaction_payment_events(tenant_id);
alter table public.transaction_payment_events enable row level security;

drop policy if exists transaction_payment_events_tenant on public.transaction_payment_events;
create policy transaction_payment_events_tenant on public.transaction_payment_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'transaction_payment_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy transaction_payment_events_open on public.transaction_payment_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.tx_versions add column if not exists tenant_id text references public.tenants(id);
alter table public.tx_versions alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_tx_versions_tenant on public.tx_versions(tenant_id);
alter table public.tx_versions enable row level security;

drop policy if exists tx_versions_tenant on public.tx_versions;
create policy tx_versions_tenant on public.tx_versions as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'tx_versions' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy tx_versions_open on public.tx_versions for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.txs add column if not exists tenant_id text references public.tenants(id);
alter table public.txs alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_txs_tenant on public.txs(tenant_id);
alter table public.txs enable row level security;

drop policy if exists txs_tenant on public.txs;
create policy txs_tenant on public.txs as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'txs' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy txs_open on public.txs for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.voucher_counters add column if not exists tenant_id text references public.tenants(id);
alter table public.voucher_counters alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_voucher_counters_tenant on public.voucher_counters(tenant_id);
alter table public.voucher_counters enable row level security;

drop policy if exists voucher_counters_tenant on public.voucher_counters;
create policy voucher_counters_tenant on public.voucher_counters as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'voucher_counters' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy voucher_counters_open on public.voucher_counters for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.vouchers add column if not exists tenant_id text references public.tenants(id);
alter table public.vouchers alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_vouchers_tenant on public.vouchers(tenant_id);
alter table public.vouchers enable row level security;

drop policy if exists vouchers_tenant on public.vouchers;
create policy vouchers_tenant on public.vouchers as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'vouchers' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy vouchers_open on public.vouchers for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

commit;
