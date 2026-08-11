-- Double-entry accounting core.
--
-- Balances in this system were derived by summing typed ledger rows. That cannot express a
-- balanced entry, cannot prove that a business event posted completely, and gives no place to
-- record which account was debited against which. This migration adds the ledger the rest of
-- the accounting contract rests on: a chart of accounts, journal entries, and journal lines
-- that the database itself refuses to leave unbalanced.
--
-- Design decisions:
--   - Every line carries its ORIGINAL currency and amount plus a base (USD) amount with the
--     rate snapshot used. Single-currency entries balance in both; cross-currency entries
--     balance in base only. CNY, USD and IQD are never added together in one column.
--   - Balance is enforced by a DEFERRABLE constraint trigger, checked at COMMIT, because a
--     row-level CHECK cannot see sibling lines.
--   - A posted entry is immutable. Corrections are reversal entries that link to the original.
--   - Amounts are numeric, never floating point, with per-currency minor units respected.
begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- Chart of accounts
-- ─────────────────────────────────────────────────────────────────────────────
do $$ begin
  create type public.account_kind as enum ('asset','liability','equity','income','expense');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.journal_status as enum ('draft','posted','reversed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.entry_side as enum ('debit','credit');
exception when duplicate_object then null; end $$;

create table if not exists public.chart_of_accounts (
  id text primary key,
  code text not null unique,
  name text not null,
  kind public.account_kind not null,
  -- Which side increases this account. Assets/expenses increase on debit; the rest on credit.
  normal_side public.entry_side not null,
  -- Control accounts are reconciled against a subledger (customer vaults, debts, partners).
  is_control boolean not null default false,
  subledger text,
  -- A currency-specific account; null means the account carries any currency.
  currency text,
  parent_id text references public.chart_of_accounts(id),
  active boolean not null default true,
  created_at timestamptz not null default statement_timestamp(),
  check (code ~ '^[0-9]{4}(-[A-Z]{3,8})?$'),
  check (currency is null or currency ~ '^[A-Z]{3,8}$'),
  check (
    (kind in ('asset','expense') and normal_side = 'debit')
    or (kind in ('liability','equity','income') and normal_side = 'credit')
  )
);
create index if not exists coa_kind_idx on public.chart_of_accounts(kind, active);
create index if not exists coa_subledger_idx on public.chart_of_accounts(subledger) where subledger is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Journal
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.journal_entries (
  id text primary key,
  entry_no bigint generated always as identity,
  status public.journal_status not null default 'draft',
  business_date date not null,
  posted_at timestamptz,
  -- Provenance: every entry names the business event that produced it.
  source_type text not null,
  source_id text,
  transaction_id text,
  receipt_batch_id text,
  voucher_id text,
  actor_id text references public.app_users(id),
  command_key text,
  description text,
  reversal_of text references public.journal_entries(id),
  reversed_by text references public.journal_entries(id),
  created_at timestamptz not null default statement_timestamp(),
  check (source_type ~ '^[a-z_]{3,60}$'),
  check (status <> 'posted' or posted_at is not null),
  check (reversal_of is null or reversal_of <> id)
);
create index if not exists je_status_date_idx on public.journal_entries(status, business_date desc);
create index if not exists je_source_idx on public.journal_entries(source_type, source_id);
create index if not exists je_tx_idx on public.journal_entries(transaction_id) where transaction_id is not null;
create index if not exists je_batch_idx on public.journal_entries(receipt_batch_id) where receipt_batch_id is not null;
-- One posted entry per business command; replays must not double-post.
create unique index if not exists je_command_uq
  on public.journal_entries(actor_id, command_key)
  where command_key is not null and status = 'posted';

create table if not exists public.journal_lines (
  id bigint generated always as identity primary key,
  entry_id text not null references public.journal_entries(id) on delete cascade,
  line_no integer not null,
  account_id text not null references public.chart_of_accounts(id),
  side public.entry_side not null,
  -- Original amount as transacted.
  currency text not null,
  amount numeric(38,10) not null,
  -- Same amount expressed in the base currency (USD) for cross-currency balancing.
  base_amount numeric(38,10) not null,
  base_rate numeric(38,10) not null,
  rate_source text,
  rate_date date,
  -- Subledger linkage so control accounts can be reconciled.
  party_type text,
  party_id text,
  memo text,
  unique (entry_id, line_no),
  check (currency ~ '^[A-Z]{3,8}$'),
  check (amount > 0),
  check (base_amount >= 0),
  check (base_rate > 0),
  check (party_type is null or party_type in ('customer','partner','investor','office','admin','system'))
);
create index if not exists jl_entry_idx on public.journal_lines(entry_id);
create index if not exists jl_account_idx on public.journal_lines(account_id);
create index if not exists jl_party_idx on public.journal_lines(party_type, party_id) where party_id is not null;
create index if not exists jl_currency_idx on public.journal_lines(currency);

-- ─────────────────────────────────────────────────────────────────────────────
-- Balance enforcement
--
-- Deferred to COMMIT so an entry may be built line by line inside a transaction, but can
-- never be left unbalanced. Base amounts must always balance. Where every line of an entry
-- shares one currency, the original amounts must balance too — that catches a rate applied
-- to one side only.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.assert_journal_entry_balanced()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_entry text := coalesce(new.entry_id, old.entry_id);
  v_status public.journal_status;
  v_base_debit numeric(38,10);
  v_base_credit numeric(38,10);
  v_currencies int;
  v_debit numeric(38,10);
  v_credit numeric(38,10);
  v_lines int;
begin
  select status into v_status from public.journal_entries where id = v_entry;
  -- A draft may be incomplete; only a posted entry must balance.
  if v_status is distinct from 'posted' then return null; end if;

  select count(*),
         count(distinct currency),
         coalesce(sum(base_amount) filter (where side='debit'), 0),
         coalesce(sum(base_amount) filter (where side='credit'), 0),
         coalesce(sum(amount) filter (where side='debit'), 0),
         coalesce(sum(amount) filter (where side='credit'), 0)
    into v_lines, v_currencies, v_base_debit, v_base_credit, v_debit, v_credit
  from public.journal_lines where entry_id = v_entry;

  if v_lines < 2 then
    raise exception using errcode='23514',
      message=format('journal entry %s must have at least two lines', v_entry);
  end if;

  -- One cent of base tolerance absorbs per-currency rounding across a conversion.
  if abs(v_base_debit - v_base_credit) > 0.01 then
    raise exception using errcode='23514',
      message=format('journal entry %s is unbalanced in base currency: debit %s, credit %s',
                     v_entry, v_base_debit, v_base_credit);
  end if;

  if v_currencies = 1 and abs(v_debit - v_credit) > 0.0000000001 then
    raise exception using errcode='23514',
      message=format('journal entry %s is unbalanced in %s: debit %s, credit %s',
                     v_entry, (select min(currency) from public.journal_lines where entry_id=v_entry),
                     v_debit, v_credit);
  end if;

  return null;
end;
$$;

drop trigger if exists journal_lines_balanced on public.journal_lines;
create constraint trigger journal_lines_balanced
  after insert or update or delete on public.journal_lines
  deferrable initially deferred
  for each row execute function public.assert_journal_entry_balanced();

-- Posting an entry must also be checked, for the case where status flips after the lines land.
create or replace function public.assert_entry_balanced_on_post()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_base_debit numeric(38,10); v_base_credit numeric(38,10); v_lines int;
begin
  if new.status <> 'posted' then return new; end if;
  select count(*),
         coalesce(sum(base_amount) filter (where side='debit'), 0),
         coalesce(sum(base_amount) filter (where side='credit'), 0)
    into v_lines, v_base_debit, v_base_credit
  from public.journal_lines where entry_id = new.id;
  if v_lines < 2 or abs(v_base_debit - v_base_credit) > 0.01 then
    raise exception using errcode='23514',
      message=format('cannot post unbalanced journal entry %s (debit %s, credit %s, lines %s)',
                     new.id, v_base_debit, v_base_credit, v_lines);
  end if;
  return new;
end;
$$;
drop trigger if exists journal_entry_post_balanced on public.journal_entries;
create constraint trigger journal_entry_post_balanced
  after insert or update of status on public.journal_entries
  deferrable initially deferred
  for each row execute function public.assert_entry_balanced_on_post();

-- ─────────────────────────────────────────────────────────────────────────────
-- Immutability: a posted entry is corrected by reversal, never edited or deleted.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.protect_posted_journal()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'posted' then
      raise exception using errcode='42501',
        message=format('posted journal entry %s cannot be deleted; post a reversal instead', old.id);
    end if;
    return old;
  end if;
  if old.status = 'posted' then
    -- Only the reversal backlink may be set afterwards.
    if new.status is distinct from old.status
       or new.business_date is distinct from old.business_date
       or new.source_type is distinct from old.source_type
       or new.source_id is distinct from old.source_id
       or new.transaction_id is distinct from old.transaction_id
       or new.posted_at is distinct from old.posted_at then
      if not (old.status = 'posted' and new.status = 'reversed'
              and new.business_date = old.business_date) then
        raise exception using errcode='42501',
          message=format('posted journal entry %s is immutable; post a reversal instead', old.id);
      end if;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists journal_entries_immutable on public.journal_entries;
create trigger journal_entries_immutable
  before update or delete on public.journal_entries
  for each row execute function public.protect_posted_journal();

create or replace function public.protect_posted_journal_lines()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_status public.journal_status;
begin
  select status into v_status from public.journal_entries
   where id = coalesce(new.entry_id, old.entry_id);
  if v_status in ('posted','reversed') then
    raise exception using errcode='42501',
      message='lines of a posted journal entry are immutable; post a reversal instead';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
drop trigger if exists journal_lines_immutable on public.journal_lines;
create trigger journal_lines_immutable
  before update or delete on public.journal_lines
  for each row execute function public.protect_posted_journal_lines();

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed the chart of accounts.
-- Codes: 1xxx asset, 2xxx liability, 3xxx equity, 4xxx income, 5xxx expense.
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.chart_of_accounts (id, code, name, kind, normal_side, is_control, subledger) values
  ('acc-1000','1000','قاسەی سەرەکی — Main safe',              'asset','debit', false, null),
  ('acc-1100','1100','پارەی لای هاوبەشان — Partner-held funds','asset','debit', true,  'partner_account'),
  ('acc-1200','1200','قەرزاری کڕیاران — Customer receivable',  'asset','debit', true,  'debt'),
  ('acc-1300','1300','قەرزاری نووسینگە — Office receivable',   'asset','debit', true,  'office'),
  ('acc-1400','1400','مەخزەنی دراو — Currency inventory',      'asset','debit', false, null),
  ('acc-2000','2000','قاسەی کڕیاران — Customer funds held',    'liability','credit', true, 'customer_vault'),
  ('acc-2100','2100','قەرزی ZEMAN بۆ هاوبەشان — Partner payable','liability','credit', true,'partner_debt'),
  ('acc-2200','2200','قەرزی ZEMAN بۆ نووسینگە — Office payable','liability','credit', true,'office'),
  ('acc-3000','3000','سەرمایە — Capital',                       'equity','credit', false, null),
  ('acc-3100','3100','سەرمایەی وەبەرهێنەران — Investor capital','equity','credit', true, 'investor'),
  ('acc-3900','3900','قازانجی کۆکراوە — Retained earnings',     'equity','credit', false, null),
  ('acc-4000','4000','قازانجی ئاڵوگۆڕ — Exchange spread income','income','credit', false, null),
  ('acc-4100','4100','داهاتی فی — Fee income',                  'income','credit', false, null),
  ('acc-4900','4900','قازانجی گۆڕانی نرخ — FX revaluation gain','income','credit', false, null),
  ('acc-5000','5000','فیی هاوبەشان — Partner fee expense',      'expense','debit', false, null),
  ('acc-5100','5100','فیی پلاتفۆرم — Platform fee expense',     'expense','debit', false, null),
  ('acc-5200','5200','خەرجیی کارگێڕی — Operating expense',      'expense','debit', false, null),
  ('acc-5900','5900','زەرەری گۆڕانی نرخ — FX revaluation loss', 'expense','debit', false, null)
on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Security. Financial state is written by SECURITY DEFINER commands only.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.chart_of_accounts enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_lines enable row level security;

revoke all on public.chart_of_accounts, public.journal_entries, public.journal_lines
  from public, anon, authenticated;
grant select on public.chart_of_accounts, public.journal_entries, public.journal_lines to authenticated;

drop policy if exists coa_staff_read on public.chart_of_accounts;
create policy coa_staff_read on public.chart_of_accounts for select to authenticated
  using (public.is_admin() or public.my_role() = 'office');

drop policy if exists je_staff_read on public.journal_entries;
create policy je_staff_read on public.journal_entries for select to authenticated
  using (public.is_admin() or public.my_role() = 'office');

-- A party may read only the lines that name them; they never see the whole entry's other side.
drop policy if exists jl_staff_read on public.journal_lines;
create policy jl_staff_read on public.journal_lines for select to authenticated
  using (public.is_admin() or public.my_role() = 'office');
drop policy if exists jl_party_read on public.journal_lines;
create policy jl_party_read on public.journal_lines for select to authenticated
  using (party_id is not null and party_id = public.my_app_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- Trial balance: the reconciliation the release gate depends on.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.v_trial_balance as
select a.code, a.name, a.kind, l.currency,
       sum(case when l.side='debit'  then l.amount else 0 end) as debit,
       sum(case when l.side='credit' then l.amount else 0 end) as credit,
       sum(case when l.side='debit'  then l.amount else -l.amount end)
         * case when a.normal_side='debit' then 1 else -1 end as balance_natural,
       sum(case when l.side='debit'  then l.base_amount else -l.base_amount end) as base_balance
from public.journal_lines l
join public.journal_entries e on e.id = l.entry_id and e.status = 'posted'
join public.chart_of_accounts a on a.id = l.account_id
group by a.code, a.name, a.kind, a.normal_side, l.currency;

create or replace function public.sarraf_trial_balance_check()
returns jsonb
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'base_debit',  coalesce(sum(case when l.side='debit'  then l.base_amount end), 0),
    'base_credit', coalesce(sum(case when l.side='credit' then l.base_amount end), 0),
    'difference',  coalesce(sum(case when l.side='debit' then l.base_amount else -l.base_amount end), 0),
    'balanced',    abs(coalesce(sum(case when l.side='debit' then l.base_amount else -l.base_amount end), 0)) <= 0.01,
    'entry_count', (select count(*) from public.journal_entries where status='posted'),
    'checked_at',  statement_timestamp()
  )
  from public.journal_lines l
  join public.journal_entries e on e.id = l.entry_id and e.status = 'posted';
$$;
revoke all on function public.sarraf_trial_balance_check() from public, anon;
grant execute on function public.sarraf_trial_balance_check() to authenticated;

commit;
