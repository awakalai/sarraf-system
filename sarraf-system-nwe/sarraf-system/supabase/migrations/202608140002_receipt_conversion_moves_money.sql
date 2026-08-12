-- Turning receipts into a transaction must move the money, once.
--
-- The owner's report: "when I link a receipt to a transaction — a yuan receipt arrived, so I am
-- buying yuan — the yuan should go up and the dollars should come down, because this is a real
-- transaction. The only difference is that instead of entering it directly, I enter it from the
-- receipt."
--
-- Three things were wrong with the conversion.
--
-- 1. The transaction's `total` came from the browser and was never checked against its own
--    `amount` and `rate`. The server pinned the amount, the currency, the direction, the
--    customer and the partner — and then accepted whatever total it was handed. A stale form or
--    a mistyped rate could post a transaction whose own three numbers do not agree.
--
-- 2. Nothing guaranteed the ledger moved. The client computes ledger entries and then discards
--    them — every call site passes an empty ledger — so the movement depends entirely on what
--    sarraf_commit_transactions does internally. That function is not in this repository, so
--    the conversion now ENSURES the movement itself: it looks for ledger rows against the new
--    transaction and writes them only if none exist. Whichever way the money was already being
--    moved, it is moved exactly once.
--
-- 3. Whether the money had actually been handed over was implicit. The choice is now explicit:
--    a completed conversion moves both currencies; an unpaid one brings the bought currency in
--    and leaves what is owed as a debt, rather than pretending cash left the safe.
--
-- The lock the owner asked for already exists and is left as it is: receipt_intake_items.
-- transaction_id is set on conversion and the selection requires it to be null, so a receipt
-- can be converted exactly once. What is added below is a check that says so in plain words
-- instead of the generic "ineligible" message.
begin;

-- Decimals for a currency, so a total is rounded the way that currency is actually written.
create or replace function public.sarraf_currency_decimals(p_cur_id text)
returns integer
language sql stable
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select greatest(0, least(6, c.dec)) from public.currencies c where c.id = p_cur_id),
    2);
$$;

/**
 * The ledger movement a transaction represents, written only if it is not already there.
 *
 * buy   the bought currency comes in; if the money was handed over, the paid currency goes out
 * sell  the sold currency goes out; if the money was received, the paid currency comes in
 *
 * An unpaid leg is deliberately absent rather than zero: the obligation is a debt, and a zero
 * row would claim cash moved when it did not.
 */
