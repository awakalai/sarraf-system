-- ZEMAN reproducible legacy baseline.
--
-- The application originally shipped with five tables in `supabase_schema.sql` while the
-- production database accumulated the rest manually.  Every later migration therefore
-- depended on objects that a clean deployment could not create.  This migration records that
-- pre-migration surface without replacing, truncating or deleting any existing object/data.
-- Existing installations keep their rows; clean installations get the same starting contract.

begin;

create table if not exists public.currencies (
  id text primary key,
  code text not null unique,
  name text not null,
  symbol text,
  dec integer not null default 2,
  external boolean not null default false,
  buy_rate numeric(38,10),
  sell_rate numeric(38,10),
  rate_updated timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  check (dec between 0 and 10),
  check (buy_rate is null or buy_rate > 0),
  check (sell_rate is null or sell_rate > 0)
);

create table if not exists public.app_users (
  id text primary key,
  auth_id uuid unique,
  name text not null,
  role text not null check (role in ('admin','customer','partner','investor','office')),
  admin_level text check (admin_level is null or admin_level in ('owner','operator')),
  rate numeric(20,8) not null default 0,
  scope_curs text[] not null default '{}'::text[],
  phone text,
  address text,
  note text,
  deleted boolean not null default false,
  created_at timestamptz not null default statement_timestamp(),
  check (rate >= 0 and rate <= 100)
);

-- Compatibility columns are additive because some production databases were created from an
-- older copy of supabase_schema.sql.
alter table public.currencies add column if not exists external boolean not null default false;
alter table public.currencies add column if not exists buy_rate numeric(38,10);
alter table public.currencies add column if not exists sell_rate numeric(38,10);
alter table public.currencies add column if not exists rate_updated timestamptz;
alter table public.currencies add column if not exists created_at timestamptz not null default statement_timestamp();
alter table public.app_users add column if not exists admin_level text;
alter table public.app_users add column if not exists scope_curs text[] not null default '{}'::text[];
alter table public.app_users add column if not exists created_at timestamptz not null default statement_timestamp();

create table if not exists public.txs (
  id text primary key,
  code integer unique,
  type text not null check (type in ('buy','sell')),
  cp_id text references public.app_users(id),
  cp_name text,
  cur_id text not null references public.currencies(id),
  amount numeric(38,10) not null check (amount > 0),
  rate numeric(38,12) not null check (rate > 0),
  against_id text not null references public.currencies(id),
  total numeric(38,10) not null check (total > 0),
  partner_id text references public.app_users(id),
  status text not null default 'completed' check (status in ('completed','pending')),
  paid_at timestamptz,
  profit numeric(38,10),
  profit_cur_id text references public.currencies(id),
  note text,
  date timestamptz not null default statement_timestamp(),
  edited boolean not null default false,
  deleted boolean not null default false,
  direct boolean not null default false,
  pair_id text,
  direct_role text,
  own_money boolean not null default false,
  buy_rate numeric(38,10),
  buy_total numeric(38,10),
  cost_basis_usd numeric(38,10),
  partner_rate_snapshot numeric(20,8),
  partner_fee_snapshot numeric(38,10),
  version_no bigint not null default 1,
  last_approval_id text,
  created_at timestamptz not null default statement_timestamp(),
  check (cur_id <> against_id)
);

alter table public.txs add column if not exists cost_basis_usd numeric(38,10);
alter table public.txs add column if not exists partner_rate_snapshot numeric(20,8);
alter table public.txs add column if not exists partner_fee_snapshot numeric(38,10);
alter table public.txs add column if not exists version_no bigint not null default 1;
alter table public.txs add column if not exists last_approval_id text;
alter table public.txs add column if not exists created_at timestamptz not null default statement_timestamp();

create table if not exists public.ledger (
  id text primary key,
  type text not null,
  owner text,
  investor_id text references public.app_users(id),
  cur_id text not null references public.currencies(id),
  amount numeric(38,10) not null check (amount <> 0),
  partner_id text references public.app_users(id),
  tx_id text references public.txs(id),
  note text,
  date timestamptz not null default statement_timestamp(),
  reversal_of text references public.ledger(id),
  command_key text,
  created_by text references public.app_users(id),
  approval_id text,
  commission_rate_snapshot numeric(20,8),
  commission_amount_snapshot numeric(38,10),
  created_at timestamptz not null default statement_timestamp()
);

