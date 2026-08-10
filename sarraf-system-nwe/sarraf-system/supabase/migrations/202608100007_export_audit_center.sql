-- Phase F3: bounded, read-only export and audit snapshot for administrators.

create or replace function public.sarraf_export_audit_snapshot(
  p_from date default null,
  p_to date default null,
  p_limit integer default 1000
) returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_from date := coalesce(p_from, current_date - 29);
  v_to date := coalesce(p_to, current_date);
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 2500);
  v_start timestamptz;
  v_end timestamptz;
  v_txs jsonb;
  v_audit jsonb;
  v_receipt_audit jsonb;
  v_approvals jsonb;
  v_approval_events jsonb;
  v_tx_versions jsonb;
  v_receipt_batches jsonb;
  v_tx_count bigint;
  v_audit_count bigint;
  v_receipt_audit_count bigint;
  v_approval_count bigint;
  v_approval_event_count bigint;
  v_tx_version_count bigint;
  v_receipt_batch_count bigint;
begin
  select * into v_actor
  from public.app_users
  where auth_id = auth.uid() and not deleted;

  if not found or v_actor.role <> 'admin' then
    raise exception using errcode = '42501', message = 'export and audit center is not authorized';
  end if;
  if v_to < v_from then
    raise exception using errcode = '22023', message = 'export end date must not precede start date';
  end if;
  if v_to - v_from > 365 then
    raise exception using errcode = '22023', message = 'export range cannot exceed 366 days';
  end if;

  v_start := v_from::timestamp at time zone 'UTC';
  v_end := (v_to + 1)::timestamp at time zone 'UTC';

  select count(*) into v_tx_count from public.txs where date >= v_start and date < v_end;
  select count(*) into v_audit_count from public.audit where date >= v_start and date < v_end;
  select count(*) into v_receipt_audit_count from public.receipt_audit_events where created_at >= v_start and created_at < v_end;
  select count(*) into v_approval_count from public.approval_requests where created_at >= v_start and created_at < v_end;
  select count(*) into v_approval_event_count from public.approval_events where created_at >= v_start and created_at < v_end;
  select count(*) into v_tx_version_count from public.tx_versions where created_at >= v_start and created_at < v_end;
  select count(*) into v_receipt_batch_count from public.receipt_batches where created_at >= v_start and created_at < v_end;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.date desc, r.id desc), '[]'::jsonb) into v_txs
  from (select * from public.txs where date >= v_start and date < v_end order by date desc, id desc limit v_limit) r;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.date desc, r.id desc), '[]'::jsonb) into v_audit
  from (select * from public.audit where date >= v_start and date < v_end order by date desc, id desc limit v_limit) r;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc, r.id desc), '[]'::jsonb) into v_receipt_audit
  from (select * from public.receipt_audit_events where created_at >= v_start and created_at < v_end order by created_at desc, id desc limit v_limit) r;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc, r.id desc), '[]'::jsonb) into v_approvals
  from (select * from public.approval_requests where created_at >= v_start and created_at < v_end order by created_at desc, id desc limit v_limit) r;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc, r.id desc), '[]'::jsonb) into v_approval_events
  from (select * from public.approval_events where created_at >= v_start and created_at < v_end order by created_at desc, id desc limit v_limit) r;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc, r.id desc), '[]'::jsonb) into v_tx_versions
  from (select * from public.tx_versions where created_at >= v_start and created_at < v_end order by created_at desc, id desc limit v_limit) r;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc, r.id desc), '[]'::jsonb) into v_receipt_batches
  from (select * from public.receipt_batches where created_at >= v_start and created_at < v_end order by created_at desc, id desc limit v_limit) r;

  return jsonb_build_object(
    'format', 'zeman-export-audit-snapshot',
    'version', 1,
    'generated_at', statement_timestamp(),
    'generated_by', v_actor.id,
    'range', jsonb_build_object('from', v_from, 'to', v_to, 'timezone', 'UTC'),
    'row_limit_per_dataset', v_limit,
    'counts', jsonb_build_object(
      'transactions', v_tx_count,
      'audit', v_audit_count,
      'receipt_audit', v_receipt_audit_count,
      'approvals', v_approval_count,
      'approval_events', v_approval_event_count,
      'tx_versions', v_tx_version_count,
      'receipt_batches', v_receipt_batch_count
    ),
    'clipped', jsonb_build_object(
      'transactions', v_tx_count > v_limit,
      'audit', v_audit_count > v_limit,
      'receipt_audit', v_receipt_audit_count > v_limit,
      'approvals', v_approval_count > v_limit,
      'approval_events', v_approval_event_count > v_limit,
      'tx_versions', v_tx_version_count > v_limit,
      'receipt_batches', v_receipt_batch_count > v_limit
    ),
    'datasets', jsonb_build_object(
      'transactions', v_txs,
      'audit', v_audit,
      'receipt_audit', v_receipt_audit,
      'approvals', v_approvals,
      'approval_events', v_approval_events,
      'tx_versions', v_tx_versions,
      'receipt_batches', v_receipt_batches
    )
  );
end;
$$;

revoke all on function public.sarraf_export_audit_snapshot(date,date,integer) from public, anon;
grant execute on function public.sarraf_export_audit_snapshot(date,date,integer) to authenticated;

comment on function public.sarraf_export_audit_snapshot(date,date,integer) is
  'Read-only, bounded administrative export. It does not mutate financial or audit records.';
