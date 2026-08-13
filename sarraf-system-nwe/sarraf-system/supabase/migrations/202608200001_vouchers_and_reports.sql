-- A voucher for every movement, a profit and loss, and a ledger you can actually read.
--
-- §13.F.1 asks for a numbered voucher for *every* movement of money. Three commands issued one;
-- the rest — an ordinary purchase, a cashbox deposit, a withdrawal, money applied to a debt, a
-- partner credit — moved money and handed nobody a number. A customer asking "which paper is
-- this?" could not be answered for most of what the business does.
--
-- §13.F.6 asks for a profit and loss, realized apart from unrealized, filterable by date,
-- currency and party. The arithmetic existed; the report did not, so the owner could not say
-- what last month came to without adding it up by hand.
--
-- §12 asks that the general ledger be readable. Every entry has been posted correctly since the
-- double-entry core went in, and no screen in the system could open one.
begin;

-- A movement the system itself posts — a trigger, a migration, a reconciliation — has no human
-- behind it. Refusing it a voucher because there is no name to put on it would leave exactly the
-- gap this section exists to close, so the name becomes optional and the number does not.
alter table public.vouchers alter column issued_by drop not null;

-- ── every movement gets a number ─────────────────────────────────────────────
--
-- Issued from the journal entry rather than from each command. Every movement of money already
-- posts exactly one balanced entry naming its source, its party, its actor and its command — so
-- the entry is where a voucher can be minted once, for everything, including commands not
-- written yet. Adding a call to ten commands would have covered ten commands.
--
-- Made idempotent per entry first: the commands that already issue their own voucher post their
-- entry before issuing, so without this the trigger would mint one and the command would mint a
-- second for the same movement.
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
  -- One movement, one number. A command that posts its entry and then asks for a voucher gets
  -- back the one the entry already minted.
  if p_journal_entry_id is not null then
    select * into v_row from public.vouchers where journal_entry_id = p_journal_entry_id limit 1;
    if found then return v_row; end if;
  end if;

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
revoke all on function public.sarraf_issue_voucher(
  public.voucher_kind, public.party_kind, text, public.party_kind, text, text, numeric, text,
  text, text, text, bigint, text, text, jsonb, text) from public, anon, authenticated;

-- Which sort of voucher a business event produces. Anything unrecognised still gets a number —
-- a movement without a paper is the failure this is here to prevent, and an imprecise label is
-- a far smaller problem than no record at all.
create or replace function public.sarraf_voucher_kind_of(p_source_type text)
returns public.voucher_kind
language sql immutable
set search_path = pg_catalog, public
as $$
  select case
    when p_source_type like '%write_off%'        then 'debt_write_off'
    when p_source_type like '%offset%'           then 'debt_offset'
    when p_source_type like '%debt_settlement%'  then 'debt_settlement'
    when p_source_type like '%debt%'             then 'debt_opened'
    when p_source_type like '%office%'           then 'office_payment'
    when p_source_type like '%partner%'          then 'partner_settlement'
    when p_source_type like '%withdraw%'         then 'vault_withdrawal'
    when p_source_type like '%vault%'            then 'vault_deposit'
    when p_source_type like '%revers%'           then 'reversal'
    else 'debt_settlement'
  end::public.voucher_kind;
$$;

create or replace function public.sarraf_voucher_for_entry()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_line record;
begin
  if new.status <> 'posted' then return new; end if;

  -- The amount and the party come from the entry's own lines. The debit side is read because
  -- every entry has exactly one of each and the two carry the same amount.
  select l.currency, l.amount, l.party_type, l.party_id
    into v_line
  from public.journal_lines l
  where l.entry_id = new.id and l.side = 'debit'
  order by l.line_no
  limit 1;

  -- An entry whose lines are not written yet cannot be valued. The lines are inserted in the
  -- same statement as the entry by every command in this system, but a caller that posts an
  -- entry first and its lines after must not be handed a voucher for nothing.
  if not found or v_line.amount is null or v_line.amount <= 0 then return new; end if;

  perform public.sarraf_issue_voucher(
    public.sarraf_voucher_kind_of(new.source_type),
    nullif(v_line.party_type, '')::public.party_kind, v_line.party_id,
    'zeman'::public.party_kind, null,
    v_line.currency, v_line.amount,
    coalesce(nullif(btrim(new.description), ''), new.source_type),
    new.actor_id,
    null, new.id, null, new.transaction_id, new.command_key,
    jsonb_build_object('source_type', new.source_type, 'business_date', new.business_date));
  return new;