alter table public.ledger add column if not exists reversal_of text references public.ledger(id);
alter table public.ledger add column if not exists command_key text;
alter table public.ledger add column if not exists created_by text references public.app_users(id);
alter table public.ledger add column if not exists approval_id text;
alter table public.ledger add column if not exists commission_rate_snapshot numeric(20,8);
alter table public.ledger add column if not exists commission_amount_snapshot numeric(38,10);
alter table public.ledger add column if not exists created_at timestamptz not null default statement_timestamp();

create table if not exists public.account_ledger (
  id text primary key,
  user_id text not null references public.app_users(id),
  kind text not null,
  cur_id text not null references public.currencies(id),
  amount numeric(38,10) not null check (amount <> 0),
  type text not null,
  ref_id text,
  note text,
  reversal_of text references public.account_ledger(id),
  command_key text,
  created_by text references public.app_users(id),
  approval_id text,
  created_at timestamptz not null default statement_timestamp()
);

-- Some live databases already have the account tables, but only with the columns that the
-- original single-file schema happened to use.  Keep the upgrade additive and make every
-- column consumed by the command RPCs explicit before the later migrations compile.
alter table public.account_ledger add column if not exists ref_id text;
alter table public.account_ledger add column if not exists note text;
alter table public.account_ledger add column if not exists reversal_of text references public.account_ledger(id);
alter table public.account_ledger add column if not exists command_key text;
alter table public.account_ledger add column if not exists created_by text references public.app_users(id);
alter table public.account_ledger add column if not exists approval_id text;
alter table public.account_ledger add column if not exists created_at timestamptz not null default statement_timestamp();

create table if not exists public.account_transfers (
  id text primary key,
  from_id text references public.app_users(id),
  from_name text,
  to_id text references public.app_users(id),
  to_name text,
  cur_id text not null references public.currencies(id),
  amount numeric(38,10) not null check (amount > 0),
  out_entry_id text references public.account_ledger(id),
  in_entry_id text references public.account_ledger(id),
  note text,
  command_key text,
  created_by text references public.app_users(id),
  approval_id text,
  created_at timestamptz not null default statement_timestamp(),
  check (from_id is distinct from to_id)
);

alter table public.account_transfers add column if not exists from_id text references public.app_users(id);
alter table public.account_transfers add column if not exists from_name text;
alter table public.account_transfers add column if not exists to_id text references public.app_users(id);
alter table public.account_transfers add column if not exists to_name text;
alter table public.account_transfers add column if not exists out_entry_id text references public.account_ledger(id);
alter table public.account_transfers add column if not exists in_entry_id text references public.account_ledger(id);
alter table public.account_transfers add column if not exists note text;
alter table public.account_transfers add column if not exists command_key text;
alter table public.account_transfers add column if not exists created_by text references public.app_users(id);
alter table public.account_transfers add column if not exists approval_id text;
alter table public.account_transfers add column if not exists created_at timestamptz not null default statement_timestamp();

create table if not exists public.day_closes (
  id text primary key,
  close_date date not null,
  lines jsonb not null default '[]'::jsonb check (jsonb_typeof(lines)='array'),
  total_diff numeric(38,10),
  has_diff boolean not null default false,
  note text,
  adjust boolean not null default false,
  closed_by text not null references public.app_users(id),
  command_key text,
  approval_id text,
  created_at timestamptz not null default statement_timestamp()
);

alter table public.day_closes add column if not exists command_key text;
alter table public.day_closes add column if not exists approval_id text;
alter table public.day_closes add column if not exists created_at timestamptz not null default statement_timestamp();

create table if not exists public.rate_history (
  id text primary key,
  cur_id text not null references public.currencies(id),
  buy_rate numeric(38,10),
  sell_rate numeric(38,10),
  changed_by text references public.app_users(id),
  command_key text,
  created_at timestamptz not null default statement_timestamp(),
  check (buy_rate is null or buy_rate > 0),
  check (sell_rate is null or sell_rate > 0)
);

alter table public.rate_history add column if not exists command_key text;
alter table public.rate_history add column if not exists created_at timestamptz not null default statement_timestamp();

