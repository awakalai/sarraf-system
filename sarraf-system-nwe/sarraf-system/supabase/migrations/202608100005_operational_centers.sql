-- Phase F1: bounded, read-only operational work queues for authenticated owners.
-- These RPCs never mutate financial, receipt, approval, or audit records.

create or replace function public.sarraf_action_inbox(p_limit integer default 80)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit, 80), 1), 100);
  v_items jsonb := '[]'::jsonb;
  v_part jsonb := '[]'::jsonb;
  v_counts jsonb := '{}'::jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode = '42501', message = 'admin operations are not authorized';
  end if;

  with inbox as (
    select
      'receipt_review'::text kind,
      case when coalesce(b.rejected_n, 0) > 0 or b.receipt_stage = 'needs_review' then 'high' else 'medium' end priority,
      'Receipt batch needs review'::text title,
      concat_ws(' · ', b.currency, b.n::text || ' receipt(s)', replace(b.receipt_stage, '_', ' ')) detail,
      b.created_at,
      '#/receipts'::text path
    from public.receipt_batches b
    where b.tx_id is null
      and b.receipt_stage in ('received', 'reading', 'needs_review', 'verified')

    union all

    select
      'pending_transaction',
      case when t.date < statement_timestamp() - interval '72 hours' then 'high' else 'medium' end,
      'Pending transaction',
      concat_ws(' · ', 'Order ' || coalesce(t.code::text, '—'), c.code, t.amount::text),
      t.date,
      '#/txs'
    from public.txs t
    join public.currencies c on c.id = t.cur_id
    where not t.deleted and t.status = 'pending'

    union all

    select
      'rate_missing',
      'high',
      'Operational rate is missing',
      c.code || ' · buy/sell rate required',
      coalesce(c.rate_updated, statement_timestamp()),
      '#/rates'
    from public.currencies c
    where lower(c.id) <> 'usd'
      and (coalesce(c.buy_rate, 0) <= 0 or coalesce(c.sell_rate, 0) <= 0)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', i.kind,
    'priority', i.priority,
    'title', i.title,
    'detail', i.detail,
    'created_at', i.created_at,
    'path', i.path
  )), '[]'::jsonb)
  into v_items
  from inbox i;

  -- Approval tables are supplied by the control-plane migration. Keep this
  -- operational migration safe to replay in installations that have not yet
  -- enabled that optional plane.
  if to_regclass('public.approval_requests') is not null then
    execute $action_sql$
      select coalesce(jsonb_agg(jsonb_build_object(
        'kind', 'approval',
        'priority', case when amount_usd is not null and abs(amount_usd) >= 10000 then 'high' else 'medium' end,
        'title', 'Approval waiting for a checker',
        'detail', concat_ws(' · ', replace(operation, '_', ' '), maker_name, nullif(reason, '')),
        'created_at', created_at,
        'path', '#/approvals'
      )), '[]'::jsonb)
      from (
        select operation, amount_usd, maker_name, reason, created_at
        from public.approval_requests
        where status = 'pending'
        order by created_at
        limit $1
      ) pending
    $action_sql$ using v_limit into v_part;
    v_items := v_items || coalesce(v_part, '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(s.item order by s.priority_rank, s.created_at), '[]'::jsonb)
  into v_items
  from (
    select value item,
      case value->>'priority' when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end priority_rank,
      coalesce((value->>'created_at')::timestamptz, statement_timestamp()) created_at
    from jsonb_array_elements(v_items)
    order by priority_rank, created_at
    limit v_limit
  ) s;

  select coalesce(jsonb_object_agg(kind, total), '{}'::jsonb)
  into v_counts
  from (
    select value->>'kind' kind, count(*) total
    from jsonb_array_elements(v_items)
    group by value->>'kind'
  ) grouped;

  return jsonb_build_object(
    'generated_at', statement_timestamp(),
    'total', jsonb_array_length(v_items),
    'counts', v_counts,
    'items', v_items
  );
end;
$$;

create or replace function public.sarraf_integrity_center(p_limit integer default 80)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit, 80), 1), 100);
  v_items jsonb := '[]'::jsonb;
  v_counts jsonb := '{}'::jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode = '42501', message = 'admin integrity checks are not authorized';
  end if;

  with receipt_totals as (
    select r.batch_id,
      count(*) receipt_count,
      coalesce(sum(r.amount), 0) gross,
      coalesce(sum(r.fee), 0) fees,
      coalesce(sum(coalesce(r.net_amount, r.amount - coalesce(r.fee, 0))), 0) net
    from public.receipts r
    group by r.batch_id
  ), checks as (
    select
      'duplicate_receipt'::text kind,
      'critical'::text severity,
      'Duplicate receipt fingerprint'::text title,
      count(*)::text || ' receipts share one fingerprint' detail,
      max(r.created_at) detected_at,
      '#/receipts'::text path
    from public.receipts r
    where nullif(r.image_hash, '') is not null
    group by r.image_hash
    having count(*) > 1

    union all

    select
      'batch_total_mismatch',
      'critical',
      'Receipt batch totals do not reconcile',
      concat_ws(' · ', b.currency, rt.receipt_count::text || ' receipt(s)'),
      b.created_at,
      '#/receipts'
    from public.receipt_batches b
    join receipt_totals rt on rt.batch_id = b.id
    where abs(coalesce(b.total_gross, 0) - rt.gross) > .01
       or abs(coalesce(b.total_fee, 0) - rt.fees) > .01
       or abs(coalesce(b.total_net, 0) - rt.net) > .01
       or coalesce(b.n, 0) <> rt.receipt_count

    union all

    select
      'broken_match',
      'critical',
      'Matched receipt points to an unavailable transaction',
      concat_ws(' · ', b.currency, coalesce(b.matched_score::text || '%', 'score unavailable')),
      coalesce(b.matched_at, b.created_at),
      '#/receipts'
    from public.receipt_batches b
    left join public.txs t on t.id = b.tx_id
    where b.receipt_stage = 'matched'
      and (b.tx_id is null or t.id is null or t.deleted)

    union all

    select
      'invalid_receipt_amount',
      'high',
      'Receipt amount or fee is invalid',
      concat_ws(' · ', r.currency, coalesce(r.ref_no, 'reference unavailable')),
      r.created_at,
      '#/receipts'
    from public.receipts r
    where r.amount <= 0
       or coalesce(r.fee, 0) < 0
       or coalesce(r.fee, 0) > r.amount
       or coalesce(r.net_amount, r.amount - coalesce(r.fee, 0)) < 0

    union all

    select
      'stale_pending_transaction',
      'high',
      'Transaction has remained pending for more than seven days',
      concat_ws(' · ', 'Order ' || coalesce(t.code::text, '—'), c.code, t.amount::text),
      t.date,
      '#/txs'
    from public.txs t
    join public.currencies c on c.id = t.cur_id
    where not t.deleted and t.status = 'pending'
      and t.date < statement_timestamp() - interval '7 days'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', c.kind,
    'severity', c.severity,
    'title', c.title,
    'detail', c.detail,
    'detected_at', c.detected_at,
    'path', c.path
  ) order by case c.severity when 'critical' then 0 when 'high' then 1 else 2 end, c.detected_at), '[]'::jsonb)
  into v_items
  from (
    select * from checks
    order by case severity when 'critical' then 0 when 'high' then 1 else 2 end, detected_at
    limit v_limit
  ) c;

  select coalesce(jsonb_object_agg(kind, total), '{}'::jsonb)
  into v_counts
  from (
    select value->>'kind' kind, count(*) total
    from jsonb_array_elements(v_items)
    group by value->>'kind'
  ) grouped;

  return jsonb_build_object(
    'generated_at', statement_timestamp(),
    'status', case when jsonb_array_length(v_items) = 0 then 'clear' else 'attention' end,
    'total', jsonb_array_length(v_items),
    'counts', v_counts,
    'items', v_items
  );
end;
$$;

revoke all on function public.sarraf_action_inbox(integer) from public, anon;
revoke all on function public.sarraf_integrity_center(integer) from public, anon;
grant execute on function public.sarraf_action_inbox(integer) to authenticated;
grant execute on function public.sarraf_integrity_center(integer) to authenticated;

comment on function public.sarraf_action_inbox(integer) is
  'Admin-only, bounded, read-only operational queue. It performs no mutation.';
comment on function public.sarraf_integrity_center(integer) is
  'Admin-only, bounded, read-only integrity diagnostics. Findings require explicit human action.';