end;
$$;

-- Deferred to the end of the transaction, because an entry is written before its lines are:
-- firing at insert would find no lines and hand out a voucher for nothing, or nothing at all.
drop trigger if exists journal_entry_voucher on public.journal_entries;
create constraint trigger journal_entry_voucher
  after insert on public.journal_entries
  deferrable initially deferred
  for each row execute function public.sarraf_voucher_for_entry();

-- An entry posted later rather than at insert gets its number then.
drop trigger if exists journal_entry_voucher_on_post on public.journal_entries;
create trigger journal_entry_voucher_on_post
  after update of status on public.journal_entries
  for each row when (new.status = 'posted' and old.status <> 'posted')
  execute function public.sarraf_voucher_for_entry();

-- ── profit and loss ──────────────────────────────────────────────────────────
--
-- §13.F.3: realized trading profit and unrealized revaluation are different things and are
-- never added together. A rate that moved today tells you nothing about what a completed trade
-- earned, and mixing them is how a business talks itself into a profit it has not made.
--
-- Stated per currency in the currency itself, with the base-currency figure beside it, because
-- there is no such quantity as a total across currencies.
create or replace function public.sarraf_profit_and_loss(
  p_from date default null, p_to date default null,
  p_currency text default null, p_party_id text default null
) returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_from date := coalesce(p_from, date_trunc('month', current_date)::date);
  v_to date := coalesce(p_to, current_date);
  v_cur text := nullif(upper(btrim(coalesce(p_currency, ''))), '');
  v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode = '42501', message = 'the profit and loss report is for administrators';
  end if;
  if v_to < v_from then
    raise exception using errcode = '22023', message = 'the end of the range is before its start';
  end if;

  with lines as (
    select l.*, a.kind as account_kind, a.code as account_code, a.name as account_name,
           e.business_date, e.source_type
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.chart_of_accounts a on a.id = l.account_id
    where e.status = 'posted'
      and e.business_date between v_from and v_to
      and a.kind in ('income', 'expense')
      and (v_cur is null or upper(l.currency) = v_cur)
      and (p_party_id is null or l.party_id = p_party_id)
  ), signed as (
    -- Income is earned on the credit side, expense incurred on the debit side. Each is stated
    -- as a positive figure of its own kind; subtracting one from the other is the caller's job
    -- and is done once, below.
    select account_id, account_code, account_name, account_kind, currency,
           sum(case when account_kind = 'income'
                    then case when side = 'credit' then amount else -amount end
                    else case when side = 'debit' then amount else -amount end end) as amount,
           sum(case when account_kind = 'income'
                    then case when side = 'credit' then base_amount else -base_amount end
                    else case when side = 'debit' then base_amount else -base_amount end end) as base_amount,
           count(*) as line_count
    from lines
    group by account_id, account_code, account_name, account_kind, currency
  ), by_account as (
    select * from signed where amount <> 0
  ), by_currency as (
    select currency,
           sum(case when account_kind = 'income' then amount else 0 end) as income,
           sum(case when account_kind = 'expense' then amount else 0 end) as expense,
           sum(case when account_kind = 'income' then amount else -amount end) as net,
           sum(case when account_kind = 'income' then base_amount else -base_amount end) as net_base
    from by_account group by currency
  ), unrealized as (
    -- §13.F.3: revaluation is reported beside the trading result, never inside it.
    select currency,
           sum(case when account_id = 'acc-4900'
                    then case when side = 'credit' then amount else -amount end
                    when account_id = 'acc-5900'
                    then case when side = 'debit' then -amount else amount end
                    else 0 end) as amount
    from lines where account_id in ('acc-4900', 'acc-5900')
    group by currency
  )
  select jsonb_build_object(
    'from', v_from, 'to', v_to,
    'currency', v_cur, 'party_id', p_party_id,
    'by_account', coalesce((select jsonb_agg(to_jsonb(a) order by a.account_code, a.currency)
                            from by_account a), '[]'::jsonb),
    'by_currency', coalesce((select jsonb_agg(to_jsonb(c) order by c.currency) from by_currency c), '[]'::jsonb),
    -- The realized result is everything except the revaluation accounts.
    'realized', coalesce((select jsonb_agg(jsonb_build_object(
                            'currency', c.currency,
                            'income', c.income,
                            'expense', c.expense,
                            'net', c.net - coalesce((select u.amount from unrealized u where u.currency = c.currency), 0))
                          order by c.currency) from by_currency c), '[]'::jsonb),
    'unrealized', coalesce((select jsonb_agg(to_jsonb(u) order by u.currency)
                            from unrealized u where u.amount <> 0), '[]'::jsonb),
    'calculated_at', statement_timestamp()
  ) into v_result;

  return v_result;