create table if not exists public.audit (
  id text primary key,
  date timestamptz not null default statement_timestamp(),
  user_id text references public.app_users(id),
  action text not null,
  detail text
);
alter table public.audit add column if not exists user_id text references public.app_users(id);

-- Legacy receipt batch tables are retained as the pre-transaction WhatsApp/batch intake.
-- The canonical receipt lifecycle introduced later is transaction-first; both are bridged by
-- explicit assignment rows rather than silently treating one as the other.
create table if not exists public.receipt_batches (
  id text primary key,
  customer_id text references public.app_users(id),
  customer_name text,
  partner_id text references public.app_users(id),
  direction text not null check (direction in ('in','out','buy','sell')),
  status text not null default 'new',
  currency text not null,
  total_gross numeric(38,10) not null default 0,
  total_fee numeric(38,10) not null default 0,
  total_net numeric(38,10) not null default 0,
  n integer not null default 0,
  dup_n integer not null default 0,
  rejected_n integer not null default 0,
  uploaded_by text references public.app_users(id),
  source text,
  created_at timestamptz not null default statement_timestamp(),
  check (currency ~ '^[A-Z]{3,8}$'),
  check (n >= 0 and dup_n >= 0 and rejected_n >= 0)
);

alter table public.receipt_batches add column if not exists customer_id text references public.app_users(id);
alter table public.receipt_batches add column if not exists customer_name text;
alter table public.receipt_batches add column if not exists partner_id text references public.app_users(id);
alter table public.receipt_batches add column if not exists status text not null default 'new';
alter table public.receipt_batches add column if not exists total_gross numeric(38,10) not null default 0;
alter table public.receipt_batches add column if not exists total_fee numeric(38,10) not null default 0;
alter table public.receipt_batches add column if not exists total_net numeric(38,10) not null default 0;
alter table public.receipt_batches add column if not exists n integer not null default 0;
alter table public.receipt_batches add column if not exists dup_n integer not null default 0;
alter table public.receipt_batches add column if not exists rejected_n integer not null default 0;
alter table public.receipt_batches add column if not exists uploaded_by text references public.app_users(id);
alter table public.receipt_batches add column if not exists source text;
alter table public.receipt_batches add column if not exists created_at timestamptz not null default statement_timestamp();

create table if not exists public.receipts (
  id text primary key,
  batch_id text not null references public.receipt_batches(id),
  customer_id text references public.app_users(id),
  customer_name text,
  partner_id text references public.app_users(id),
  direction text not null,
  amount numeric(38,10) not null check (amount > 0),
  fee numeric(38,10) not null default 0,
  fee_original numeric(38,10),
  fee_discount numeric(38,10) not null default 0,
  platform text,
  net_amount numeric(38,10),
  currency text not null,
  sender text,
  receiver text,
  ref_no text,
  tx_time time,
  tx_date date,
  bank text,
  note text,
  image_hash text,
  image_path text,
  status text not null default 'ok',
  counted boolean not null default true,
  reject_code text,
  reject_reason text,
  dup_of text,
  dup_of_date timestamptz,
  dup_of_who text,
  uploaded_by text references public.app_users(id),
  raw jsonb not null default '{}'::jsonb check (jsonb_typeof(raw)='object'),
  created_at timestamptz not null default statement_timestamp(),
  check (fee >= 0),
  check (currency ~ '^[A-Z]{3,8}$')
);

alter table public.receipts add column if not exists customer_id text references public.app_users(id);
alter table public.receipts add column if not exists customer_name text;
alter table public.receipts add column if not exists partner_id text references public.app_users(id);
alter table public.receipts add column if not exists fee_original numeric(38,10);
alter table public.receipts add column if not exists fee_discount numeric(38,10) not null default 0;
alter table public.receipts add column if not exists platform text;
alter table public.receipts add column if not exists net_amount numeric(38,10);
alter table public.receipts add column if not exists sender text;
alter table public.receipts add column if not exists receiver text;
alter table public.receipts add column if not exists ref_no text;
alter table public.receipts add column if not exists tx_time time;
alter table public.receipts add column if not exists tx_date date;
alter table public.receipts add column if not exists bank text;
alter table public.receipts add column if not exists note text;
alter table public.receipts add column if not exists image_hash text;
alter table public.receipts add column if not exists image_path text;
alter table public.receipts add column if not exists status text not null default 'ok';
alter table public.receipts add column if not exists counted boolean not null default true;
alter table public.receipts add column if not exists reject_code text;
alter table public.receipts add column if not exists reject_reason text;
alter table public.receipts add column if not exists dup_of text;
alter table public.receipts add column if not exists dup_of_date timestamptz;
alter table public.receipts add column if not exists dup_of_who text;
alter table public.receipts add column if not exists uploaded_by text references public.app_users(id);
alter table public.receipts add column if not exists raw jsonb not null default '{}'::jsonb;
alter table public.receipts add column if not exists created_at timestamptz not null default statement_timestamp();

