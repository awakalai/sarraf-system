-- Native totals at the currency's scale, not the column's.
--
-- 202608090001 declares receipts.amount as numeric(38,10). Summing such a column and casting the
-- result to text carries all ten decimals into the interface, so a batch of 2520.41 yuan reached
-- the screen as 2520.4100000000. The figure was right and unreadable, which for a total a
-- customer is asked to agree to is the same as being wrong.
--
-- A database that had the table before that migration ran keeps a plain numeric and renders
-- 2520.41, so this is another way the live system and a fresh one disagreed while every gate ran
-- on the fresh one.
--
-- The scale now comes from the currency: dec is what the house quotes this money in, and it is
-- the only scale a reader of this screen has agreed to. USD figures were already rounded to two
-- and are untouched.
begin;

create or replace function public.sarraf_batch_summary(p_batch_id text)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_batch public.receipt_batches%rowtype;
  v_set_version text;
  v_rate_versions text := '';
  v_status text;
  v_currencies jsonb := '[]'::jsonb;
  v_now timestamptz := statement_timestamp();
  v_pending boolean := false;
  r record;
  v_rate jsonb;
  v_rate_value numeric;
  v_usd jsonb;
  v_dec integer;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then
    raise exception using errcode = '42501', message = 'batch summary is not authorized';
  end if;

  select * into v_batch from public.receipt_batches where id = p_batch_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'receipt batch not found';
  end if;

  -- Staff read every batch; everyone else reads the batches that are theirs. The clause keys on
  -- the actor's own id, so the same function serves both without serving one of them too much.
  if v_actor.role not in ('admin', 'office')
     and v_batch.customer_id is distinct from v_actor.id
     and v_batch.partner_id is distinct from v_actor.id
     and v_batch.uploaded_by is distinct from v_actor.id then
    raise exception using errcode = '42501', message = 'this receipt batch is not yours';
  end if;

  v_set_version := public.sarraf_receipt_set_version(p_batch_id);

  for r in
    -- Accepted and counted only. A rejected row is evidence and stays readable, but §4 is
    -- explicit that it is counted towards no total.
    select upper(rc.currency) as currency_code,
           count(*) as n,
           sum(coalesce(rc.amount, 0)) as gross_total,
           sum(coalesce(rc.fee, 0)) as fee_total,
           sum(coalesce(rc.net_amount, coalesce(rc.amount, 0) - coalesce(rc.fee, 0))) as net_total
    from public.receipts rc
    where rc.batch_id = p_batch_id
      and coalesce(rc.counted, true)
      and coalesce(rc.status, '') not in ('dup', 'error')
      and rc.currency is not null
    group by upper(rc.currency)
    order by upper(rc.currency)
  loop
    -- The currency's own decimals, not the column's. dec is what the house quotes this money
    -- in, and it is the only scale a reader of this screen has agreed to.
    v_dec := public.sarraf_currency_decimals(lower(r.currency_code));
    v_rate := public.sarraf_rate_snapshot(r.currency_code);
    v_rate_versions := v_rate_versions || '|' || coalesce(v_rate->>'rate_version', 'pending');

    if v_rate->>'status' = 'ok' then
      v_rate_value := (v_rate->>'rate_value')::numeric;
      -- The whole of §4.12 in four lines: total the native amounts first, divide the total,
      -- round once. Every USD figure states what it came from and what produced it.
      v_usd := jsonb_build_object(
        'status', 'ok',
        'gross_total', jsonb_build_object('amount_decimal', round(r.gross_total / v_rate_value, 2)::text,
                                          'currency_code', 'USD',
                                          'unrounded', (r.gross_total / v_rate_value)::text,
                                          'source_amount', jsonb_build_object('amount_decimal', round(r.gross_total, v_dec)::text, 'currency_code', r.currency_code)),
        'fee_total', jsonb_build_object('amount_decimal', round(r.fee_total / v_rate_value, 2)::text,
                                        'currency_code', 'USD',
                                        'unrounded', (r.fee_total / v_rate_value)::text,
                                        'source_amount', jsonb_build_object('amount_decimal', round(r.fee_total, v_dec)::text, 'currency_code', r.currency_code)),
        'net_total', jsonb_build_object('amount_decimal', round(r.net_total / v_rate_value, 2)::text,
                                        'currency_code', 'USD',
                                        'unrounded', (r.net_total / v_rate_value)::text,
                                        'source_amount', jsonb_build_object('amount_decimal', round(r.net_total, v_dec)::text, 'currency_code', r.currency_code)),
        'order_total', jsonb_build_object('amount_decimal', round(r.net_total / v_rate_value, 2)::text,
                                          'currency_code', 'USD',
                                          'unrounded', (r.net_total / v_rate_value)::text,
                                          'source_amount', jsonb_build_object('amount_decimal', round(r.net_total, v_dec)::text, 'currency_code', r.currency_code)),
        'calculated_at', v_now);
    else
      v_pending := true;
      v_usd := jsonb_build_object('status', 'pending_rate', 'reason', v_rate->>'reason');
    end if;

    v_currencies := v_currencies || jsonb_build_array(jsonb_build_object(
      'currency_code', r.currency_code,
      'count', r.n,
      'native', jsonb_build_object(
        'gross_total', jsonb_build_object('amount_decimal', round(r.gross_total, v_dec)::text, 'currency_code', r.currency_code),
        'fee_total', jsonb_build_object('amount_decimal', round(r.fee_total, v_dec)::text, 'currency_code', r.currency_code),
        'net_total', jsonb_build_object('amount_decimal', round(r.net_total, v_dec)::text, 'currency_code', r.currency_code),
        'order_total', jsonb_build_object('amount_decimal', round(r.net_total, v_dec)::text, 'currency_code', r.currency_code)),
      'usd', v_usd,
      'rate', v_rate,
      -- §4.13: gross must equal net plus fee in the native currency. If it does not, the
      -- receipts disagree with themselves and no valuation of them means anything.
      'equation_holds', abs(r.gross_total - (r.net_total + r.fee_total)) < 0.005));
  end loop;

  v_status := case
    when jsonb_array_length(v_currencies) = 0 then 'empty'
    when v_pending then 'pending_rate'
    else 'ok' end;

  return jsonb_build_object(
    'batch_id', p_batch_id,
    'receipt_set_version', v_set_version,
    'rate_version', md5(v_rate_versions),
    -- The one number both sides quote back. It moves when, and only when, something that
    -- changes the totals has changed.
    'summary_version', md5(p_batch_id || '|' || v_set_version || '|' || md5(v_rate_versions)),
    'calculation_status', v_status,
    'calculated_at', v_now,
    'receipt_stage', v_batch.receipt_stage,
    'finalized', v_batch.receipt_stage = 'finalized',
    'currencies', v_currencies,
    'accepted_count', (select count(*) from public.receipts rc where rc.batch_id = p_batch_id
                        and coalesce(rc.counted, true) and coalesce(rc.status, '') not in ('dup', 'error')),
    'rejected_count', (select count(*) from public.receipts rc where rc.batch_id = p_batch_id
                        and (not coalesce(rc.counted, true) or coalesce(rc.status, '') in ('dup', 'error'))));
end;
$$;

revoke all on function public.sarraf_batch_summary(text) from public, anon;
grant execute on function public.sarraf_batch_summary(text) to authenticated;

commit;
