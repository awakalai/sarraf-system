-- Task A: the details of an indirect trade, assembled once and readable by the partner holding
-- the money.
--
-- The owner's description of the flow:
--
--   "when the admin buys a currency from a seller, sometimes the money is sent straight to a
--    partner to hold rather than coming to the admin. The seller transfers it by WeChat or
--    Alipay and uploads the receipt. The app must process the uploaded receipts and put the
--    details into an organised table: the receiver, the date, which platform was used, and
--    whether the fee is included. When the batch is finished it goes to the admin, who reviews
--    it and makes a transaction from it — and the details of those receipts must go to whichever
--    partner the money was placed with."
--
-- Almost all of the machinery for this exists. sarraf_convert_receipt_batch_to_transaction
-- already refuses receipts split across partners, carries the partner onto the transaction, and
-- records the link in receipt_batch_transactions. What was missing is the table itself: receiver,
-- date, platform and fee status live on public.receipts and were never gathered anywhere, so the
-- admin reviewed a batch without them and the partner could not see them at all.
--
-- Nothing here writes. It is a read model over rows that already exist, which is why it can be
-- added without touching the conversion path that produces them.
begin;

-- ── which wallet the money moved through ────────────────────────────────────
--
-- The platform arrives spelled several ways depending on which reader produced it — "WeChat
-- Pay", "wechat", "微信", "Alipay", "支付宝" — and a table that shows all of them as written is
-- not a table anybody can total by platform. Normalised to one token per wallet, with the
-- original kept beside it so a person can still see what the receipt actually said.
create or replace function public.sarraf_platform_key(p_platform text, p_raw jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  with said as (
    select lower(btrim(coalesce(
      nullif(btrim(p_platform), ''),
      nullif(btrim(p_raw->>'platform'), ''),
      nullif(btrim(p_raw->>'channel'), ''),
      nullif(btrim(p_raw->>'wallet'), ''),
      ''))) as v
  )
  select case
    when v = '' then 'unknown'
    when v like '%wechat%' or v like '%weixin%' or v like '%微信%' then 'wechat'
    when v like '%alipay%' or v like '%支付宝%' or v like '%zhifubao%' then 'alipay'
    when v like '%bank%' or v like '%transfer%' then 'bank'
    else 'other'
  end
  from said;
$$;

grant execute on function public.sarraf_platform_key(text, jsonb) to authenticated;

-- ── the details table ───────────────────────────────────────────────────────
--
-- One row per accepted receipt, in the columns the owner named, plus what a reviewer needs to
-- act: the amount, the reference, and whether the row was counted.
--
-- Who may read it:
--   • an administrator or the office, always;
--   • the partner the money was placed with — through receipt_batch_transactions, which the
--     conversion writes, so a partner sees a batch exactly when the money became theirs to hold
--     and not a moment earlier;
--   • the partner named on the batch itself, for a batch not yet converted;
--   • whoever uploaded the receipts, because it is their own evidence.
--
-- A person outside that list is refused rather than shown an empty table: an empty answer to
-- "what is in this batch" reads as "nothing", which is a different and untrue statement.
create or replace function public.sarraf_partner_batch_detail(p_batch_id text)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_batch public.receipt_batches%rowtype;
  v_holder text;
  v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then
    raise exception using errcode = '42501', message = 'batch detail is not authorized';
  end if;

  select * into v_batch from public.receipt_batches where id = p_batch_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'receipt batch not found';
  end if;

  -- Whoever the money ended up with. The conversion's record wins over the batch's own field,
  -- because that is the one written when the transaction was actually made.
  select rbt.partner_id into v_holder
    from public.receipt_batch_transactions rbt
   where rbt.batch_id = p_batch_id and rbt.partner_id is not null
   order by rbt.created_at limit 1;
  v_holder := coalesce(v_holder, v_batch.partner_id);

  if v_actor.role not in ('admin', 'office')
     and v_actor.id is distinct from v_holder
     and v_actor.id is distinct from v_batch.uploaded_by
     and v_actor.id is distinct from v_batch.customer_id then
    raise exception using errcode = '42501', message = 'this receipt batch is not yours';
  end if;

  with rows_of as (
    select r.id,
           public.sarraf_payee_name(r.receiver, r.raw, r.sender) as receiver,
           r.tx_date,
           r.tx_time,
           public.sarraf_platform_key(r.platform, r.raw) as platform,
           r.platform as platform_said,
           r.currency,
           coalesce(r.amount, 0) as amount,
           coalesce(r.fee, 0) as fee,
           coalesce(r.net_amount, coalesce(r.amount, 0) - coalesce(r.fee, 0)) as net_amount,
           -- §A: "fee status (with fee / without fee)". A receipt carries a fee or it does not,
           -- and the distinction decides which of the two totals below it belongs to.
           coalesce(r.fee, 0) > 0 as has_fee,
           r.ref_no,
           r.merchant_order_no,
           r.status,
           coalesce(r.counted, true) as counted,
           r.reject_code,
           r.reject_reason,
           r.image_path,
           r.created_at
    from public.receipts r
    where r.batch_id = p_batch_id
  ), counted_rows as (
    select * from rows_of where counted and status not in ('dup', 'error')
  ), by_platform as (
    select platform, currency,
           count(*) as n,
           sum(amount) as with_fee,
           sum(net_amount) as without_fee,
           sum(fee) as fee
    from counted_rows group by platform, currency
  ), by_receiver as (
    select receiver, currency,
           count(*) as n,
           sum(amount) as with_fee,
           sum(net_amount) as without_fee,
           sum(fee) as fee
    from counted_rows group by receiver, currency
  ), totals as (
    select currency,
           count(*) as n,
           sum(amount) as with_fee,
           sum(net_amount) as without_fee,
           sum(fee) as fee,
           count(*) filter (where has_fee) as with_fee_count,
           count(*) filter (where not has_fee) as without_fee_count
    from counted_rows group by currency
  )
  select jsonb_build_object(
    'batch_id', p_batch_id,
    'direction', v_batch.direction,
    'receipt_stage', v_batch.receipt_stage,
    -- Who is holding the money, and the transaction it was placed under. Null on both means the
    -- batch has not been converted yet, which is a state and not an error.
    'partner_id', v_holder,
    'partner_name', (select u.name from public.app_users u where u.id = v_holder),
    'transaction_id', (select rbt.transaction_id from public.receipt_batch_transactions rbt
                        where rbt.batch_id = p_batch_id order by rbt.created_at limit 1),
    'is_indirect', v_holder is not null,
    'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.tx_date desc nulls last, x.created_at desc)
                      from rows_of x), '[]'::jsonb),
    'by_platform', coalesce((select jsonb_agg(to_jsonb(p) order by p.n desc, p.platform)
                             from by_platform p), '[]'::jsonb),
    'by_receiver', coalesce((select jsonb_agg(to_jsonb(b) order by b.n desc, b.receiver)
                             from by_receiver b), '[]'::jsonb),
    'totals', coalesce((select jsonb_agg(to_jsonb(t) order by t.currency) from totals t), '[]'::jsonb),
    'rejected_count', (select count(*) from rows_of where not counted or status in ('dup', 'error'))
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.sarraf_partner_batch_detail(text) from public, anon;
grant execute on function public.sarraf_partner_batch_detail(text) to authenticated;

