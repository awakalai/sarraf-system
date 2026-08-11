-- Accounting commands.
--
-- Phases 1 and 2 added the ledger, the cashbox and the debt engine. Nothing could write to
-- them: every table is read-only to clients by design. This migration adds the audited,
-- idempotent commands that are the only way money moves, so a browser can never post a
-- journal line, set a balance, or decide a debt's direction.
--
-- Every command here:
--   - resolves the actor from auth.uid() and checks the role itself;
--   - takes a command key and returns the first result on replay instead of acting twice;
--   - posts a balanced journal entry in the same transaction as the subledger change;
--   - records who, why and against which source.
begin;

create table if not exists public.accounting_commands (
  actor_id text not null references public.app_users(id),
  command_key text not null,
  operation text not null,
  result jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (actor_id, command_key),
  check (jsonb_typeof(result) = 'object')
);
alter table public.accounting_commands enable row level security;
revoke all on public.accounting_commands from public, anon, authenticated;

-- Base-currency valuation for a journal line. USD is the base; a rate must be supplied for
-- anything else, because inventing one is how a receipt came to be valued at $1.63.
create or replace function public.sarraf_base_amount(p_amount numeric, p_currency text, p_rate numeric)
returns numeric
language plpgsql immutable
set search_path = pg_catalog
as $$
begin
  if upper(p_currency) = 'USD' then return round(p_amount, 10); end if;
  if p_rate is null or p_rate <= 0 then
    raise exception using errcode='22023',
      message=format('a rate is required to value %s in the base currency', p_currency);
  end if;
  return round(p_amount / p_rate, 10);
end;
$$;

-- Internal helper: create a posted, balanced two-line entry.
create or replace function public.sarraf_post_simple_entry(
  p_id text, p_business_date date, p_source_type text, p_actor_id text,
  p_debit_account text, p_credit_account text,
  p_currency text, p_amount numeric, p_rate numeric,
  p_description text, p_command_key text default null,
  p_party_type text default null, p_party_id text default null,
  p_transaction_id text default null, p_rate_date date default null
) returns text
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_base numeric := public.sarraf_base_amount(p_amount, p_currency, p_rate);
begin
  insert into public.journal_entries(
    id, status, business_date, posted_at, source_type, actor_id, command_key,
    description, transaction_id)
  values (p_id, 'posted', p_business_date, statement_timestamp(), p_source_type, p_actor_id,
          p_command_key, left(p_description, 500), p_transaction_id);

  insert into public.journal_lines(
    entry_id, line_no, account_id, side, currency, amount, base_amount, base_rate,
    rate_date, party_type, party_id)
  values
    (p_id, 1, p_debit_account,  'debit',  upper(p_currency), p_amount, v_base,
     coalesce(p_rate, 1), p_rate_date, p_party_type, p_party_id),
    (p_id, 2, p_credit_account, 'credit', upper(p_currency), p_amount, v_base,
     coalesce(p_rate, 1), p_rate_date, p_party_type, p_party_id);
  return p_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Cashbox deposit / withdrawal