end;
$$;
revoke all on function public.sarraf_profit_and_loss(date, date, text, text) from public, anon;
grant execute on function public.sarraf_profit_and_loss(date, date, text, text) to authenticated;

-- ── the general ledger, readable ─────────────────────────────────────────────
--
-- Bounded on purpose: a ledger screen that fetches everything is a screen nobody can open on a
-- phone, and §12 requires exports to be bounded.
create or replace function public.sarraf_general_ledger(
  p_from date default null, p_to date default null,
  p_account_id text default null, p_party_id text default null,
  p_transaction_id text default null, p_search text default null,
  p_limit int default 100, p_offset int default 0
) returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_from date := coalesce(p_from, (current_date - 30));
  v_to date := coalesce(p_to, current_date);
  v_limit int := greatest(1, least(coalesce(p_limit, 100), 500));
  v_offset int := greatest(0, coalesce(p_offset, 0));
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode = '42501', message = 'the general ledger is for administrators';
  end if;

  with matched as (
    select e.*
    from public.journal_entries e
    where e.business_date between v_from and v_to
      and (p_transaction_id is null or e.transaction_id = p_transaction_id)
      and (p_account_id is null or exists (
            select 1 from public.journal_lines l where l.entry_id = e.id and l.account_id = p_account_id))
      and (p_party_id is null or exists (
            select 1 from public.journal_lines l where l.entry_id = e.id and l.party_id = p_party_id))
      and (v_search is null
           or e.id ilike '%' || v_search || '%'
           or coalesce(e.description, '') ilike '%' || v_search || '%'
           or coalesce(e.transaction_id, '') ilike '%' || v_search || '%'
           or coalesce(e.source_type, '') ilike '%' || v_search || '%')
  ), page as (
    select * from matched order by business_date desc, entry_no desc
    limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'from', v_from, 'to', v_to,
    'total', (select count(*) from matched),
    'limit', v_limit, 'offset', v_offset,
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'entry_no', p.entry_no, 'status', p.status,
        'business_date', p.business_date, 'posted_at', p.posted_at,
        'source_type', p.source_type, 'transaction_id', p.transaction_id,
        'receipt_batch_id', p.receipt_batch_id, 'description', p.description,
        'actor_id', p.actor_id, 'reversal_of', p.reversal_of, 'reversed_by', p.reversed_by,
        'voucher', (select v.reference from public.vouchers v where v.journal_entry_id = p.id limit 1),
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
            'line_no', l.line_no, 'account_id', l.account_id,
            'account_code', a.code, 'account_name', a.name,
            'side', l.side, 'currency', l.currency, 'amount', l.amount,
            'base_amount', l.base_amount, 'base_rate', l.base_rate,
            'party_type', l.party_type, 'party_id', l.party_id, 'memo', l.memo)
          order by l.line_no)
          from public.journal_lines l
          join public.chart_of_accounts a on a.id = l.account_id
          where l.entry_id = p.id), '[]'::jsonb))
      order by p.business_date desc, p.entry_no desc)
      from page p), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;
revoke all on function public.sarraf_general_ledger(date, date, text, text, text, text, int, int) from public, anon;
grant execute on function public.sarraf_general_ledger(date, date, text, text, text, text, int, int) to authenticated;

commit;
