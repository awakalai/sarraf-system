-- Partner accounts with automatic settlement, and the office payment flow.
--
-- §13D: a partner account holds a real balance per currency. When ZEMAN hands a partner more
-- than the account holds, the excess becomes a debt the partner owes ZEMAN — not a negative
-- balance. When credit later arrives, it settles that debt first through the deterministic
-- waterfall and only the remainder becomes available. The worked example is exact:
--
--   balance 1,000 → sold 1,300 → 1,000 consumed, debt 300
--   later credit 500 → debt 0, settled 300, available 200
--
-- §13E: an unpaid purchase names the office that will pay. Only that office sees the
-- assignment. The office reports evidence; an authorised verifier confirms it. Amount and
-- currency come from the transaction and neither the office nor the client may change them.
begin;

do $$ begin
  create type public.office_assignment_status as enum (
    'assigned','acknowledged','payment_initiated','paid_reported','confirmed','rejected','cancelled');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Partner accounts
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.partner_accounts (
  id text primary key,
  partner_id text not null references public.app_users(id),
  currency text not null,
  available numeric(38,10) not null default 0,
  reserved numeric(38,10) not null default 0,
  -- A credit limit lets ZEMAN hand over more than the balance; the excess becomes debt.
  credit_limit numeric(38,10) not null default 0,
  active boolean not null default true,
  last_event_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  unique (partner_id, currency),
  check (currency ~ '^[A-Z]{3,8}$'),
  check (available >= 0),
  check (reserved >= 0),
  check (credit_limit >= 0)
);
create index if not exists pa_partner_idx on public.partner_accounts(partner_id);

create table if not exists public.partner_account_events (
  id bigint generated always as identity primary key,
  account_id text not null references public.partner_accounts(id),
  partner_id text not null references public.app_users(id),
  currency text not null,
  kind text not null,
  available_delta numeric(38,10) not null default 0,
  reserved_delta numeric(38,10) not null default 0,
  debt_id text references public.debts(id),
  transaction_id text,
  journal_entry_id text references public.journal_entries(id),
  reason text,
  actor_id text not null references public.app_users(id),
  command_key text,
  created_at timestamptz not null default statement_timestamp(),
  check (kind in ('credit','debit','reserve','release','debt_created','debt_settled','adjustment','reversal')),
  check (currency ~ '^[A-Z]{3,8}$')
);
create index if not exists pae_account_idx on public.partner_account_events(account_id, created_at desc);
create unique index if not exists pae_command_uq
  on public.partner_account_events(actor_id, command_key) where command_key is not null;

create or replace function public.apply_partner_account_event()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare v_available numeric(38,10);
begin
  update public.partner_accounts
     set available = available + new.available_delta,
         reserved  = reserved  + new.reserved_delta,
         last_event_at = statement_timestamp()
   where id = new.account_id
  returning available into v_available;
  if not found then
    raise exception using errcode='23503', message=format('unknown partner account %s', new.account_id);
  end if;
  if v_available < 0 then
    raise exception using errcode='23514',
      message=format('partner account %s would go negative (%s); the excess must become a debt',
                     new.account_id, v_available);
  end if;
  return new;
end;
$$;
drop trigger if exists partner_account_event_applied on public.partner_account_events;
create trigger partner_account_event_applied after insert on public.partner_account_events
  for each row execute function public.apply_partner_account_event();

create or replace function public.protect_partner_account_events()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception using errcode='42501',
    message='partner account events are append-only; post a reversal instead';
