-- Post every transaction to the double-entry journal.
--
-- The ledger from phase 1 was correct but empty: nothing in the application wrote to it.
-- This closes that gap without touching the existing commit path. A trigger on public.txs
-- posts the entry, so sarraf_commit_transactions and every other writer are covered, whatever
-- route they took.
--
-- The economics of an exchange trade:
--
--   BUY   ZEMAN receives cur_id and pays against_id.
--         Dr currency inventory (what came in), Cr cash or a payable (what went out).
--   SELL  ZEMAN gives cur_id and receives against_id.
--         Dr cash or a receivable (what came in), Cr currency inventory (what went out).
--
-- Valued in USD the two sides rarely match to the cent, and that difference is not an error:
-- it is the spread ZEMAN earned or lost. It is posted explicitly to income or expense, which
-- is what makes the entry balance honestly instead of being forced.
--
-- A transaction whose currency has no USD rate cannot be valued. Rather than inventing a rate
-- or blocking the trade, the entry is written as a DRAFT carrying the reason. Drafts are
-- excluded from the trial balance, and v_journal_drafts lists them for an operator to resolve.
begin;

-- A pending trade leaves one leg unsettled. That obligation is not a customer deposit, so it
-- gets its own account rather than being conflated with the cashbox liability.
insert into public.chart_of_accounts (id, code, name, kind, normal_side, is_control, subledger)
values ('acc-2300','2300','قەرزی ZEMAN بۆ کڕیاران — Customer payable','liability','credit', true, 'transaction')
on conflict (id) do nothing;

-- USD value of an amount, using the daily rate held on the currency (1 USD = X currency).
-- Returns null when no rate exists; the caller must then refuse to guess.
create or replace function public.sarraf_usd_value(p_amount numeric, p_cur_id text)
returns numeric
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare v_buy numeric; v_sell numeric; v_rate numeric;
begin
  if p_amount is null then return null; end if;
  if lower(p_cur_id) = 'usd' then return round(p_amount, 10); end if;
  select buy_rate, sell_rate into v_buy, v_sell from public.currencies where id = p_cur_id;
  -- Mid rate: neither side of the spread is privileged for bookkeeping valuation.
  v_rate := case
    when v_buy > 0 and v_sell > 0 then (v_buy + v_sell) / 2
    else coalesce(nullif(v_buy, 0), nullif(v_sell, 0))
  end;
  if v_rate is null or v_rate <= 0 then return null; end if;
  return round(p_amount / v_rate, 10);
end;
$$;

create or replace function public.post_transaction_journal()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry text;
  v_cur_code text; v_against_code text;
  v_amount numeric; v_total numeric;
  v_amount_usd numeric; v_total_usd numeric;
  v_rate_cur numeric; v_rate_against numeric;
  v_spread numeric;
  v_inventory constant text := 'acc-1400';
  v_cash text; v_settled boolean;
  v_line int := 0;
  v_draft boolean := false;
  v_note text;
begin
  -- A voided transaction is corrected by reversal, which is a separate command.
  if new.deleted then return null; end if;
  -- Only post once per transaction; a later edit does not silently rewrite history.
  if exists (select 1 from public.journal_entries
              where source_type = 'transaction' and source_id = new.id) then
    return null;
  end if;

  select code into v_cur_code from public.currencies where id = new.cur_id;
  select code into v_against_code from public.currencies where id = new.against_id;
  if v_cur_code is null or v_against_code is null then return null; end if;

  v_amount := abs(new.amount);
  v_total  := abs(new.total);
  if not (v_amount > 0 and v_total > 0) then return null; end if;

  v_amount_usd := public.sarraf_usd_value(v_amount, new.cur_id);
  v_total_usd  := public.sarraf_usd_value(v_total, new.against_id);

  if v_amount_usd is null or v_total_usd is null then
    v_draft := true;
    v_note := format('نرخی USD بۆ %s دانەنراوە — ناتوانرێت بە دۆلار هەڵبسەنگێندرێت',
                     coalesce(case when v_amount_usd is null then v_cur_code else v_against_code end, '?'));
  end if;

  v_settled := new.status = 'completed';
  -- Where the other leg sits: settled money moves through the safe; an unsettled leg is a
  -- receivable when we are owed, a payable when we owe.
  v_cash := case
    when v_settled then 'acc-1000'
    when new.type = 'buy' then 'acc-2300'   -- we owe the counterparty
    else 'acc-1200'                          -- the counterparty owes us
  end;

  v_entry := 'je-tx-' || new.id;

  insert into public.journal_entries(
    id, status, business_date, posted_at, source_type, source_id,
    transaction_id, actor_id, description)
  values (
    v_entry,
    (case when v_draft then 'draft' else 'posted' end)::public.journal_status,
    coalesce(new.date::date, current_date),
    case when v_draft then null else statement_timestamp() end,
    'transaction', new.id, new.id, null,
    left(coalesce(v_note, format('%s %s %s @ %s %s',
      case when new.type = 'buy' then 'کڕین' else 'فرۆشتن' end,
      v_amount, v_cur_code, new.rate, v_against_code)), 500));

  if v_draft then
    -- Record what is known so the entry can be completed once a rate exists, but post nothing.
    return null;
  end if;

  -- The spread is whatever the two valuations differ by, and it is stated, never absorbed.
  v_spread := case when new.type = 'buy'
                   then v_total_usd - v_amount_usd    -- paid more than received = loss
                   else v_total_usd - v_amount_usd    -- received more than given = gain
              end;

  v_rate_cur := case when lower(new.cur_id) = 'usd' then 1 else v_amount / nullif(v_amount_usd, 0) end;
  v_rate_against := case when lower(new.against_id) = 'usd' then 1 else v_total / nullif(v_total_usd, 0) end;

  if new.type = 'buy' then
    v_line := v_line + 1;
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,rate_source,party_type,party_id,memo)
    values (v_entry, v_line, v_inventory, 'debit', v_cur_code, v_amount, v_amount_usd, v_rate_cur,
            'currency_mid', case when new.partner_id is not null then 'partner' end, new.partner_id,
            'دراوی کڕدراو هاتە ژوورەوە');
    v_line := v_line + 1;
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,rate_source,party_type,party_id,memo)
    values (v_entry, v_line, v_cash, 'credit', v_against_code, v_total, v_total_usd, v_rate_against,
            'currency_mid', case when new.cp_id is not null then 'customer' end, new.cp_id,
            case when v_settled then 'پارە درا' else 'پارە هێشتا نەدراوە' end);
    -- Paying more than the goods are worth is a loss; paying less is a gain.
    if abs(v_spread) > 0.0000000001 then
      v_line := v_line + 1;
      insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,rate_source,memo)
      values (v_entry, v_line,
              case when v_spread > 0 then 'acc-5900' else 'acc-4000' end,
              (case when v_spread > 0 then 'debit' else 'credit' end)::public.entry_side,
              'USD', abs(v_spread), abs(v_spread), 1, 'currency_mid',
              'جیاوازی نرخ لە کڕیندا');
    end if;
  else
    v_line := v_line + 1;
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,rate_source,party_type,party_id,memo)
    values (v_entry, v_line, v_cash, 'debit', v_against_code, v_total, v_total_usd, v_rate_against,
            'currency_mid', case when new.cp_id is not null then 'customer' end, new.cp_id,
            case when v_settled then 'پارە وەرگیرا' else 'پارە هێشتا وەرنەگیراوە' end);
    v_line := v_line + 1;
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,rate_source,party_type,party_id,memo)
    values (v_entry, v_line, v_inventory, 'credit', v_cur_code, v_amount, v_amount_usd, v_rate_cur,
            'currency_mid', case when new.partner_id is not null then 'partner' end, new.partner_id,
            'دراوی فرۆشراو چووە دەرەوە');
    -- Receiving more than the goods were worth is the gain.
    if abs(v_spread) > 0.0000000001 then
      v_line := v_line + 1;
      insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,rate_source,memo)
      values (v_entry, v_line,
              case when v_spread > 0 then 'acc-4000' else 'acc-5900' end,
              (case when v_spread > 0 then 'credit' else 'debit' end)::public.entry_side,
              'USD', abs(v_spread), abs(v_spread), 1, 'currency_mid',
              'جیاوازی نرخ لە فرۆشتندا');
    end if;
  end if;

  return null;
