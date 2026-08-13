-- The debt side: a numbered voucher for every movement, a history for every debt, and the two
-- commands the debt centre could not perform.
--
-- Four gaps, one area:
--
--   §13.F.1 — a numbered voucher register. Columns named voucher_id have existed since the
--   cashbox was built, but nothing ever issued a voucher, so they were always null. A debt
--   centre that cannot hand someone a numbered piece of paper is not a debt centre.
--
--   §13.C.6 — bilateral netting. When two parties owe each other in the same currency, the
--   settlement is one entry that reduces both, not two payments that never happen.
--
--   §13.C.7 — waiving and writing off. A debt that will not be collected has to leave the
--   receivable and become an expense, deliberately and on the record. Until now the only way to
--   clear one was to pretend it had been paid.
--
--   debt_events — the history. debt_settlements records payments; nothing recorded the opening,
--   the offset, the write-off or the void, so a debt's outstanding balance could only be
--   explained by inference.
--
-- Nothing is edited or deleted anywhere below. §1.3: financial history is corrected by posting
-- the opposite, never by rewriting what was posted.
begin;

-- ── the voucher register ─────────────────────────────────────────────────────

do $$ begin
  create type public.voucher_kind as enum (
    'debt_opened', 'debt_settlement', 'debt_offset', 'debt_write_off',
    'vault_deposit', 'vault_withdrawal', 'office_payment', 'partner_settlement',
    'reversal');
exception when duplicate_object then null; end $$;

-- Gapless numbering, deliberately. A sequence is faster but leaves holes wherever a transaction
-- rolls back, and a voucher register with holes in it cannot be audited — nobody can tell a
-- rolled-back number from a destroyed one. One counter row, taken under lock, means a number is
-- only ever consumed by a voucher that actually exists.
create table if not exists public.voucher_counters (
  series text primary key,
  next_number bigint not null default 1,
  check (next_number > 0)
);

create table if not exists public.vouchers (
  id text primary key,
  series text not null,
  number bigint not null,
  -- What a person is handed and what they quote back: V-2026-000001.
  reference text not null,
  kind public.voucher_kind not null,
  party_type public.party_kind,
  party_id text references public.app_users(id),
  counterparty_type public.party_kind,
  counterparty_id text references public.app_users(id),
  currency text not null,
  amount numeric(38,10) not null,
  debt_id text references public.debts(id),
  transaction_id text,
  journal_entry_id text references public.journal_entries(id),
  vault_event_id bigint references public.customer_vault_events(id),
  reason text not null,
  issued_by text not null references public.app_users(id),
  issued_at timestamptz not null default statement_timestamp(),
  -- A voucher is never edited. One that was issued in error is cancelled by issuing its
  -- opposite, and the two point at each other.
  reversal_of text references public.vouchers(id),
  command_key text,
  metadata jsonb not null default '{}'::jsonb,
  unique (series, number),
  unique (reference),
  check (currency ~ '^[A-Z]{3,8}$'),
  check (amount > 0),
  check (char_length(reason) between 3 and 700),
  check (jsonb_typeof(metadata) = 'object')
);
create index if not exists voucher_party_idx on public.vouchers(party_type, party_id, issued_at desc);
create index if not exists voucher_debt_idx on public.vouchers(debt_id, issued_at desc);
create index if not exists voucher_kind_idx on public.vouchers(kind, issued_at desc);
create unique index if not exists voucher_command_uq
  on public.vouchers(issued_by, command_key) where command_key is not null;

create or replace function public.protect_vouchers()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception using errcode = '42501',
    message = 'a voucher is never changed or destroyed; issue a reversing voucher instead';
end;
$$;
drop trigger if exists vouchers_immutable on public.vouchers;
create trigger vouchers_immutable
  before update or delete on public.vouchers
  for each row execute function public.protect_vouchers();

alter table public.vouchers enable row level security;
revoke all on public.vouchers from public, anon;

do $$ begin
  create policy vouchers_own_read on public.vouchers for select to authenticated
    using (public.is_admin()
        or party_id = public.my_app_id()
        or counterparty_id = public.my_app_id());
exception when duplicate_object then null; end $$;
grant select on public.vouchers to authenticated;

