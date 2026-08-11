-- Customer cashbox (قاسە) and the debt engine.
--
-- Two rules from the accounting contract drive this migration:
--
--   A customer's cashbox is money the customer has placed with ZEMAN. In ZEMAN's books that
--   is a LIABILITY — customer funds held — never revenue, capital or profit. It is tracked per
--   customer AND per currency; CNY, USD and IQD are never netted into one balance.
--
--   A debt is never a bare signed number. Every debt names its debtor, its creditor, its
--   currency and where it came from, so "X owes Y this much" can be stated in words rather
--   than inferred from the sign of a balance.
--
-- Balances are derived from typed events, not stored as editable fields. A trigger keeps the
-- cached balance in step and refuses any event that would overdraw the available balance.
begin;

do $$ begin
  create type public.vault_event_kind as enum (
    'deposit','withdrawal','transaction_reserve','transaction_release',
    'transaction_settlement','apply_to_customer_debt','credit_from_zeman_debt',
    'adjustment','reversal');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.debt_status as enum ('open','partially_settled','settled','written_off','void');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.party_kind as enum ('customer','partner','office','investor','zeman');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Customer cashbox
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.customer_vaults (
  id text primary key,
  customer_id text not null references public.app_users(id),
  currency text not null,
  -- Derived from vault events by trigger; never set directly by a caller.
  available numeric(38,10) not null default 0,
  reserved numeric(38,10) not null default 0,
  last_event_at timestamptz,
  last_reconciled_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  unique (customer_id, currency),
  check (currency ~ '^[A-Z]{3,8}$'),
  check (available >= 0),
  check (reserved >= 0)
);
create index if not exists cv_customer_idx on public.customer_vaults(customer_id);

create table if not exists public.customer_vault_events (
  id bigint generated always as identity primary key,
  vault_id text not null references public.customer_vaults(id),
  customer_id text not null references public.app_users(id),
  currency text not null,
  kind public.vault_event_kind not null,
  -- Signed against availability: a deposit is positive, a withdrawal negative.
  available_delta numeric(38,10) not null default 0,
  reserved_delta numeric(38,10) not null default 0,
  transaction_id text,
  debt_id text,
  journal_entry_id text references public.journal_entries(id),
  voucher_id text,
  reason text,
  actor_id text not null references public.app_users(id),
  command_key text,
  reversal_of bigint references public.customer_vault_events(id),
  created_at timestamptz not null default statement_timestamp(),
  check (currency ~ '^[A-Z]{3,8}$'),
  check (available_delta <> 0 or reserved_delta <> 0)
);
create index if not exists cve_vault_idx on public.customer_vault_events(vault_id, created_at desc);
create index if not exists cve_customer_idx on public.customer_vault_events(customer_id, created_at desc);
create unique index if not exists cve_command_uq
  on public.customer_vault_events(actor_id, command_key) where command_key is not null;

-- The cached balance is a projection of the event stream, maintained here so it cannot drift.
create or replace function public.apply_customer_vault_event()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_available numeric(38,10); v_reserved numeric(38,10);
begin
  update public.customer_vaults
     set available = available + new.available_delta,
         reserved  = reserved  + new.reserved_delta,
         last_event_at = statement_timestamp()
   where id = new.vault_id
  returning available, reserved into v_available, v_reserved;

  if not found then
    raise exception using errcode='23503', message=format('unknown customer vault %s', new.vault_id);
  end if;
  -- The CHECK constraints would also catch this, but the message must name the cause.
  if v_available < 0 then
    raise exception using errcode='23514',
      message=format('vault %s would be overdrawn: available would become %s', new.vault_id, v_available);
  end if;
  if v_reserved < 0 then
    raise exception using errcode='23514',
      message=format('vault %s would hold negative reserved funds (%s)', new.vault_id, v_reserved);
  end if;
  return new;
end;
$$;
drop trigger if exists customer_vault_event_applied on public.customer_vault_events;
create trigger customer_vault_event_applied
  after insert on public.customer_vault_events
  for each row execute function public.apply_customer_vault_event();

create or replace function public.protect_vault_events()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception using errcode='42501',
    message='customer vault events are append-only; post a reversal event instead';
end;
$$;
drop trigger if exists customer_vault_events_immutable on public.customer_vault_events;
create trigger customer_vault_events_immutable
  before update or delete on public.customer_vault_events
  for each row execute function public.protect_vault_events();

