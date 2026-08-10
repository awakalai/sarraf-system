-- Phase F4: include policy-required finalization and finalized decision drift in operations.
-- These follow-up RPCs compose the earlier read models and remain strictly read-only.

create or replace function public.sarraf_action_inbox_v2(p_limit integer default 80)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit, 80), 1), 100);
  v_base jsonb;
  v_items jsonb := '[]'::jsonb;
  v_followup jsonb := '[]'::jsonb;
  v_counts jsonb := '{}'::jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode = '42501', message = 'admin operations are not authorized';
  end if;

  v_base := public.sarraf_action_inbox(100);
  v_items := coalesce(v_base->'items', '[]'::jsonb);

  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', 'receipt_finalization',
    'priority', 'high',
    'title', 'Receipt decision needs finalization',
    'detail', concat_ws(' · ', b.currency, replace(coalesce(b.decision_status, b.receipt_stage), '_', ' '),
      case when b.decision_by is not null then 'maker recorded' end),
    'created_at', coalesce(b.decided_at, b.matched_at, b.created_at),
    'path', '#/receipts'
  )), '[]'::jsonb)
  into v_followup
  from public.receipt_batches b
  cross join public.receipt_control_policy p
  where p.singleton and p.require_finalization
    and b.receipt_stage in ('matched', 'rejected')
    and b.finalized_at is null;

  v_items := v_items || v_followup;

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

create or replace function public.sarraf_integrity_center_v2(p_limit integer default 80)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit, 80), 1), 100);
  v_base jsonb;
  v_items jsonb := '[]'::jsonb;
  v_followup jsonb := '[]'::jsonb;
  v_counts jsonb := '{}'::jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode = '42501', message = 'admin integrity checks are not authorized';
  end if;

  v_base := public.sarraf_integrity_center(100);
  v_items := coalesce(v_base->'items', '[]'::jsonb);

  with followup_checks as (
    select
      'finalized_broken_match'::text kind,
      'critical'::text severity,
      'Finalized receipt points to an unavailable transaction'::text title,
      concat_ws(' · ', b.currency, coalesce(b.matched_score::text || '%', 'score unavailable')) detail,
      coalesce(b.finalized_at, b.matched_at, b.created_at) detected_at,
      '#/receipts'::text path
    from public.receipt_batches b
    left join public.txs t on t.id = b.tx_id
    where b.receipt_stage = 'finalized'
      and b.decision_status = 'accepted'
      and (b.tx_id is null or t.id is null or t.deleted)

    union all

    select
      'receipt_decision_mismatch',
      'critical',
      'Receipt decision and linked transaction disagree',
      concat_ws(' · ', b.currency, replace(coalesce(b.decision_status, 'missing decision'), '_', ' ')),
      coalesce(b.finalized_at, b.decided_at, b.created_at),
      '#/receipts'
    from public.receipt_batches b
    where (b.decision_status = 'rejected' and b.tx_id is not null)
       or (b.decision_status = 'accepted' and b.tx_id is null)
       or (b.receipt_stage = 'finalized' and b.decision_status is null)

    union all

    select
      'receipt_policy_drift',
      'high',
      'Accepted receipt is below the active policy threshold',
      concat_ws(' · ', b.currency, coalesce(b.matched_score::text || '%', 'score unavailable'),
        'active minimum ' || p.min_match_score::text || '%'),
      coalesce(b.finalized_at, b.decided_at, b.created_at),
      '#/receipts'
    from public.receipt_batches b
    cross join public.receipt_control_policy p
    where p.singleton
      and b.decision_status = 'accepted'
      and coalesce(b.matched_score, -1) < p.min_match_score
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', c.kind,
    'severity', c.severity,
    'title', c.title,
    'detail', c.detail,
    'detected_at', c.detected_at,
    'path', c.path
  )), '[]'::jsonb)
  into v_followup
  from followup_checks c;

  v_items := v_items || v_followup;

  select coalesce(jsonb_agg(s.item order by s.severity_rank, s.detected_at), '[]'::jsonb)
  into v_items
  from (
    select value item,
      case value->>'severity' when 'critical' then 0 when 'high' then 1 else 2 end severity_rank,
      coalesce((value->>'detected_at')::timestamptz, statement_timestamp()) detected_at
    from jsonb_array_elements(v_items)
    order by severity_rank, detected_at
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
    'status', case when jsonb_array_length(v_items) = 0 then 'clear' else 'attention' end,
    'total', jsonb_array_length(v_items),
    'counts', v_counts,
    'items', v_items
  );
end;
$$;

revoke all on function public.sarraf_action_inbox_v2(integer) from public, anon;
revoke all on function public.sarraf_integrity_center_v2(integer) from public, anon;
grant execute on function public.sarraf_action_inbox_v2(integer) to authenticated;
grant execute on function public.sarraf_integrity_center_v2(integer) to authenticated;

comment on function public.sarraf_action_inbox_v2(integer) is
  'Admin-only read queue including receipt finalization required by active policy.';
comment on function public.sarraf_integrity_center_v2(integer) is
  'Admin-only read diagnostics including finalized receipt decision drift.';