-- ── what a partner is holding, across every batch ───────────────────────────
--
-- The list a partner opens to answer "what has been placed with me". One row per batch, with
-- enough on it to recognise the batch and open its detail; the details themselves come from
-- sarraf_partner_batch_detail so there is one definition of them and not two.
--
-- An administrator may ask about any partner. A partner may only ask about themselves, and the
-- parameter is ignored for them rather than refused, so the same call works from both screens.
create or replace function public.sarraf_partner_holdings(p_partner_id text default null)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_partner text;
  v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then
    raise exception using errcode = '42501', message = 'partner holdings are not authorized';
  end if;

  v_partner := case when v_actor.role in ('admin', 'office')
                    then coalesce(nullif(btrim(coalesce(p_partner_id, '')), ''), v_actor.id)
                    else v_actor.id end;

  with held as (
    select rbt.batch_id, rbt.transaction_id, rbt.partner_id,
           rbt.item_count, rbt.amount, rbt.currency, rbt.created_at,
           b.direction, b.customer_id, b.receipt_stage,
           (select u.name from public.app_users u where u.id = b.customer_id) as customer_name,
           t.status as transaction_status, t.type as transaction_type
    from public.receipt_batch_transactions rbt
    join public.receipt_batches b on b.id = rbt.batch_id
    left join public.txs t on t.id = rbt.transaction_id
    where rbt.partner_id = v_partner
  ), per_currency as (
    select currency, count(*) as batches, sum(item_count) as receipts, sum(amount) as amount
    from held group by currency
  )
  select jsonb_build_object(
    'partner_id', v_partner,
    'partner_name', (select u.name from public.app_users u where u.id = v_partner),
    'batches', coalesce((select jsonb_agg(to_jsonb(h) order by h.created_at desc) from held h), '[]'::jsonb),
    'by_currency', coalesce((select jsonb_agg(to_jsonb(c) order by c.currency) from per_currency c), '[]'::jsonb),
    'batch_count', (select count(*) from held)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.sarraf_partner_holdings(text) from public, anon;
grant execute on function public.sarraf_partner_holdings(text) to authenticated;

commit;