-- ─────────────────────────────────────────────────────────────────────────────
-- Debt
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.debts (
  id text primary key,
  debtor_type public.party_kind not null,
  debtor_id text,
  creditor_type public.party_kind not null,
  creditor_id text,
  currency text not null,
  original_principal numeric(38,10) not null,
  outstanding_principal numeric(38,10) not null,
  source_type text not null,
  source_transaction_id text,
  source_voucher_id text,
  reason text not null,
  status public.debt_status not null default 'open',
  opened_at timestamptz not null default statement_timestamp(),
  due_at timestamptz,
  closed_at timestamptz,
  created_by text not null references public.app_users(id),
  approved_by text references public.app_users(id),
  journal_entry_id text references public.journal_entries(id),
  command_key text,
  check (currency ~ '^[A-Z]{3,8}$'),
  check (original_principal > 0),
  check (outstanding_principal >= 0),
  check (outstanding_principal <= original_principal),
  -- A party cannot owe itself, and a named party must carry an id.
  check (not (debtor_type = creditor_type and debtor_id is not distinct from creditor_id)),
  check ((debtor_type = 'zeman') = (debtor_id is null)),
  check ((creditor_type = 'zeman') = (creditor_id is null)),
  check (char_length(reason) between 3 and 700)
);
create index if not exists debt_debtor_idx on public.debts(debtor_type, debtor_id, currency, status);
create index if not exists debt_creditor_idx on public.debts(creditor_type, creditor_id, currency, status);
create index if not exists debt_open_idx on public.debts(status, due_at) where status in ('open','partially_settled');
create unique index if not exists debt_command_uq
  on public.debts(created_by, command_key) where command_key is not null;

create table if not exists public.debt_settlements (
  id bigint generated always as identity primary key,
  debt_id text not null references public.debts(id),
  amount_applied numeric(38,10) not null,
  outstanding_before numeric(38,10) not null,
  outstanding_after numeric(38,10) not null,
  source_kind text not null,
  vault_event_id bigint references public.customer_vault_events(id),
  transaction_id text,
  journal_entry_id text references public.journal_entries(id),
  actor_id text not null references public.app_users(id),
  command_key text,
  reason text,
  created_at timestamptz not null default statement_timestamp(),
  check (amount_applied > 0),
  check (outstanding_after = outstanding_before - amount_applied),
  check (outstanding_after >= 0)
);
create index if not exists ds_debt_idx on public.debt_settlements(debt_id, created_at);
create unique index if not exists ds_command_uq
  on public.debt_settlements(actor_id, command_key) where command_key is not null;

-- Settlement drives the debt's outstanding balance and status; neither is set by hand.
create or replace function public.apply_debt_settlement()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_debt public.debts%rowtype;
begin
  select * into v_debt from public.debts where id = new.debt_id for update;
  if not found then
    raise exception using errcode='23503', message=format('unknown debt %s', new.debt_id);
  end if;
  if v_debt.status in ('settled','written_off','void') then
    raise exception using errcode='23514',
      message=format('debt %s is %s and cannot take further settlement', v_debt.id, v_debt.status);
  end if;
  if new.amount_applied > v_debt.outstanding_principal then
    raise exception using errcode='23514',
      message=format('settlement of %s exceeds outstanding %s on debt %s',
                     new.amount_applied, v_debt.outstanding_principal, v_debt.id);
  end if;
  if new.outstanding_before <> v_debt.outstanding_principal then
    raise exception using errcode='40001',
      message=format('debt %s changed under this settlement (expected %s, found %s)',
                     v_debt.id, new.outstanding_before, v_debt.outstanding_principal);
  end if;

  update public.debts
     set outstanding_principal = new.outstanding_after,
         status = case when new.outstanding_after = 0 then 'settled'::public.debt_status
                       else 'partially_settled'::public.debt_status end,
         closed_at = case when new.outstanding_after = 0 then statement_timestamp() else null end
   where id = v_debt.id;
  return new;
end;
$$;
drop trigger if exists debt_settlement_applied on public.debt_settlements;
create trigger debt_settlement_applied
  before insert on public.debt_settlements
  for each row execute function public.apply_debt_settlement();

create or replace function public.protect_debt_settlements()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception using errcode='42501',
    message='debt settlements are append-only; post a reversing settlement instead';
end;
$$;
drop trigger if exists debt_settlements_immutable on public.debt_settlements;
create trigger debt_settlements_immutable
  before update or delete on public.debt_settlements
  for each row execute function public.protect_debt_settlements();

-- Debts are never deleted. Waiving is a status change with a reason, not a removal.
create or replace function public.protect_debts()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode='42501',
      message=format('debt %s cannot be deleted; write it off or void it with a reason', old.id);
  end if;
  if old.currency is distinct from new.currency
     or old.debtor_id is distinct from new.debtor_id
     or old.creditor_id is distinct from new.creditor_id
     or old.original_principal is distinct from new.original_principal then
    raise exception using errcode='42501',
      message=format('the identity of debt %s is immutable', old.id);
  end if;
  return new;
end;
$$;
drop trigger if exists debts_protected on public.debts;
create trigger debts_protected before update or delete on public.debts
  for each row execute function public.protect_debts();

