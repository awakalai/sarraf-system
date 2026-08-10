-- Phase F2: explicit receipt decisions, audited policy, and maker/checker finalization.
-- No function in this migration mutates txs, ledger, account_ledger, or balances.

alter table public.receipt_batches add column if not exists decision_status text;
alter table public.receipt_batches add column if not exists decision_reason text;
alter table public.receipt_batches add column if not exists decision_by text references public.app_users(id);
alter table public.receipt_batches add column if not exists decided_at timestamptz;
alter table public.receipt_batches add column if not exists policy_version bigint;
alter table public.receipt_batches add column if not exists finalized_at timestamptz;
alter table public.receipt_batches add column if not exists finalized_by text references public.app_users(id);
alter table public.receipt_batches add column if not exists finalization_reason text;

alter table public.receipt_batches drop constraint if exists receipt_batches_stage_a3;
alter table public.receipt_batches drop constraint if exists receipt_batches_stage_f2;
alter table public.receipt_batches add constraint receipt_batches_stage_f2
  check (receipt_stage in ('received','reading','needs_review','verified','matched','rejected','finalized','archived')) not valid;
alter table public.receipt_batches drop constraint if exists receipt_batches_decision_f2;
alter table public.receipt_batches add constraint receipt_batches_decision_f2
  check (decision_status is null or decision_status in ('accepted','rejected','correction_requested')) not valid;

create table if not exists public.receipt_control_policy (
  singleton boolean primary key default true check (singleton),
  min_match_score integer not null default 80 check (min_match_score between 0 and 100),
  require_reason_below integer not null default 90 check (require_reason_below between min_match_score and 100),
  allow_reject boolean not null default true,
  allow_correction boolean not null default true,
  require_finalization boolean not null default true,
  require_separate_finalizer boolean not null default true,
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default statement_timestamp(),
  updated_by text references public.app_users(id),
  update_reason text
);
insert into public.receipt_control_policy(singleton) values(true) on conflict(singleton) do nothing;
alter table public.receipt_control_policy enable row level security;
revoke all on public.receipt_control_policy from public, anon, authenticated;

create table if not exists public.receipt_review_commands (
  actor_id text not null references public.app_users(id),
  command_key text not null,
  batch_id text references public.receipt_batches(id),
  decision text not null check (decision in ('accept','reject','correction','finalize','policy_update')),
  result jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key(actor_id, command_key),
  check (command_key ~ '^receipt-(decision|match|finalize|policy):[A-Za-z0-9:_-]{16,220}$')
);
alter table public.receipt_review_commands enable row level security;
revoke all on public.receipt_review_commands from public, anon, authenticated;

alter table public.receipt_audit_events drop constraint if exists receipt_audit_events_event_type_check;
alter table public.receipt_audit_events drop constraint if exists receipt_audit_events_event_type_f2;
alter table public.receipt_audit_events add constraint receipt_audit_events_event_type_f2 check (event_type in (
  'batch_created','receipt_created','manual_correction','verified','rejected','matched','archived',
  'decision_rejected','correction_requested','finalized','policy_updated'
)) not valid;

-- Persisted receipt corrections and partner allocation changes are audit-visible.
create or replace function public.audit_receipt_transition() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_actor text;
begin
  select id into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if v_actor is null then return new; end if;
  if old.status is distinct from new.status
    or old.amount is distinct from new.amount
    or old.currency is distinct from new.currency
    or old.ref_no is distinct from new.ref_no
    or old.partner_id is distinct from new.partner_id
    or old.counted is distinct from new.counted
    or old.reject_code is distinct from new.reject_code
    or old.reject_reason is distinct from new.reject_reason
  then
    insert into public.receipt_audit_events(event_type,batch_id,receipt_id,actor_id,command_key,metadata)
    values(
      case when new.status in ('verified','confirmed','ok') then 'verified'
        when new.status in ('rejected','error') then 'rejected'
        when new.status='matched' then 'matched'
        when new.status='archived' then 'archived'
        else 'manual_correction' end,
      new.batch_id,new.id,v_actor,'transition:'||txid_current()::text,
      jsonb_build_object(
        'before',jsonb_build_object('status',old.status,'amount',old.amount,'currency',old.currency,'ref_no',old.ref_no,
          'partner_id',old.partner_id,'counted',old.counted,'reject_code',old.reject_code,'reject_reason',old.reject_reason),
        'after',jsonb_build_object('status',new.status,'amount',new.amount,'currency',new.currency,'ref_no',new.ref_no,
          'partner_id',new.partner_id,'counted',new.counted,'reject_code',new.reject_code,'reject_reason',new.reject_reason)
      )
    );
  end if;
  return new;