end;
$$;

drop trigger if exists txs_post_journal on public.txs;
create trigger txs_post_journal
  after insert or update of status on public.txs
  for each row execute function public.post_transaction_journal();

-- Entries that could not be valued, so an operator can see exactly what is unposted and why.
create or replace view public.v_journal_drafts as
select e.id, e.source_type, e.source_id, e.transaction_id, e.business_date,
       e.description as reason, e.created_at
from public.journal_entries e
where e.status = 'draft'
order by e.created_at desc;

-- Reverse a posted transaction entry instead of editing it (§13A.3).
create or replace function public.sarraf_reverse_transaction_entry(
  p_transaction_id text, p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_src public.journal_entries%rowtype;
  v_rev text; l record; v_n int := 0;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='only an administrator may reverse an entry';
  end if;
  if char_length(btrim(coalesce(p_reason,''))) < 8 then
    raise exception using errcode='22023', message='an 8-character reason is required';
  end if;

  select * into v_src from public.journal_entries
   where source_type='transaction' and source_id=p_transaction_id and status='posted'
   order by created_at limit 1;
  if not found then
    raise exception using errcode='P0002', message='no posted entry for this transaction';
  end if;
  if v_src.reversed_by is not null then
    return jsonb_build_object('entry_id', v_src.id, 'reversal_id', v_src.reversed_by, 'replayed', true);
  end if;

  v_rev := 'je-rev-' || md5(v_src.id || ':' || p_command_key);
  insert into public.journal_entries(
    id,status,business_date,posted_at,source_type,source_id,transaction_id,
    actor_id,command_key,description,reversal_of)
  values (v_rev,'posted',current_date,statement_timestamp(),'transaction_reversal',
          p_transaction_id,p_transaction_id,v_actor.id,p_command_key,
          left(btrim(p_reason),500),v_src.id);

  -- Every line mirrored to the opposite side; the original stays exactly as it was.
  for l in select * from public.journal_lines where entry_id = v_src.id order by line_no loop
    v_n := v_n + 1;
    insert into public.journal_lines(
      entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,
      rate_source,rate_date,party_type,party_id,memo)
    values (v_rev, v_n, l.account_id,
            case when l.side='debit' then 'credit' else 'debit' end::public.entry_side,
            l.currency, l.amount, l.base_amount, l.base_rate,
            l.rate_source, l.rate_date, l.party_type, l.party_id,
            'هەڵوەشاندنەوە: ' || coalesce(l.memo,''));
  end loop;

  update public.journal_entries set reversed_by = v_rev where id = v_src.id;
  update public.journal_entries set status = 'reversed' where id = v_src.id;
  return jsonb_build_object('entry_id', v_src.id, 'reversal_id', v_rev, 'lines', v_n, 'replayed', false);
end;
$$;
revoke all on function public.sarraf_reverse_transaction_entry(text,text,text) from public, anon;
grant execute on function public.sarraf_reverse_transaction_entry(text,text,text) to authenticated;

grant select on public.v_journal_drafts to authenticated;

commit;