-- Issue one. Called by the commands below and by nothing else — a voucher is a consequence of a
-- movement, never a thing someone types in on its own.
create or replace function public.sarraf_issue_voucher(
  p_kind public.voucher_kind,
  p_party_type public.party_kind, p_party_id text,
  p_counterparty_type public.party_kind, p_counterparty_id text,
  p_currency text, p_amount numeric, p_reason text, p_issued_by text,
  p_debt_id text default null, p_journal_entry_id text default null,
  p_vault_event_id bigint default null, p_transaction_id text default null,
  p_command_key text default null, p_metadata jsonb default '{}'::jsonb,
  p_reversal_of text default null
) returns public.vouchers
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_series text := to_char(statement_timestamp(), 'YYYY');
  v_number bigint;
  v_row public.vouchers%rowtype;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception using errcode = '22023', message = 'a voucher must carry an amount';
  end if;

  insert into public.voucher_counters(series) values (v_series) on conflict (series) do nothing;
  update public.voucher_counters
     set next_number = next_number + 1
   where series = v_series
  returning next_number - 1 into v_number;

  insert into public.vouchers(
    id, series, number, reference, kind, party_type, party_id,
    counterparty_type, counterparty_id, currency, amount, debt_id, transaction_id,
    journal_entry_id, vault_event_id, reason, issued_by, reversal_of, command_key, metadata)
  values (
    'v-' || v_series || '-' || lpad(v_number::text, 6, '0'),
    v_series, v_number, 'V-' || v_series || '-' || lpad(v_number::text, 6, '0'),
    p_kind, p_party_type, p_party_id, p_counterparty_type, p_counterparty_id,
    upper(btrim(p_currency)), p_amount, p_debt_id, p_transaction_id,
    p_journal_entry_id, p_vault_event_id, left(btrim(p_reason), 700), p_issued_by,
    p_reversal_of, p_command_key, coalesce(p_metadata, '{}'::jsonb))
  returning * into v_row;

  return v_row;
end;
$$;

-- ── the history of a debt ────────────────────────────────────────────────────

do $$ begin
  create type public.debt_event_kind as enum (
    'opened', 'settled', 'offset', 'written_off', 'voided', 'reinstated');
exception when duplicate_object then null; end $$;

create table if not exists public.debt_events (
  id bigint generated always as identity primary key,
  debt_id text not null references public.debts(id),
  kind public.debt_event_kind not null,
  amount numeric(38,10),
  outstanding_before numeric(38,10),
  outstanding_after numeric(38,10),
  currency text not null,
  actor_id text references public.app_users(id),
  reason text,
  voucher_id text references public.vouchers(id),
  journal_entry_id text references public.journal_entries(id),
  settlement_id bigint references public.debt_settlements(id),
  command_key text,
  created_at timestamptz not null default statement_timestamp(),
  check (currency ~ '^[A-Z]{3,8}$'),
  check (outstanding_after is null or outstanding_after >= 0)
);
create index if not exists debt_event_debt_idx on public.debt_events(debt_id, created_at);
create index if not exists debt_event_kind_idx on public.debt_events(kind, created_at desc);

create or replace function public.protect_debt_events()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception using errcode = '42501',
    message = 'the history of a debt is append-only';
end;
$$;
drop trigger if exists debt_events_immutable on public.debt_events;
create trigger debt_events_immutable
  before update or delete on public.debt_events
  for each row execute function public.protect_debt_events();

alter table public.debt_events enable row level security;
revoke all on public.debt_events from public, anon;
do $$ begin
  create policy debt_events_own_read on public.debt_events for select to authenticated
    using (public.is_admin() or exists (
      select 1 from public.debts d where d.id = debt_id
        and (d.debtor_id = public.my_app_id() or d.creditor_id = public.my_app_id())));
exception when duplicate_object then null; end $$;
grant select on public.debt_events to authenticated;

-- Recorded by the database itself as the debt is opened and settled, so the history cannot be
-- forgotten by a caller that took a different route.
create or replace function public.record_debt_opened()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  insert into public.debt_events(debt_id, kind, amount, outstanding_before, outstanding_after,
    currency, actor_id, reason, journal_entry_id, command_key)
  values (new.id, 'opened', new.original_principal, 0, new.outstanding_principal,
          new.currency, new.created_by, new.reason, new.journal_entry_id, new.command_key);
  return new;