--
-- A deposit increases what ZEMAN holds (asset) and what ZEMAN owes the customer
-- (liability). It is not income. A withdrawal reverses both sides.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sarraf_customer_vault_move(
  p_customer_id text, p_currency text, p_amount numeric, p_direction text,
  p_rate numeric, p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_prev jsonb; v_vault text; v_cur text := upper(btrim(p_currency));
  v_entry text; v_result jsonb; v_available numeric;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role not in ('admin','office') then
    raise exception using errcode='42501', message='cashbox movement is not authorized';
  end if;
  if p_direction not in ('in','out') then
    raise exception using errcode='22023', message='direction must be in or out';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception using errcode='22023', message='amount must be greater than zero';
  end if;
  if v_cur !~ '^[A-Z]{3,8}$' then
    raise exception using errcode='22023', message='invalid currency';
  end if;
  if char_length(btrim(coalesce(p_reason,''))) < 3 then
    raise exception using errcode='22023', message='a reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || p_command_key, 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  if not exists (select 1 from public.app_users
                  where id = p_customer_id and role = 'customer' and not deleted) then
    raise exception using errcode='22023', message='invalid customer';
  end if;

  v_vault := 'cv-' || p_customer_id || '-' || v_cur;
  insert into public.customer_vaults(id, customer_id, currency)
  values (v_vault, p_customer_id, v_cur)
  on conflict (customer_id, currency) do nothing;
  select id into v_vault from public.customer_vaults
   where customer_id = p_customer_id and currency = v_cur;
  -- Serialize concurrent movements against the same cashbox.
  perform 1 from public.customer_vaults where id = v_vault for update;

  v_entry := 'je-vault-' || md5(v_actor.id || ':' || p_command_key);
  if p_direction = 'in' then
    perform public.sarraf_post_simple_entry(
      v_entry, current_date, 'customer_vault_deposit', v_actor.id,
      'acc-1000', 'acc-2000', v_cur, p_amount, p_rate,
      format('قاسەی کڕیار — دانان %s %s', p_amount, v_cur), p_command_key,
      'customer', p_customer_id);
  else
    perform public.sarraf_post_simple_entry(
      v_entry, current_date, 'customer_vault_withdrawal', v_actor.id,
      'acc-2000', 'acc-1000', v_cur, p_amount, p_rate,
      format('قاسەی کڕیار — دەرهێنان %s %s', p_amount, v_cur), p_command_key,
      'customer', p_customer_id);
  end if;

  insert into public.customer_vault_events(
    vault_id, customer_id, currency, kind, available_delta,
    journal_entry_id, reason, actor_id, command_key)
  values (v_vault, p_customer_id, v_cur,
          case when p_direction = 'in' then 'deposit' else 'withdrawal' end::public.vault_event_kind,
          case when p_direction = 'in' then p_amount else -p_amount end,
          v_entry, left(btrim(p_reason), 700), v_actor.id, p_command_key);

  select available into v_available from public.customer_vaults where id = v_vault;
  v_result := jsonb_build_object(
    'vault_id', v_vault, 'customer_id', p_customer_id, 'currency', v_cur,
    'direction', p_direction, 'amount', p_amount, 'available', v_available,
    'journal_entry_id', v_entry, 'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'customer_vault_move', v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_customer_vault_move(text,text,numeric,text,numeric,text,text) from public, anon;
grant execute on function public.sarraf_customer_vault_move(text,text,numeric,text,numeric,text,text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Settle a customer's debt from their own cashbox, same currency only.
-- Applies the deterministic waterfall and posts one entry per debt touched.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sarraf_apply_vault_to_debt(
  p_customer_id text, p_currency text, p_amount numeric, p_rate numeric,
  p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_vault public.customer_vaults%rowtype;
  v_cur text := upper(btrim(p_currency)); r record; v_applied numeric := 0; v_n int := 0;
  v_entry text; v_event bigint; v_result jsonb; v_allocations jsonb := '[]'::jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role not in ('admin','office') then
    raise exception using errcode='42501', message='debt settlement is not authorized';
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

  select * into v_vault from public.customer_vaults
   where customer_id = p_customer_id and currency = v_cur for update;
  if not found then
    raise exception using errcode='22023', message='the customer has no cashbox in this currency';
  end if;
  if v_vault.available < p_amount then
    raise exception using errcode='23514',
      message=format('cashbox holds %s %s, less than the %s requested',
                     v_vault.available, v_cur, p_amount);
  end if;

  -- Take the money out of the cashbox once, then allocate it across debts.
  insert into public.customer_vault_events(
    vault_id, customer_id, currency, kind, available_delta, reason, actor_id, command_key)
  values (v_vault.id, p_customer_id, v_cur, 'apply_to_customer_debt', -p_amount,
          left(btrim(p_reason), 700), v_actor.id, p_command_key)
  returning id into v_event;

  for r in
    select * from public.sarraf_debt_waterfall('customer', p_customer_id, 'zeman', null, v_cur, p_amount)
  loop
    v_n := v_n + 1;
    v_entry := 'je-debt-' || md5(v_actor.id || ':' || p_command_key || ':' || r.debt_id);
    -- Settling a customer debt clears a receivable against the liability just drawn down.
    perform public.sarraf_post_simple_entry(
      v_entry, current_date, 'customer_debt_settlement', v_actor.id,
      'acc-2000', 'acc-1200', v_cur, r.allocated, p_rate,
      format('تسویەی قەرز لە قاسەی کڕیار — %s %s', r.allocated, v_cur),
      p_command_key || ':' || r.debt_id, 'customer', p_customer_id);

    insert into public.debt_settlements(
      debt_id, amount_applied, outstanding_before, outstanding_after,
      source_kind, vault_event_id, journal_entry_id, actor_id, command_key, reason)
    values (r.debt_id, r.allocated, r.outstanding, r.outstanding - r.allocated,
            'customer_vault', v_event, v_entry, v_actor.id,
            p_command_key || ':' || r.debt_id, left(btrim(p_reason), 700));

    v_applied := v_applied + r.allocated;
    v_allocations := v_allocations || jsonb_build_object(
      'debt_id', r.debt_id, 'applied', r.allocated,
      'outstanding_after', r.outstanding - r.allocated);
  end loop;

  if v_applied < p_amount then
    -- Nothing left to settle: return the unallocated remainder to the cashbox rather than
    -- letting it disappear.
    insert into public.customer_vault_events(
      vault_id, customer_id, currency, kind, available_delta, reason, actor_id, command_key)
    values (v_vault.id, p_customer_id, v_cur, 'adjustment', p_amount - v_applied,
            'گەڕاندنەوەی بڕی تەرخان‌نەکراو بۆ قاسە', v_actor.id, p_command_key || ':remainder');
  end if;

  v_result := jsonb_build_object(
    'customer_id', p_customer_id, 'currency', v_cur, 'requested', p_amount,
    'applied', v_applied, 'returned_to_vault', p_amount - v_applied,
    'debts_settled', v_n, 'allocations', v_allocations,
    'available', (select available from public.customer_vaults where id = v_vault.id),
    'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'apply_vault_to_debt', v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_apply_vault_to_debt(text,text,numeric,numeric,text,text) from public, anon;
grant execute on function public.sarraf_apply_vault_to_debt(text,text,numeric,numeric,text,text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Move a debt ZEMAN owes a customer into that customer's cashbox.
-- Closes the debt and credits the liability once — never both.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.sarraf_zeman_debt_to_vault(
  p_debt_id text, p_amount numeric, p_rate numeric, p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_debt public.debts%rowtype;
  v_vault text; v_entry text; v_result jsonb; v_amount numeric;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='only an administrator may credit a cashbox from a debt';
  end if;
  if char_length(btrim(coalesce(p_reason,''))) < 3 then
    raise exception using errcode='22023', message='a reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || p_command_key, 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  select * into v_debt from public.debts where id = p_debt_id for update;
  if not found then raise exception using errcode='P0002', message='debt not found'; end if;
  if v_debt.debtor_type <> 'zeman' or v_debt.creditor_type <> 'customer' then
    raise exception using errcode='22023',
      message='this command only moves a debt ZEMAN owes a customer';
  end if;
  if v_debt.status not in ('open','partially_settled') then
    raise exception using errcode='22023', message='the debt is not open';
  end if;

  v_amount := least(coalesce(p_amount, v_debt.outstanding_principal), v_debt.outstanding_principal);
  if v_amount <= 0 then
    raise exception using errcode='22023', message='amount must be greater than zero';
  end if;

  insert into public.customer_vaults(id, customer_id, currency)
  values ('cv-' || v_debt.creditor_id || '-' || v_debt.currency, v_debt.creditor_id, v_debt.currency)
  on conflict (customer_id, currency) do nothing;
  select id into v_vault from public.customer_vaults
   where customer_id = v_debt.creditor_id and currency = v_debt.currency for update;

  -- One liability replaces another: the payable to the customer becomes funds held for them.
  v_entry := 'je-d2v-' || md5(v_actor.id || ':' || p_command_key);
  perform public.sarraf_post_simple_entry(
    v_entry, current_date, 'zeman_debt_to_customer_vault', v_actor.id,
    'acc-1200', 'acc-2000', v_debt.currency, v_amount, p_rate,
    format('گواستنەوەی قەرزی ZEMAN بۆ قاسەی کڕیار — %s %s', v_amount, v_debt.currency),
    p_command_key, 'customer', v_debt.creditor_id);

  insert into public.customer_vault_events(
    vault_id, customer_id, currency, kind, available_delta,
    debt_id, journal_entry_id, reason, actor_id, command_key)
  values (v_vault, v_debt.creditor_id, v_debt.currency, 'credit_from_zeman_debt', v_amount,
          v_debt.id, v_entry, left(btrim(p_reason), 700), v_actor.id, p_command_key);

  insert into public.debt_settlements(
    debt_id, amount_applied, outstanding_before, outstanding_after,
    source_kind, journal_entry_id, actor_id, command_key, reason)
  values (v_debt.id, v_amount, v_debt.outstanding_principal,
          v_debt.outstanding_principal - v_amount, 'credited_to_vault', v_entry,
          v_actor.id, p_command_key, left(btrim(p_reason), 700));

  v_result := jsonb_build_object(
    'debt_id', v_debt.id, 'customer_id', v_debt.creditor_id, 'currency', v_debt.currency,
    'amount', v_amount, 'vault_id', v_vault,
    'available', (select available from public.customer_vaults where id = v_vault),
    'outstanding_after', v_debt.outstanding_principal - v_amount,
    'journal_entry_id', v_entry, 'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'zeman_debt_to_vault', v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_zeman_debt_to_vault(text,numeric,numeric,text,text) from public, anon;
grant execute on function public.sarraf_zeman_debt_to_vault(text,numeric,numeric,text,text) to authenticated;

commit;