end $$;

create index if not exists idx_receipt_batches_decision_f2 on public.receipt_batches(decision_status, decided_at desc);
create index if not exists idx_receipt_batches_finalized_f2 on public.receipt_batches(finalized_at desc) where finalized_at is not null;

create or replace function public.sarraf_receipt_policy()
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare v_actor public.app_users%rowtype; v_policy public.receipt_control_policy%rowtype;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role not in ('admin','office') then
    raise exception using errcode='42501', message='receipt policy is not authorized';
  end if;
  select * into v_policy from public.receipt_control_policy where singleton;
  return jsonb_build_object(
    'min_match_score', v_policy.min_match_score,
    'require_reason_below', v_policy.require_reason_below,
    'allow_reject', v_policy.allow_reject,
    'allow_correction', v_policy.allow_correction,
    'require_finalization', v_policy.require_finalization,
    'require_separate_finalizer', v_policy.require_separate_finalizer,
    'version', v_policy.version,
    'updated_at', v_policy.updated_at
  );
end;
$$;

create or replace function public.sarraf_review_receipt_batch(
  p_batch_id text,
  p_decision text,
  p_tx_id text,
  p_reason text,
  p_command_key text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_batch public.receipt_batches%rowtype;
  v_tx public.txs%rowtype;
  v_candidate record;
  v_policy public.receipt_control_policy%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role not in ('admin','office') then
    raise exception using errcode='42501', message='receipt decision is not authorized';
  end if;
  if p_decision not in ('accept','reject','correction') then
    raise exception using errcode='22023', message='invalid receipt decision';
  end if;
  if p_command_key !~ '^receipt-(decision|match):[A-Za-z0-9:_-]{16,220}$' then
    raise exception using errcode='22023', message='invalid request identity';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || p_command_key, 0));
  select result into v_result from public.receipt_review_commands
    where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_result || jsonb_build_object('replayed', true); end if;

  if p_decision = 'accept' and p_command_key like 'receipt-match:%' then
    select result into v_result from public.receipt_match_commands
      where actor_id = v_actor.id and command_key = p_command_key;
    if found then return v_result || jsonb_build_object('replayed', true); end if;
  end if;

  select * into v_policy from public.receipt_control_policy where singleton for share;
  select * into v_batch from public.receipt_batches where id = p_batch_id for update;
  if not found then raise exception using errcode='P0002', message='receipt batch not found'; end if;
  if v_batch.receipt_stage in ('archived','finalized') then
    raise exception using errcode='22023', message='finalized receipt batch cannot be changed';
  end if;

  if p_decision = 'accept' then
    if nullif(btrim(coalesce(p_tx_id, '')), '') is null then
      raise exception using errcode='22023', message='transaction is required';
    end if;
    select * into v_tx from public.txs where id = p_tx_id for share;
    if not found or v_tx.deleted or v_tx.status not in ('completed','pending') then
      raise exception using errcode='22023', message='transaction is not eligible';
    end if;
    if v_batch.customer_id is not null and v_tx.cp_id is distinct from v_batch.customer_id then
      raise exception using errcode='22023', message='objects do not share an authorized customer context';
    end if;
    if v_batch.partner_id is not null and v_tx.partner_id is distinct from v_batch.partner_id then
      raise exception using errcode='22023', message='objects do not share an authorized partner context';
    end if;
    select * into v_candidate from public.sarraf_receipt_match_candidates(p_batch_id, 20) c where c.tx_id = p_tx_id;
    if not found then raise exception using errcode='22023', message='transaction is outside the safe candidate window'; end if;
    if v_candidate.score < v_policy.min_match_score then
      raise exception using errcode='22023', message='candidate is below the active receipt policy threshold';
    end if;
    if v_candidate.score < v_policy.require_reason_below and char_length(coalesce(v_reason, '')) < 8 then
      raise exception using errcode='22023', message='a review reason is required by receipt policy';
    end if;

    update public.receipt_batches set
      tx_id = p_tx_id,
      receipt_stage = 'matched',
      status = 'done',
      matched_score = v_candidate.score,
      match_reason = v_reason,
      matched_at = statement_timestamp(),
      matched_by = v_actor.id,
      match_version = match_version + 1,
      decision_status = 'accepted',
      decision_reason = v_reason,
      decision_by = v_actor.id,
      decided_at = statement_timestamp(),
      policy_version = v_policy.version,
      finalized_at = null,
      finalized_by = null,
      finalization_reason = null
    where id = p_batch_id;

    v_result := jsonb_build_object('batch_id', p_batch_id, 'decision', 'accepted', 'tx_id', p_tx_id,
      'score', v_candidate.score, 'policy_version', v_policy.version, 'replayed', false);
    insert into public.receipt_audit_events(event_type,batch_id,actor_id,command_key,metadata)
      values('matched', p_batch_id, v_actor.id, p_command_key,
        jsonb_build_object('decision','accepted','tx_id',p_tx_id,'score',v_candidate.score,
          'policy_version',v_policy.version,'reason',v_reason,'signals',v_candidate.reasons));

  elsif p_decision = 'reject' then
    if not v_policy.allow_reject then raise exception using errcode='42501', message='rejection is disabled by receipt policy'; end if;
    if char_length(coalesce(v_reason, '')) < 8 then raise exception using errcode='22023', message='rejection reason is required'; end if;
    update public.receipt_batches set
      tx_id = null,
      receipt_stage = 'rejected',
      status = 'done',
      decision_status = 'rejected',
      decision_reason = v_reason,
      decision_by = v_actor.id,
      decided_at = statement_timestamp(),
      policy_version = v_policy.version,
      match_reason = null,
      matched_score = null,
      matched_at = null,
      matched_by = null,
      match_version = match_version + 1,
      finalized_at = null,
      finalized_by = null,
      finalization_reason = null
    where id = p_batch_id;
    v_result := jsonb_build_object('batch_id', p_batch_id, 'decision', 'rejected',
      'policy_version', v_policy.version, 'replayed', false);
    insert into public.receipt_audit_events(event_type,batch_id,actor_id,command_key,metadata)
      values('decision_rejected', p_batch_id, v_actor.id, p_command_key,
        jsonb_build_object('decision','rejected','policy_version',v_policy.version,'reason',v_reason));

  else
    if not v_policy.allow_correction then raise exception using errcode='42501', message='correction is disabled by receipt policy'; end if;
    if char_length(coalesce(v_reason, '')) < 8 then raise exception using errcode='22023', message='correction request is required'; end if;
    update public.receipt_batches set
      tx_id = null,
      receipt_stage = 'needs_review',
      status = 'new',
      decision_status = 'correction_requested',
      decision_reason = v_reason,
      decision_by = v_actor.id,
      decided_at = statement_timestamp(),
      policy_version = v_policy.version,
      match_reason = null,
      matched_score = null,
      matched_at = null,
      matched_by = null,
      match_version = match_version + 1,
      finalized_at = null,
      finalized_by = null,
      finalization_reason = null
    where id = p_batch_id;
    v_result := jsonb_build_object('batch_id', p_batch_id, 'decision', 'correction_requested',
      'policy_version', v_policy.version, 'replayed', false);
    insert into public.receipt_audit_events(event_type,batch_id,actor_id,command_key,metadata)
      values('correction_requested', p_batch_id, v_actor.id, p_command_key,
        jsonb_build_object('decision','correction_requested','policy_version',v_policy.version,'reason',v_reason));
  end if;

  insert into public.receipt_review_commands(actor_id,command_key,batch_id,decision,result)
    values(v_actor.id,p_command_key,p_batch_id,p_decision,v_result);
  return v_result;