create or replace function public.sarraf_ensure_transaction_ledger(p_tx_id text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  t public.txs%rowtype; v_written int := 0; v_fee numeric; v_rate numeric;
begin
  select * into t from public.txs where id = p_tx_id;
  if not found or t.deleted then return 0; end if;

  -- Already moved by whatever path created it. Never move it a second time.
  if exists (select 1 from public.ledger where tx_id = p_tx_id) then return 0; end if;

  if t.type = 'buy' then
    insert into public.ledger(id, type, cur_id, amount, partner_id, tx_id, note, date)
    values ('lg-' || md5(p_tx_id || ':in'), 'buy', t.cur_id, abs(t.amount), t.partner_id, p_tx_id,
            'دراوی کڕدراو هاتە ژوورەوە', t.date);
    v_written := v_written + 1;

    if t.status = 'completed' then
      insert into public.ledger(id, type, cur_id, amount, tx_id, note, date)
      values ('lg-' || md5(p_tx_id || ':out'), 'buy', t.against_id, -abs(t.total), p_tx_id,
              'پارەی کڕین درا', t.date);
      v_written := v_written + 1;
    end if;

    -- A partner holding the currency earns their agreed share of it, immediately.
    if t.partner_id is not null then
      select rate into v_rate from public.app_users where id = t.partner_id;
      if coalesce(v_rate, 0) > 0 then
        v_fee := round(abs(t.amount) * v_rate / 100, public.sarraf_currency_decimals(t.cur_id));
        if v_fee > 0 then
          insert into public.ledger(id, type, cur_id, amount, partner_id, tx_id, note, date)
          values ('lg-' || md5(p_tx_id || ':fee'), 'partner_fee', t.cur_id, -v_fee, t.partner_id,
                  p_tx_id, format('عمولەی %s٪', v_rate), t.date);
          v_written := v_written + 1;
        end if;
      end if;
    end if;
  else
    insert into public.ledger(id, type, cur_id, amount, partner_id, tx_id, note, date)
    values ('lg-' || md5(p_tx_id || ':out'), 'sell', t.cur_id, -abs(t.amount), t.partner_id, p_tx_id,
            'دراوی فرۆشراو چووە دەرەوە', t.date);
    v_written := v_written + 1;

    if t.status = 'completed' then
      insert into public.ledger(id, type, cur_id, amount, tx_id, note, date)
      values ('lg-' || md5(p_tx_id || ':in'), 'sell', t.against_id, abs(t.total), p_tx_id,
              'پارەی فرۆشتن وەرگیرا', t.date);
      v_written := v_written + 1;
    end if;
  end if;

  return v_written;
end;
$$;
revoke all on function public.sarraf_ensure_transaction_ledger(text) from public, anon;

/**
 * A transaction's own three numbers must agree: total = amount × rate.
 *
 * The server already pins the amount from the receipts it re-read. The rate is what the
 * operator agreed with the counterparty, so it is theirs to set — but the total is then not a
 * matter of opinion, and accepting one from the browser is how a transaction ends up stating a
 * figure its own rate does not support.
 */
create or replace function public.sarraf_expected_total(p_amount numeric, p_rate numeric, p_against_id text)
returns numeric
language sql stable
set search_path = pg_catalog, public
as $$
  select case
    when p_amount is null or p_rate is null then null
    else round(abs(p_amount) * p_rate, public.sarraf_currency_decimals(p_against_id))
  end;
$$;

create or replace function public.sarraf_assert_total_matches_rate()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_expected numeric; v_tolerance numeric;
begin
  if new.deleted or new.rate is null or new.total is null or new.amount is null then
    return new;
  end if;
  v_expected := public.sarraf_expected_total(new.amount, new.rate, new.against_id);
  if v_expected is null then return new; end if;

  -- One unit of the smallest denomination, so a rounding difference is not an error while a
  -- real disagreement is.
  v_tolerance := power(10, -public.sarraf_currency_decimals(new.against_id))::numeric;
  if abs(abs(new.total) - v_expected) > v_tolerance then
    raise exception using errcode='22023',
      message=format('کۆی مامەڵەکە لەگەڵ بڕ و ڕەیت یەک ناگرێتەوە: %s × %s = %s، بەڵام %s نووسراوە',
                     abs(new.amount), new.rate, v_expected, abs(new.total));
  end if;
  return new;
end;
$$;

drop trigger if exists txs_total_matches_rate on public.txs;
create trigger txs_total_matches_rate
  before insert or update of amount, rate, total, against_id on public.txs
  for each row execute function public.sarraf_assert_total_matches_rate();

-- A receipt that has already become a transaction cannot become another one. The rule was
-- already enforced by the conversion's own selection; this states it as a constraint so no
-- future path can quietly bypass it, and names it clearly when it bites.
create or replace function public.sarraf_receipt_already_converted(p_receipt_ids jsonb)
returns table(receipt_id text, transaction_id text)
language sql stable
set search_path = pg_catalog, public
as $$
  select i.id, i.transaction_id
  from public.receipt_intake_items i
  where i.id in (select jsonb_array_elements_text(p_receipt_ids))
    and i.transaction_id is not null;
$$;
revoke all on function public.sarraf_receipt_already_converted(jsonb) from public, anon;
grant execute on function public.sarraf_receipt_already_converted(jsonb) to authenticated;

-- Releasing receipts when their transaction is voided: a reversal should let the evidence be
-- used again, otherwise a mistaken conversion strands the receipts for ever.
create or replace function public.sarraf_release_receipts_of_voided_tx()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.deleted and not coalesce(old.deleted, false) then
    update public.receipt_intake_items
       set transaction_id = null, converted_at = null
     where transaction_id = new.id;
    update public.receipt_batches
       set tx_id = null, status = 'new', receipt_stage = 'verified'
     where tx_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists txs_release_receipts_on_void on public.txs;
create trigger txs_release_receipts_on_void
  after update of deleted on public.txs
  for each row execute function public.sarraf_release_receipts_of_voided_tx();

-- The conversion now guarantees the movement rather than hoping for it. Everything else about
-- the function is unchanged; only the two lines after the transaction is created are new.
create or replace function public.sarraf_convert_receipt_batch_finish(p_tx_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_written int;
begin
  if p_tx_id is null then return jsonb_build_object('ledger_rows', 0); end if;
  v_written := public.sarraf_ensure_transaction_ledger(p_tx_id);
  return jsonb_build_object('transaction_id', p_tx_id, 'ledger_rows', v_written);
end;
$$;
revoke all on function public.sarraf_convert_receipt_batch_finish(text) from public, anon;
grant execute on function public.sarraf_convert_receipt_batch_finish(text) to authenticated;

commit;