end;
$$;
drop trigger if exists debts_opened_recorded on public.debts;
create trigger debts_opened_recorded
  after insert on public.debts
  for each row execute function public.record_debt_opened();

create or replace function public.record_debt_settled()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  insert into public.debt_events(debt_id, kind, amount, outstanding_before, outstanding_after,
    currency, actor_id, reason, journal_entry_id, settlement_id, command_key)
  select new.debt_id, 'settled', new.amount_applied, new.outstanding_before, new.outstanding_after,
         d.currency, new.actor_id, new.reason, new.journal_entry_id, new.id, new.command_key
  from public.debts d where d.id = new.debt_id;
  return new;
end;
$$;
drop trigger if exists debt_settlements_recorded on public.debt_settlements;
create trigger debt_settlements_recorded
  after insert on public.debt_settlements
  for each row execute function public.record_debt_settled();

-- A voucher is a consequence of a movement, never something a caller issues on its own, so the
-- issuing function is reachable only from the commands below.
revoke all on function public.sarraf_issue_voucher(
  public.voucher_kind, public.party_kind, text, public.party_kind, text, text, numeric, text,
  text, text, text, bigint, text, text, jsonb, text) from public, anon, authenticated;
revoke all on public.voucher_counters from public, anon, authenticated;
alter table public.voucher_counters enable row level security;

-- The ratio a journal entry needs to state the amount in the base currency.
--
-- §4.18: the house's own ratio, or nothing. A netting or a write-off is stopped with a plain
-- business error until the day's ratio has been set, rather than being valued at a number
-- somebody invented at the keyboard or at yesterday's.
create or replace function public.sarraf_required_ratio(p_currency text)
returns numeric
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare v_rate numeric; v_code text := upper(btrim(coalesce(p_currency, '')));
begin
  if v_code = 'USD' then return 1; end if;
  select rate into v_rate from public.currencies where upper(code) = v_code;
  if v_rate is null or v_rate <= 0 then
    raise exception using errcode = '22023',
      message = format('%s has no ratio yet — set the day''s ratio before recording this', v_code);
  end if;
  return v_rate;
end;
$$;
revoke all on function public.sarraf_required_ratio(text) from public, anon;
grant execute on function public.sarraf_required_ratio(text) to authenticated;

-- Which two accounts carry a party's debt in each direction. A netting entry has to name the
-- right pair; posting an offset for a partner against the customer receivable would clear a
-- balance nobody owed.
create or replace function public.sarraf_debt_accounts(p_party public.party_kind)
returns table(receivable text, payable text)
language sql immutable
set search_path = pg_catalog, public
as $$
  select m.receivable, m.payable from (values
    ('customer', 'acc-1200'::text, 'acc-2000'::text),
    ('partner',  'acc-1100',       'acc-2100'),
    ('office',   'acc-1300',       'acc-2200')
  ) as m(kind, receivable, payable)
  where m.kind = p_party::text;
$$;