end;
$$;

create or replace function public.sarraf_confirm_receipt_match(p_batch_id text,p_tx_id text,p_reason text,p_command_key text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return public.sarraf_review_receipt_batch(p_batch_id, 'accept', p_tx_id, p_reason, p_command_key);
end;
$$;

create or replace function public.sarraf_finalize_receipt_batch(
  p_batch_id text,
  p_reason text,
  p_owner_override boolean,
  p_command_key text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_batch public.receipt_batches%rowtype;
  v_policy public.receipt_control_policy%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_decision text;
  v_override boolean := false;
  v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='receipt finalization is not authorized';
  end if;
  if p_command_key !~ '^receipt-finalize:[A-Za-z0-9:_-]{16,220}$' then
    raise exception using errcode='22023', message='invalid request identity';
  end if;
  if char_length(coalesce(v_reason, '')) < 8 then
    raise exception using errcode='22023', message='finalization reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || p_command_key, 0));
  select result into v_result from public.receipt_review_commands
    where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_result || jsonb_build_object('replayed', true); end if;

  select * into v_policy from public.receipt_control_policy where singleton for share;
  select * into v_batch from public.receipt_batches where id = p_batch_id for update;
  if not found then raise exception using errcode='P0002', message='receipt batch not found'; end if;
  if v_batch.receipt_stage = 'finalized' then
    return jsonb_build_object('batch_id',p_batch_id,'decision',coalesce(v_batch.decision_status,'accepted'),
      'finalized',true,'replayed',true,'policy_version',v_batch.policy_version);
  end if;
  if v_batch.receipt_stage not in ('matched','rejected') then
    raise exception using errcode='22023', message='receipt decision must be completed before finalization';
  end if;

  v_decision := coalesce(v_batch.decision_status, case when v_batch.tx_id is not null then 'accepted' else 'rejected' end);
  if v_decision = 'accepted' then
    if v_batch.tx_id is null or not exists(select 1 from public.txs t where t.id=v_batch.tx_id and not t.deleted) then
      raise exception using errcode='22023', message='accepted receipt has no eligible transaction';
    end if;
    if coalesce(v_batch.matched_score, -1) < v_policy.min_match_score then
      raise exception using errcode='22023', message='accepted receipt no longer satisfies active policy';
    end if;
  elsif v_decision <> 'rejected' then
    raise exception using errcode='22023', message='receipt decision is not finalizable';
  end if;

  if v_policy.require_separate_finalizer and v_batch.decision_by = v_actor.id then
    if coalesce(v_actor.admin_level, '') = 'owner' and coalesce(p_owner_override, false) and char_length(v_reason) >= 12 then
      v_override := true;
    else
      raise exception using errcode='42501', message='a separate admin must finalize this receipt decision';
    end if;
  end if;

  update public.receipt_batches set
    receipt_stage = 'finalized',
    status = 'done',
    finalized_at = statement_timestamp(),
    finalized_by = v_actor.id,
    finalization_reason = v_reason
  where id = p_batch_id;

  v_result := jsonb_build_object('batch_id',p_batch_id,'decision',v_decision,'finalized',true,
    'owner_override',v_override,'policy_version',v_policy.version,'replayed',false);
  insert into public.receipt_audit_events(event_type,batch_id,actor_id,command_key,metadata)
    values('finalized',p_batch_id,v_actor.id,p_command_key,
      jsonb_build_object('decision',v_decision,'policy_version',v_policy.version,
        'decision_by',v_batch.decision_by,'finalized_by',v_actor.id,'owner_override',v_override,'reason',v_reason));
  insert into public.receipt_review_commands(actor_id,command_key,batch_id,decision,result)
    values(v_actor.id,p_command_key,p_batch_id,'finalize',v_result);
  return v_result;
end;
$$;

create or replace function public.sarraf_update_receipt_policy(
  p_policy jsonb,
  p_reason text,
  p_command_key text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_policy public.receipt_control_policy%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_min integer;
  v_reason_below integer;
  v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' or coalesce(v_actor.admin_level, '') <> 'owner' then
    raise exception using errcode='42501', message='only the system owner may change receipt policy';
  end if;
  if p_command_key !~ '^receipt-policy:[A-Za-z0-9:_-]{16,220}$' then
    raise exception using errcode='22023', message='invalid request identity';
  end if;
  if jsonb_typeof(p_policy) <> 'object' or char_length(coalesce(v_reason, '')) < 12 then
    raise exception using errcode='22023', message='policy and a 12-character reason are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || p_command_key, 0));
  select result into v_result from public.receipt_review_commands
    where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_result || jsonb_build_object('replayed', true); end if;

  select * into v_policy from public.receipt_control_policy where singleton for update;
  v_min := coalesce(nullif(p_policy->>'min_match_score','')::integer, v_policy.min_match_score);
  v_reason_below := coalesce(nullif(p_policy->>'require_reason_below','')::integer, v_policy.require_reason_below);
  if v_min not between 0 and 100 or v_reason_below not between v_min and 100 then
    raise exception using errcode='22023', message='invalid receipt score thresholds';
  end if;

  update public.receipt_control_policy set
    min_match_score = v_min,
    require_reason_below = v_reason_below,
    allow_reject = coalesce((p_policy->>'allow_reject')::boolean, allow_reject),
    allow_correction = coalesce((p_policy->>'allow_correction')::boolean, allow_correction),
    require_finalization = coalesce((p_policy->>'require_finalization')::boolean, require_finalization),
    require_separate_finalizer = coalesce((p_policy->>'require_separate_finalizer')::boolean, require_separate_finalizer),
    version = version + 1,
    updated_at = statement_timestamp(),
    updated_by = v_actor.id,
    update_reason = v_reason
  where singleton
  returning * into v_policy;

  v_result := jsonb_build_object('ok',true,'version',v_policy.version,'min_match_score',v_policy.min_match_score,
    'require_reason_below',v_policy.require_reason_below,'replayed',false);
  insert into public.receipt_audit_events(event_type,batch_id,actor_id,command_key,metadata)
    values('policy_updated','__policy__',v_actor.id,p_command_key,
      jsonb_build_object('version',v_policy.version,'min_match_score',v_policy.min_match_score,
        'require_reason_below',v_policy.require_reason_below,'allow_reject',v_policy.allow_reject,
        'allow_correction',v_policy.allow_correction,'require_finalization',v_policy.require_finalization,
        'require_separate_finalizer',v_policy.require_separate_finalizer,'reason',v_reason));
  insert into public.receipt_review_commands(actor_id,command_key,batch_id,decision,result)
    values(v_actor.id,p_command_key,null,'policy_update',v_result);
  return v_result;
end;
$$;

revoke all on function public.sarraf_receipt_policy() from public, anon;
revoke all on function public.sarraf_review_receipt_batch(text,text,text,text,text) from public, anon;
revoke all on function public.sarraf_confirm_receipt_match(text,text,text,text) from public, anon;
revoke all on function public.sarraf_finalize_receipt_batch(text,text,boolean,text) from public, anon;
revoke all on function public.sarraf_update_receipt_policy(jsonb,text,text) from public, anon;
grant execute on function public.sarraf_receipt_policy() to authenticated;
grant execute on function public.sarraf_review_receipt_batch(text,text,text,text,text) to authenticated;
grant execute on function public.sarraf_confirm_receipt_match(text,text,text,text) to authenticated;
grant execute on function public.sarraf_finalize_receipt_batch(text,text,boolean,text) to authenticated;
grant execute on function public.sarraf_update_receipt_policy(jsonb,text,text) to authenticated;

comment on function public.sarraf_review_receipt_batch(text,text,text,text,text) is
  'Explicit receipt accept/reject/correction decision. It never changes transactions or accounting.';
comment on function public.sarraf_finalize_receipt_batch(text,text,boolean,text) is
  'Audited receipt finalization with maker/checker or explicit owner override.';