create table if not exists public.approval_requests (
  id text primary key,
  request_key text not null unique,
  operation text not null,
  subject_key text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload)='object'),
  amount_usd numeric(38,10),
  reason text,
  status text not null default 'pending'
    check (status in ('pending','executed','rejected','failed','expired','cancelled')),
  maker_auth_id uuid not null,
  maker_app_id text not null references public.app_users(id),
  maker_name text,
  checker_auth_id uuid,
  checker_app_id text references public.app_users(id),
  checker_name text,
  decision_note text,
  owner_override boolean not null default false,
  result jsonb,
  error_text text,
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  decided_at timestamptz,
  executed_at timestamptz
);

create table if not exists public.approval_events (
  id bigint generated always as identity primary key,
  approval_id text not null references public.approval_requests(id),
  event text not null,
  actor_auth_id uuid,
  actor_app_id text references public.app_users(id),
  actor_name text,
  detail text,
  created_at timestamptz not null default statement_timestamp()
);

alter table public.approval_requests add column if not exists subject_key text;
alter table public.approval_requests add column if not exists payload jsonb not null default '{}'::jsonb;
alter table public.approval_requests add column if not exists amount_usd numeric(38,10);
alter table public.approval_requests add column if not exists reason text;
alter table public.approval_requests add column if not exists checker_auth_id uuid;
alter table public.approval_requests add column if not exists checker_app_id text references public.app_users(id);
alter table public.approval_requests add column if not exists checker_name text;
alter table public.approval_requests add column if not exists decision_note text;
alter table public.approval_requests add column if not exists owner_override boolean not null default false;
alter table public.approval_requests add column if not exists result jsonb;
alter table public.approval_requests add column if not exists error_text text;
alter table public.approval_requests add column if not exists created_at timestamptz not null default statement_timestamp();
alter table public.approval_requests add column if not exists expires_at timestamptz;
alter table public.approval_requests add column if not exists decided_at timestamptz;
alter table public.approval_requests add column if not exists executed_at timestamptz;

alter table public.approval_events add column if not exists actor_auth_id uuid;
alter table public.approval_events add column if not exists actor_app_id text references public.app_users(id);
alter table public.approval_events add column if not exists actor_name text;
alter table public.approval_events add column if not exists detail text;
alter table public.approval_events add column if not exists created_at timestamptz not null default statement_timestamp();

create table if not exists public.tx_versions (
  id bigint generated always as identity primary key,
  tx_id text not null references public.txs(id),
  tx_code integer,
  version_no bigint not null,
  action text not null,
  before_data jsonb,
  after_data jsonb,
  command_key text,
  approval_id text references public.approval_requests(id),
  maker_auth_id uuid,
  checker_auth_id uuid,
  actor_auth_id uuid,
  actor_app_id text references public.app_users(id),
  created_at timestamptz not null default statement_timestamp(),
  unique (tx_id, version_no)
);

create table if not exists public.notes (
  id text primary key,
  user_id text references public.app_users(id),
  kind text not null default 'system',
  title text not null,
  body text,
  link text,
  ref_id text,
  seen boolean not null default false,
  created_at timestamptz not null default statement_timestamp()
);

-- The command result is the idempotency receipt.  It is deliberately not browser-readable.
create table if not exists public.financial_commands (
  command_key text primary key,
  actor_id uuid not null,
  operation text not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default statement_timestamp(),
  check (char_length(command_key) between 8 and 220),
  check (jsonb_typeof(result)='object')
);