-- ─────────────────────────────────────────────────────────────────────────────
-- Deterministic settlement waterfall: overdue first, then oldest due, then oldest opened.
-- Returned as a preview so an operator sees the allocation before it is applied.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sarraf_debt_waterfall(
  p_debtor_type public.party_kind, p_debtor_id text,
  p_creditor_type public.party_kind, p_creditor_id text,
  p_currency text, p_amount numeric
) returns table(debt_id text, outstanding numeric, allocated numeric, remaining_after numeric)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare r record; v_left numeric := p_amount;
begin
  if p_amount is null or p_amount <= 0 then return; end if;
  for r in
    select d.id, d.outstanding_principal
    from public.debts d
    where d.status in ('open','partially_settled')
      and d.currency = upper(p_currency)
      and d.debtor_type = p_debtor_type
      and d.debtor_id is not distinct from p_debtor_id
      and d.creditor_type = p_creditor_type
      and d.creditor_id is not distinct from p_creditor_id
    order by
      (d.due_at is not null and d.due_at < statement_timestamp()) desc,  -- overdue first
      d.due_at asc nulls last,                                           -- then soonest due
      d.opened_at asc,                                                   -- then oldest
      d.id asc                                                           -- deterministic tiebreak
  loop
    exit when v_left <= 0;
    debt_id := r.id;
    outstanding := r.outstanding_principal;
    allocated := least(v_left, r.outstanding_principal);
    v_left := v_left - allocated;
    remaining_after := v_left;
    return next;
  end loop;
end;
$$;
revoke all on function public.sarraf_debt_waterfall(public.party_kind,text,public.party_kind,text,text,numeric) from public, anon;
grant execute on function public.sarraf_debt_waterfall(public.party_kind,text,public.party_kind,text,text,numeric) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Aging, for the debt centre.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.v_debt_aging as
select d.id, d.debtor_type, d.debtor_id, d.creditor_type, d.creditor_id, d.currency,
       d.outstanding_principal, d.status, d.opened_at, d.due_at,
       case
         when d.due_at is null then 'current'
         when d.due_at >= statement_timestamp() then 'current'
         when d.due_at >= statement_timestamp() - interval '7 days'  then '1-7'
         when d.due_at >= statement_timestamp() - interval '30 days' then '8-30'
         when d.due_at >= statement_timestamp() - interval '60 days' then '31-60'
         else '60+'
       end as aging_bucket
from public.debts d
where d.status in ('open','partially_settled');

-- Subledger totals must equal their control accounts; this is the reconciliation gate.
create or replace function public.sarraf_subledger_reconciliation()
returns jsonb
language sql security definer stable set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'customer_vault_total', (select coalesce(jsonb_object_agg(currency, total), '{}'::jsonb)
       from (select currency, sum(available + reserved) total from public.customer_vaults group by currency) v),
    'debt_outstanding', (select coalesce(jsonb_object_agg(currency, total), '{}'::jsonb)
       from (select currency, sum(outstanding_principal) total from public.debts
             where status in ('open','partially_settled') group by currency) d),
    'vault_events', (select count(*) from public.customer_vault_events),
    'open_debts', (select count(*) from public.debts where status in ('open','partially_settled')),
    'checked_at', statement_timestamp()
  );
$$;
revoke all on function public.sarraf_subledger_reconciliation() from public, anon;
grant execute on function public.sarraf_subledger_reconciliation() to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Security: read-only to clients; all mutation goes through audited commands.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.customer_vaults enable row level security;
alter table public.customer_vault_events enable row level security;
alter table public.debts enable row level security;
alter table public.debt_settlements enable row level security;

revoke all on public.customer_vaults, public.customer_vault_events, public.debts, public.debt_settlements
  from public, anon, authenticated;
grant select on public.customer_vaults, public.customer_vault_events, public.debts, public.debt_settlements
  to authenticated;

drop policy if exists cv_staff_read on public.customer_vaults;
create policy cv_staff_read on public.customer_vaults for select to authenticated
  using (public.is_admin() or public.my_role() = 'office');
drop policy if exists cv_own_read on public.customer_vaults;
create policy cv_own_read on public.customer_vaults for select to authenticated
  using (customer_id = public.my_app_id());

drop policy if exists cve_staff_read on public.customer_vault_events;
create policy cve_staff_read on public.customer_vault_events for select to authenticated
  using (public.is_admin() or public.my_role() = 'office');
drop policy if exists cve_own_read on public.customer_vault_events;
create policy cve_own_read on public.customer_vault_events for select to authenticated
  using (customer_id = public.my_app_id());

-- A party sees a debt only when they are one of its two sides.
drop policy if exists debt_staff_read on public.debts;
create policy debt_staff_read on public.debts for select to authenticated
  using (public.is_admin() or public.my_role() = 'office');
drop policy if exists debt_party_read on public.debts;
create policy debt_party_read on public.debts for select to authenticated
  using (debtor_id = public.my_app_id() or creditor_id = public.my_app_id());

drop policy if exists ds_staff_read on public.debt_settlements;
create policy ds_staff_read on public.debt_settlements for select to authenticated
  using (public.is_admin() or public.my_role() = 'office');
drop policy if exists ds_party_read on public.debt_settlements;
create policy ds_party_read on public.debt_settlements for select to authenticated
  using (exists (select 1 from public.debts d where d.id = debt_settlements.debt_id
                 and (d.debtor_id = public.my_app_id() or d.creditor_id = public.my_app_id())));

commit;