end;
$$;
drop trigger if exists partner_account_events_immutable on public.partner_account_events;
create trigger partner_account_events_immutable before update or delete on public.partner_account_events
  for each row execute function public.protect_partner_account_events();

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand currency to a partner. Balance is consumed first; the excess becomes debt.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sarraf_partner_disburse(
  p_partner_id text, p_currency text, p_amount numeric, p_rate numeric,
  p_transaction_id text, p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_acct public.partner_accounts%rowtype;
  v_cur text := upper(btrim(p_currency)); v_from_balance numeric; v_excess numeric;
  v_debt text; v_entry text; v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role not in ('admin','office') then
    raise exception using errcode='42501', message='partner disbursement is not authorized';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception using errcode='22023', message='amount must be greater than zero';
  end if;
  if char_length(btrim(coalesce(p_reason,''))) < 3 then
    raise exception using errcode='22023', message='a reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || p_command_key, 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  insert into public.partner_accounts(id, partner_id, currency)
  values ('pa-' || p_partner_id || '-' || v_cur, p_partner_id, v_cur)
  on conflict (partner_id, currency) do nothing;
  select * into v_acct from public.partner_accounts
   where partner_id = p_partner_id and currency = v_cur for update;

  v_from_balance := least(p_amount, v_acct.available);
  v_excess := p_amount - v_from_balance;

  if v_from_balance > 0 then
    insert into public.partner_account_events(
      account_id, partner_id, currency, kind, available_delta,
      transaction_id, reason, actor_id, command_key)
    values (v_acct.id, p_partner_id, v_cur, 'debit', -v_from_balance,
            p_transaction_id, left(btrim(p_reason), 700), v_actor.id, p_command_key);
  end if;

  if v_excess > 0 then
    -- The excess is a debt the partner owes ZEMAN, stated explicitly rather than as a
    -- negative balance, so its direction and source can never be misread.
    v_debt := 'debt-p-' || md5(v_actor.id || ':' || p_command_key);
    v_entry := 'je-pdisb-' || md5(v_actor.id || ':' || p_command_key);
    perform public.sarraf_post_simple_entry(
      v_entry, current_date, 'partner_over_limit_debt', v_actor.id,
      'acc-1200', 'acc-1400', v_cur, v_excess, p_rate,
      format('قەرزی هاوبەش لەسەر زیادەی دابەشکراو — %s %s', v_excess, v_cur),
      p_command_key, 'partner', p_partner_id, p_transaction_id);

    insert into public.debts(
      id, debtor_type, debtor_id, creditor_type, creditor_id, currency,
      original_principal, outstanding_principal, source_type, source_transaction_id,
      reason, created_by, journal_entry_id, command_key)
    values (v_debt, 'partner', p_partner_id, 'zeman', null, v_cur,
            v_excess, v_excess, 'partner_over_limit', p_transaction_id,
            left(btrim(p_reason), 700), v_actor.id, v_entry, p_command_key);

    insert into public.partner_account_events(
      account_id, partner_id, currency, kind, available_delta, debt_id,
      transaction_id, journal_entry_id, reason, actor_id, command_key)
    values (v_acct.id, p_partner_id, v_cur, 'debt_created', 0, v_debt,
            p_transaction_id, v_entry, left(btrim(p_reason), 700), v_actor.id,
            p_command_key || ':debt');
  end if;

  v_result := jsonb_build_object(
    'partner_id', p_partner_id, 'currency', v_cur, 'requested', p_amount,
    'from_balance', v_from_balance, 'excess_as_debt', v_excess, 'debt_id', v_debt,
    'available', (select available from public.partner_accounts where id = v_acct.id),
    'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'partner_disburse', v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_partner_disburse(text,text,numeric,numeric,text,text,text) from public, anon;
grant execute on function public.sarraf_partner_disburse(text,text,numeric,numeric,text,text,text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Credit a partner account. Outstanding debt in the same direction and currency is
-- settled first through the waterfall; only the remainder becomes available.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sarraf_partner_credit(
  p_partner_id text, p_currency text, p_amount numeric, p_rate numeric,
  p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_acct public.partner_accounts%rowtype;
  v_cur text := upper(btrim(p_currency)); r record; v_applied numeric := 0; v_remainder numeric;
  v_entry text; v_result jsonb; v_allocations jsonb := '[]'::jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role not in ('admin','office') then
    raise exception using errcode='42501', message='partner credit is not authorized';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception using errcode='22023', message='amount must be greater than zero';
  end if;
  if char_length(btrim(coalesce(p_reason,''))) < 3 then
    raise exception using errcode='22023', message='a reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || p_command_key, 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  insert into public.partner_accounts(id, partner_id, currency)
  values ('pa-' || p_partner_id || '-' || v_cur, p_partner_id, v_cur)
  on conflict (partner_id, currency) do nothing;
  select * into v_acct from public.partner_accounts
   where partner_id = p_partner_id and currency = v_cur for update;

  for r in
    select * from public.sarraf_debt_waterfall('partner', p_partner_id, 'zeman', null, v_cur, p_amount)
  loop
    v_entry := 'je-pcred-' || md5(v_actor.id || ':' || p_command_key || ':' || r.debt_id);
    perform public.sarraf_post_simple_entry(
      v_entry, current_date, 'partner_debt_settlement', v_actor.id,
      'acc-1400', 'acc-1200', v_cur, r.allocated, p_rate,
      format('تسویەی قەرزی هاوبەش لە کریدیتی نوێ — %s %s', r.allocated, v_cur),
      p_command_key || ':' || r.debt_id, 'partner', p_partner_id);

    insert into public.debt_settlements(
      debt_id, amount_applied, outstanding_before, outstanding_after,
      source_kind, journal_entry_id, actor_id, command_key, reason)
    values (r.debt_id, r.allocated, r.outstanding, r.outstanding - r.allocated,
            'partner_credit', v_entry, v_actor.id,
            p_command_key || ':' || r.debt_id, left(btrim(p_reason), 700));

    insert into public.partner_account_events(
      account_id, partner_id, currency, kind, available_delta, debt_id,
      journal_entry_id, reason, actor_id, command_key)
    values (v_acct.id, p_partner_id, v_cur, 'debt_settled', 0, r.debt_id,
            v_entry, left(btrim(p_reason), 700), v_actor.id,
            p_command_key || ':s:' || r.debt_id);

    v_applied := v_applied + r.allocated;
    v_allocations := v_allocations || jsonb_build_object(
      'debt_id', r.debt_id, 'applied', r.allocated,
      'outstanding_after', r.outstanding - r.allocated);
  end loop;

  v_remainder := p_amount - v_applied;
  if v_remainder > 0 then
    insert into public.partner_account_events(
      account_id, partner_id, currency, kind, available_delta,
      reason, actor_id, command_key)
    values (v_acct.id, p_partner_id, v_cur, 'credit', v_remainder,
            left(btrim(p_reason), 700), v_actor.id, p_command_key);
  end if;

  v_result := jsonb_build_object(
    'partner_id', p_partner_id, 'currency', v_cur, 'credit_received', p_amount,
    'debt_applied', v_applied, 'remainder_available', v_remainder,
    'allocations', v_allocations,
    'available', (select available from public.partner_accounts where id = v_acct.id),
    'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'partner_credit', v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_partner_credit(text,text,numeric,numeric,text,text) from public, anon;
grant execute on function public.sarraf_partner_credit(text,text,numeric,numeric,text,text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Office payment assignments (§13E)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.office_payment_assignments (
  id text primary key,
  office_id text not null references public.app_users(id),
  transaction_id text,
  customer_id text references public.app_users(id),
  -- Amount and currency are copied from the transaction; neither office nor client sets them.
  amount numeric(38,10) not null,
  currency text not null,
  amount_paid numeric(38,10) not null default 0,
  status public.office_assignment_status not null default 'assigned',
  due_at timestamptz,
  payment_reference text,
  payment_note text,
  evidence_path text,
  assigned_by text not null references public.app_users(id),
  assigned_at timestamptz not null default statement_timestamp(),
  reported_at timestamptz,
  confirmed_by text references public.app_users(id),
  confirmed_at timestamptz,
  rejected_reason text,
  version bigint not null default 1,
  command_key text,
  check (currency ~ '^[A-Z]{3,8}$'),
  check (amount > 0),
  check (amount_paid >= 0 and amount_paid <= amount)
);
create index if not exists opa_office_idx on public.office_payment_assignments(office_id, status);
create index if not exists opa_tx_idx on public.office_payment_assignments(transaction_id);
create unique index if not exists opa_command_uq
  on public.office_payment_assignments(assigned_by, command_key) where command_key is not null;

create table if not exists public.office_payment_events (
  id bigint generated always as identity primary key,
  assignment_id text not null references public.office_payment_assignments(id),
  from_status public.office_assignment_status,
  to_status public.office_assignment_status not null,
  amount_applied numeric(38,10),
  reference text,
  note text,
  actor_id text not null references public.app_users(id),
  command_key text,
  created_at timestamptz not null default statement_timestamp()
);
create index if not exists ope_assignment_idx on public.office_payment_events(assignment_id, created_at);

-- The office reports; only an authorised verifier confirms. Status may not jump.
create or replace function public.sarraf_office_payment_report(
  p_assignment_id text, p_status public.office_assignment_status,
  p_amount numeric, p_reference text, p_note text, p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_a public.office_payment_assignments%rowtype; v_result jsonb;
  v_paid numeric;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then raise exception using errcode='42501', message='not authorized'; end if;
  select * into v_a from public.office_payment_assignments where id = p_assignment_id for update;
  if not found then raise exception using errcode='P0002', message='assignment not found'; end if;

  -- Only the assigned office, or staff, may touch this assignment.
  if not (v_actor.id = v_a.office_id or v_actor.role = 'admin') then
    raise exception using errcode='42501', message='this office payment assignment is not yours';
  end if;

  if p_status not in ('acknowledged','payment_initiated','paid_reported') then
    raise exception using errcode='22023',
      message='an office may only acknowledge, initiate, or report payment';
  end if;
  if v_a.status in ('confirmed','cancelled','rejected') then
    raise exception using errcode='22023',
      message=format('assignment is %s and no longer accepts reports', v_a.status);
  end if;

  v_paid := v_a.amount_paid;
  if p_status = 'paid_reported' then
    if p_amount is null or p_amount <= 0 then
      raise exception using errcode='22023', message='a payment amount is required';
    end if;
    if v_a.amount_paid + p_amount > v_a.amount then
      raise exception using errcode='23514',
        message=format('reported payment exceeds the assignment: %s of %s already reported',
                       v_a.amount_paid, v_a.amount);
    end if;
    v_paid := v_a.amount_paid + p_amount;
  end if;

  update public.office_payment_assignments
     set status = p_status, amount_paid = v_paid,
         payment_reference = coalesce(left(p_reference, 160), payment_reference),
         payment_note = coalesce(left(p_note, 700), payment_note),
         reported_at = case when p_status = 'paid_reported' then statement_timestamp() else reported_at end,
         version = version + 1
   where id = p_assignment_id;

  insert into public.office_payment_events(
    assignment_id, from_status, to_status, amount_applied, reference, note, actor_id, command_key)
  values (p_assignment_id, v_a.status, p_status,
          case when p_status='paid_reported' then p_amount end,
          left(p_reference,160), left(p_note,700), v_actor.id, p_command_key);

  v_result := jsonb_build_object(
    'assignment_id', p_assignment_id, 'status', p_status,
    'amount_paid', v_paid, 'outstanding', v_a.amount - v_paid);
  return v_result;
end;
$$;
revoke all on function public.sarraf_office_payment_report(text,public.office_assignment_status,numeric,text,text,text) from public, anon;
grant execute on function public.sarraf_office_payment_report(text,public.office_assignment_status,numeric,text,text,text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Security: an office sees only its own assignments; a partner only its own account.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.partner_accounts enable row level security;
alter table public.partner_account_events enable row level security;
alter table public.office_payment_assignments enable row level security;
alter table public.office_payment_events enable row level security;

revoke all on public.partner_accounts, public.partner_account_events,
  public.office_payment_assignments, public.office_payment_events
  from public, anon, authenticated;
grant select on public.partner_accounts, public.partner_account_events,
  public.office_payment_assignments, public.office_payment_events to authenticated;

drop policy if exists pa_staff_read on public.partner_accounts;
create policy pa_staff_read on public.partner_accounts for select to authenticated
  using (public.is_admin() or public.my_role() = 'office');
drop policy if exists pa_own_read on public.partner_accounts;
create policy pa_own_read on public.partner_accounts for select to authenticated
  using (partner_id = public.my_app_id());

drop policy if exists pae_staff_read on public.partner_account_events;
create policy pae_staff_read on public.partner_account_events for select to authenticated
  using (public.is_admin() or public.my_role() = 'office');
drop policy if exists pae_own_read on public.partner_account_events;
create policy pae_own_read on public.partner_account_events for select to authenticated
  using (partner_id = public.my_app_id());

drop policy if exists opa_admin_read on public.office_payment_assignments;
create policy opa_admin_read on public.office_payment_assignments for select to authenticated
  using (public.is_admin());
-- An office sees its own assignments and nobody else's.
drop policy if exists opa_own_read on public.office_payment_assignments;
create policy opa_own_read on public.office_payment_assignments for select to authenticated
  using (office_id = public.my_app_id());

drop policy if exists ope_admin_read on public.office_payment_events;
create policy ope_admin_read on public.office_payment_events for select to authenticated
  using (public.is_admin());
drop policy if exists ope_own_read on public.office_payment_events;
create policy ope_own_read on public.office_payment_events for select to authenticated
  using (exists (select 1 from public.office_payment_assignments a
                 where a.id = office_payment_events.assignment_id
                   and a.office_id = public.my_app_id()));

commit;