create table if not exists public.control_settings (
  singleton boolean primary key default true check (singleton),
  transaction_approval_usd numeric(38,10),
  cash_approval_usd numeric(38,10),
  transfer_approval_usd numeric(38,10),
  require_edit_approval boolean not null default true,
  require_void_approval boolean not null default true,
  require_unsettle_approval boolean not null default true,
  require_day_close_diff_approval boolean not null default true,
  owner_override_enabled boolean not null default true,
  approval_expiry_hours integer not null default 24 check (approval_expiry_hours between 1 and 168),
  business_timezone text not null default 'Asia/Baghdad',
  maintenance_mode boolean not null default false,
  maintenance_reason text,
  maintenance_changed_by text references public.app_users(id),
  maintenance_changed_at timestamptz,
  version bigint not null default 1,
  updated_by text references public.app_users(id),
  updated_at timestamptz not null default statement_timestamp(),
  check (transaction_approval_usd is null or transaction_approval_usd > 0),
  check (cash_approval_usd is null or cash_approval_usd > 0),
  check (transfer_approval_usd is null or transfer_approval_usd > 0)
);
insert into public.control_settings(singleton) values (true) on conflict (singleton) do nothing;

-- Seed only missing currencies.  Existing names, rates and configuration are never replaced.
insert into public.currencies(id,code,name,symbol,dec,external)
values ('usd','USD','دۆلاری ئەمریکی','$',2,false),
       ('iqd','IQD','دیناری عێراقی','د.ع',0,false),
       ('cny','CNY','یەنی سینی','¥',2,true)
on conflict do nothing;

create index if not exists app_users_auth_active_idx on public.app_users(auth_id) where not deleted;
create index if not exists txs_date_active_idx on public.txs(date desc,id) where not deleted;
create index if not exists txs_counterparty_idx on public.txs(cp_id,date desc) where not deleted;
create index if not exists txs_partner_idx on public.txs(partner_id,date desc) where not deleted;
create index if not exists ledger_tx_idx on public.ledger(tx_id);
create index if not exists ledger_partner_idx on public.ledger(partner_id,date desc);
create index if not exists ledger_investor_idx on public.ledger(investor_id,date desc);
create unique index if not exists ledger_command_row_uq on public.ledger(created_by,command_key,id)
  where command_key is not null;
create index if not exists account_ledger_user_idx on public.account_ledger(user_id,cur_id,created_at);
create index if not exists rate_history_currency_idx on public.rate_history(cur_id,created_at);
create index if not exists receipt_batches_created_idx on public.receipt_batches(created_at desc);
create index if not exists receipts_batch_idx on public.receipts(batch_id,created_at);
create index if not exists approvals_status_idx on public.approval_requests(status,created_at desc);
create index if not exists approval_events_request_idx on public.approval_events(approval_id,created_at);
create index if not exists tx_versions_tx_idx on public.tx_versions(tx_id,version_no desc);
create index if not exists notes_recipient_idx on public.notes(user_id,seen,created_at desc);

-- Identity helpers use an empty search_path so callers cannot shadow referenced objects.
create or replace function public.my_app_id() returns text
language sql stable security definer set search_path=''
as $$
  select u.id from public.app_users u
  where u.auth_id=auth.uid() and not u.deleted
  order by u.id limit 1
$$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path=''
as $$
  select u.role from public.app_users u
  where u.auth_id=auth.uid() and not u.deleted
  order by u.id limit 1
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path=''
as $$
  select coalesce((select u.role='admin' from public.app_users u
    where u.auth_id=auth.uid() and not u.deleted order by u.id limit 1),false)
$$;

create or replace function public.sarraf_current_role() returns text
language sql stable security definer set search_path=''
as $$
  select u.role from public.app_users u
  where u.auth_id=auth.uid() and not u.deleted
  order by u.id limit 1
$$;

-- RLS is the final boundary for browser reads.  Financial mutations are RPC-only.
alter table public.currencies enable row level security;
alter table public.app_users enable row level security;
alter table public.txs enable row level security;
alter table public.ledger enable row level security;
alter table public.account_ledger enable row level security;
alter table public.account_transfers enable row level security;
alter table public.day_closes enable row level security;
alter table public.rate_history enable row level security;
alter table public.audit enable row level security;
alter table public.receipt_batches enable row level security;
alter table public.receipts enable row level security;
alter table public.approval_requests enable row level security;
alter table public.approval_events enable row level security;
alter table public.tx_versions enable row level security;
alter table public.notes enable row level security;
alter table public.financial_commands enable row level security;
alter table public.control_settings enable row level security;