-- ── §13.C.6: bilateral netting ───────────────────────────────────────────────
--
-- Two debts, same currency, between the same two parties, pointing opposite ways. Neither party
-- pays the other; the smaller amount cancels against the larger and one entry records it. The
-- alternative — two payments that in practice never move — leaves both debts open on the books
-- and both parties believing the other owes them.
create or replace function public.sarraf_offset_debts(
  p_left_debt_id text, p_right_debt_id text, p_amount numeric,
  p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb;
  v_left public.debts%rowtype; v_right public.debts%rowtype;
  v_amount numeric; v_entry text; v_voucher public.vouchers%rowtype; v_result jsonb;
  v_party public.party_kind; v_party_id text; v_accounts record;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='only an administrator may offset debts';
  end if;
  if char_length(btrim(coalesce(p_reason,''))) < 8 then
    raise exception using errcode='22023', message='an 8-character reason is required';
  end if;
  if p_left_debt_id is not distinct from p_right_debt_id then
    raise exception using errcode='22023', message='a debt cannot be offset against itself';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || coalesce(p_command_key,''), 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  -- Locked in a fixed order, so two offsets touching the same pair cannot deadlock.
  if p_left_debt_id < p_right_debt_id then
    select * into v_left from public.debts where id = p_left_debt_id for update;
    select * into v_right from public.debts where id = p_right_debt_id for update;
  else
    select * into v_right from public.debts where id = p_right_debt_id for update;
    select * into v_left from public.debts where id = p_left_debt_id for update;
  end if;
  if v_left.id is null or v_right.id is null then
    raise exception using errcode='P0002', message='both debts must exist';
  end if;

  if v_left.currency <> v_right.currency then
    raise exception using errcode='22023',
      message=format('%s cannot be offset against %s — an offset is not a currency conversion',
                     v_left.currency, v_right.currency);
  end if;

  -- The parties must be the same two, facing opposite ways. Anything else is not netting.
  if not (v_left.debtor_type = v_right.creditor_type
      and v_left.debtor_id is not distinct from v_right.creditor_id
      and v_left.creditor_type = v_right.debtor_type
      and v_left.creditor_id is not distinct from v_right.debtor_id) then
    raise exception using errcode='22023',
      message='an offset requires two debts between the same two parties, facing opposite ways';
  end if;

  if v_left.status in ('settled','written_off','void') or v_right.status in ('settled','written_off','void') then
    raise exception using errcode='23514', message='a closed debt cannot be offset';
  end if;

  v_amount := least(v_left.outstanding_principal, v_right.outstanding_principal,
                    coalesce(nullif(p_amount, 0), least(v_left.outstanding_principal, v_right.outstanding_principal)));
  if v_amount is null or v_amount <= 0 then
    raise exception using errcode='22023', message='there is nothing to offset';
  end if;

  -- Netting is a settlement between ZEMAN and one other party. Two outside parties owing each
  -- other is their own affair and has no entry in these books, so it is refused rather than
  -- posted to accounts that do not describe it.
  if v_left.debtor_type = 'zeman' then
    v_party := v_left.creditor_type; v_party_id := v_left.creditor_id;
  elsif v_left.creditor_type = 'zeman' then
    v_party := v_left.debtor_type; v_party_id := v_left.debtor_id;
  else
    raise exception using errcode='22023',
      message='an offset must be between ZEMAN and one other party';
  end if;

  select * into v_accounts from public.sarraf_debt_accounts(v_party);
  if not found then
    raise exception using errcode='22023',
      message=format('there is no debt account pair for a %s', v_party);
  end if;

  -- One entry: what ZEMAN owes falls, and what is owed to ZEMAN falls with it. No cash moves,
  -- because none did in life either.
  v_entry := 'je-offset-' || md5(v_actor.id || ':' || coalesce(p_command_key,'') || ':' || v_left.id || ':' || v_right.id);
  perform public.sarraf_post_simple_entry(
    v_entry, current_date, 'debt_offset', v_actor.id,
    v_accounts.payable, v_accounts.receivable,
    v_left.currency, v_amount, public.sarraf_required_ratio(v_left.currency),
    format('دانانەوەی دوولایەنە — %s %s', v_amount, v_left.currency),
    coalesce(p_command_key,'') || ':offset', v_party::text, v_party_id);

  v_voucher := public.sarraf_issue_voucher(
    'debt_offset', v_party, v_party_id, 'zeman'::public.party_kind, null,
    v_left.currency, v_amount, btrim(p_reason), v_actor.id,
    v_left.id, v_entry, null, null, p_command_key,
    jsonb_build_object('left_debt', v_left.id, 'right_debt', v_right.id));

  insert into public.debt_settlements(debt_id, amount_applied, outstanding_before, outstanding_after,
    source_kind, journal_entry_id, actor_id, command_key, reason)
  values (v_left.id, v_amount, v_left.outstanding_principal, v_left.outstanding_principal - v_amount,
          'offset', v_entry, v_actor.id, coalesce(p_command_key,'') || ':left', btrim(p_reason)),
         (v_right.id, v_amount, v_right.outstanding_principal, v_right.outstanding_principal - v_amount,
          'offset', v_entry, v_actor.id, coalesce(p_command_key,'') || ':right', btrim(p_reason));

  insert into public.debt_events(debt_id, kind, amount, outstanding_before, outstanding_after,
    currency, actor_id, reason, voucher_id, journal_entry_id, command_key)
  values (v_left.id, 'offset', v_amount, v_left.outstanding_principal,
          v_left.outstanding_principal - v_amount, v_left.currency, v_actor.id, btrim(p_reason),
          v_voucher.id, v_entry, p_command_key),
         (v_right.id, 'offset', v_amount, v_right.outstanding_principal,
          v_right.outstanding_principal - v_amount, v_right.currency, v_actor.id, btrim(p_reason),
          v_voucher.id, v_entry, p_command_key);

  v_result := jsonb_build_object(
    'left_debt', v_left.id, 'right_debt', v_right.id, 'currency', v_left.currency,
    'offset_amount', v_amount,
    'left_outstanding_after', v_left.outstanding_principal - v_amount,
    'right_outstanding_after', v_right.outstanding_principal - v_amount,
    'voucher', v_voucher.reference, 'journal_entry_id', v_entry, 'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'offset_debts', v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_offset_debts(text,text,numeric,text,text) from public, anon;
grant execute on function public.sarraf_offset_debts(text,text,numeric,text,text) to authenticated;

-- ── §13.C.7: waiving and writing off ─────────────────────────────────────────
--
-- A debt that will not be collected leaves the receivable and becomes an expense. It is not
-- deleted and it is not marked paid: the books must show that the money was given up, and by
-- whom, and why. A longer reason is demanded than for a settlement, because unlike a settlement
-- nothing arrived in exchange.
create or replace function public.sarraf_write_off_debt(
  p_debt_id text, p_amount numeric, p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_debt public.debts%rowtype;
  v_amount numeric; v_entry text; v_voucher public.vouchers%rowtype; v_result jsonb;
  v_after numeric; v_accounts record;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='only an administrator may write off a debt';
  end if;
  if coalesce(v_actor.admin_level, '') <> 'owner' then
    raise exception using errcode='42501',
      message='writing off a debt is the system owner''s decision';
  end if;
  if char_length(btrim(coalesce(p_reason,''))) < 12 then
    raise exception using errcode='22023',
      message='a 12-character reason is required to give up a debt';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || coalesce(p_command_key,''), 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  select * into v_debt from public.debts where id = p_debt_id for update;
  if not found then raise exception using errcode='P0002', message='debt not found'; end if;
  if v_debt.status in ('settled','written_off','void') then
    raise exception using errcode='23514',
      message=format('debt %s is already %s', v_debt.id, v_debt.status);
  end if;

  v_amount := least(coalesce(nullif(p_amount, 0), v_debt.outstanding_principal),
                    v_debt.outstanding_principal);
  if v_amount is null or v_amount <= 0 then
    raise exception using errcode='22023', message='there is nothing outstanding to write off';
  end if;
  v_after := v_debt.outstanding_principal - v_amount;

  -- Only a debt owed *to* ZEMAN can be written off here: the house is giving up money it is
  -- owed, and that is an expense. A debt ZEMAN owes that the other party forgives is the
  -- opposite event, lands in income, and is not this command wearing a different hat.
  if v_debt.creditor_type <> 'zeman' then
    raise exception using errcode='22023',
      message='only a debt owed to ZEMAN can be written off here';
  end if;
  select * into v_accounts from public.sarraf_debt_accounts(v_debt.debtor_type);
  if not found then
    raise exception using errcode='22023',
      message=format('there is no debt account pair for a %s', v_debt.debtor_type);
  end if;

  -- The loss lands in operating expense against the receivable it clears.
  v_entry := 'je-writeoff-' || md5(v_actor.id || ':' || coalesce(p_command_key,'') || ':' || v_debt.id);
  perform public.sarraf_post_simple_entry(
    v_entry, current_date, 'debt_write_off', v_actor.id,
    'acc-5200', v_accounts.receivable, v_debt.currency, v_amount,
    public.sarraf_required_ratio(v_debt.currency),
    format('سڕینەوەی قەرز — %s %s', v_amount, v_debt.currency),
    coalesce(p_command_key,'') || ':writeoff', v_debt.debtor_type::text, v_debt.debtor_id);

  v_voucher := public.sarraf_issue_voucher(
    'debt_write_off', v_debt.debtor_type, v_debt.debtor_id,
    v_debt.creditor_type, v_debt.creditor_id, v_debt.currency, v_amount,
    btrim(p_reason), v_actor.id, v_debt.id, v_entry, null, null, p_command_key,
    jsonb_build_object('outstanding_before', v_debt.outstanding_principal,
                       'outstanding_after', v_after));

  -- Written down directly rather than through a settlement: nothing was paid, and calling this
  -- a settlement would put it in the same column as money that actually arrived.
  update public.debts
     set outstanding_principal = v_after,
         status = case when v_after = 0 then 'written_off'::public.debt_status
                       else 'partially_settled'::public.debt_status end,
         closed_at = case when v_after = 0 then statement_timestamp() else null end
   where id = v_debt.id;

  insert into public.debt_events(debt_id, kind, amount, outstanding_before, outstanding_after,
    currency, actor_id, reason, voucher_id, journal_entry_id, command_key)
  values (v_debt.id, 'written_off', v_amount, v_debt.outstanding_principal, v_after,
          v_debt.currency, v_actor.id, btrim(p_reason), v_voucher.id, v_entry, p_command_key);

  v_result := jsonb_build_object(
    'debt_id', v_debt.id, 'currency', v_debt.currency, 'written_off', v_amount,
    'outstanding_after', v_after,
    'status', case when v_after = 0 then 'written_off' else 'partially_settled' end,
    'voucher', v_voucher.reference, 'journal_entry_id', v_entry, 'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'write_off_debt', v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_write_off_debt(text,numeric,text,text) from public, anon;
grant execute on function public.sarraf_write_off_debt(text,numeric,text,text) to authenticated;

-- ── reading the register ─────────────────────────────────────────────────────

create or replace function public.sarraf_voucher_register(
  p_party_id text default null, p_from date default null, p_to date default null, p_limit int default 200
) returns jsonb
language plpgsql security definer stable
set search_path = pg_catalog, public
as $$
declare v_actor public.app_users%rowtype; v_limit int := greatest(1, least(coalesce(p_limit,200), 500));
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then
    raise exception using errcode='42501', message='the voucher register is not authorized';
  end if;
  -- Staff read the whole register; everyone else reads the vouchers they are named on.
  return coalesce((
    select jsonb_agg(to_jsonb(v) order by v.issued_at desc)
    from (
      select id, reference, kind, party_type, party_id, counterparty_type, counterparty_id,
             currency, amount, debt_id, journal_entry_id, reason, issued_by, issued_at, reversal_of
      from public.vouchers
      where (v_actor.role = 'admin'
             or party_id = v_actor.id or counterparty_id = v_actor.id)
        and (p_party_id is null or party_id = p_party_id or counterparty_id = p_party_id)
        and (p_from is null or issued_at >= p_from)
        and (p_to is null or issued_at < (p_to + 1))
      order by issued_at desc
      limit v_limit
    ) v), '[]'::jsonb);
end;
$$;
revoke all on function public.sarraf_voucher_register(text,date,date,int) from public, anon;
grant execute on function public.sarraf_voucher_register(text,date,date,int) to authenticated;

create or replace function public.sarraf_debt_history(p_debt_id text)
returns jsonb
language plpgsql security definer stable
set search_path = pg_catalog, public
as $$
declare v_actor public.app_users%rowtype; v_debt public.debts%rowtype;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then raise exception using errcode='42501', message='not authorized'; end if;
  select * into v_debt from public.debts where id = p_debt_id;
  if not found then raise exception using errcode='P0002', message='debt not found'; end if;
  if v_actor.role <> 'admin'
     and v_debt.debtor_id is distinct from v_actor.id
     and v_debt.creditor_id is distinct from v_actor.id then
    raise exception using errcode='42501', message='this debt is not yours';
  end if;

  return jsonb_build_object(
    'debt_id', v_debt.id, 'currency', v_debt.currency, 'status', v_debt.status,
    'original_principal', v_debt.original_principal,
    'outstanding_principal', v_debt.outstanding_principal,
    'events', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.created_at, e.id)
      from (
        select ev.id, ev.kind, ev.amount, ev.outstanding_before, ev.outstanding_after,
               ev.currency, ev.actor_id, ev.reason, ev.created_at, vo.reference as voucher
        from public.debt_events ev
        left join public.vouchers vo on vo.id = ev.voucher_id
        where ev.debt_id = p_debt_id
      ) e), '[]'::jsonb));
end;
$$;
revoke all on function public.sarraf_debt_history(text) from public, anon;
grant execute on function public.sarraf_debt_history(text) to authenticated;

commit;