revoke all on public.financial_commands, public.control_settings from public,anon,authenticated;
revoke insert,update,delete,truncate on public.txs,public.ledger,public.account_ledger,
  public.account_transfers,public.day_closes,public.rate_history,public.approval_requests,
  public.approval_events,public.tx_versions from authenticated;
revoke insert,update,delete,truncate on public.audit from authenticated;
revoke update,delete,truncate on public.currencies from authenticated;
grant select on public.currencies,public.app_users,public.txs,public.ledger,public.account_ledger,
  public.account_transfers,public.day_closes,public.rate_history,public.audit,public.receipt_batches,
  public.receipts,public.approval_requests,public.approval_events,public.tx_versions,public.notes
to authenticated;
grant insert on public.notes to authenticated;
grant update(seen) on public.notes to authenticated;

drop policy if exists currencies_authenticated_read on public.currencies;
create policy currencies_authenticated_read on public.currencies for select to authenticated
  using (auth.uid() is not null);
drop policy if exists app_users_admin_or_self_read on public.app_users;
create policy app_users_admin_or_self_read on public.app_users for select to authenticated
  using (public.is_admin() or auth_id=auth.uid());
drop policy if exists txs_tenant_read on public.txs;
create policy txs_tenant_read on public.txs for select to authenticated
  using (public.is_admin() or cp_id=public.my_app_id() or partner_id=public.my_app_id()
    or public.my_role()='office');
drop policy if exists ledger_tenant_read on public.ledger;
create policy ledger_tenant_read on public.ledger for select to authenticated
  using (public.is_admin() or partner_id=public.my_app_id() or investor_id=public.my_app_id()
    or public.my_role()='office');
drop policy if exists account_ledger_tenant_read on public.account_ledger;
create policy account_ledger_tenant_read on public.account_ledger for select to authenticated
  using (public.is_admin() or user_id=public.my_app_id());
drop policy if exists account_transfers_admin_read on public.account_transfers;
create policy account_transfers_admin_read on public.account_transfers for select to authenticated
  using (public.is_admin());
drop policy if exists day_closes_admin_read on public.day_closes;
create policy day_closes_admin_read on public.day_closes for select to authenticated
  using (public.is_admin());
drop policy if exists rate_history_authenticated_read on public.rate_history;
create policy rate_history_authenticated_read on public.rate_history for select to authenticated
  using (auth.uid() is not null);
drop policy if exists audit_admin_read on public.audit;
create policy audit_admin_read on public.audit for select to authenticated using (public.is_admin());
drop policy if exists audit_admin_insert on public.audit;
drop policy if exists receipt_batches_admin_read_baseline on public.receipt_batches;
create policy receipt_batches_admin_read_baseline on public.receipt_batches for select to authenticated
  using (public.is_admin() or customer_id=public.my_app_id() or partner_id=public.my_app_id());
drop policy if exists receipts_admin_read_baseline on public.receipts;
create policy receipts_admin_read_baseline on public.receipts for select to authenticated
  using (public.is_admin() or customer_id=public.my_app_id() or partner_id=public.my_app_id());
drop policy if exists approvals_admin_read on public.approval_requests;
create policy approvals_admin_read on public.approval_requests for select to authenticated
  using (public.is_admin());
drop policy if exists approval_events_admin_read on public.approval_events;
create policy approval_events_admin_read on public.approval_events for select to authenticated
  using (public.is_admin());
drop policy if exists tx_versions_admin_read on public.tx_versions;
create policy tx_versions_admin_read on public.tx_versions for select to authenticated
  using (public.is_admin());
drop policy if exists notes_recipient_read on public.notes;
create policy notes_recipient_read on public.notes for select to authenticated
  using (user_id=public.my_app_id() or (user_id is null and public.is_admin()));
drop policy if exists notes_sender_insert on public.notes;
create policy notes_sender_insert on public.notes for insert to authenticated
  with check (public.is_admin() and (user_id is null or exists(
    select 1 from public.app_users u where u.id=user_id and not u.deleted)));
drop policy if exists notes_recipient_seen on public.notes;
create policy notes_recipient_seen on public.notes for update to authenticated
  using (user_id=public.my_app_id() or (user_id is null and public.is_admin()))
  with check (user_id=public.my_app_id() or (user_id is null and public.is_admin()));

commit;
