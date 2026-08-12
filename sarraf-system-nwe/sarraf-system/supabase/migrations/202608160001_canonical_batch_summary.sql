-- One canonical total, computed once, on the server.
--
-- §4.14: "the admin and the person who sent the receipt read the same server-side endpoint and
-- read model. The response carries at least summary_version, receipt_set_version,
-- calculation_status, native totals, derived USD equivalents and a rate snapshot. The client
-- only renders; no role and no component has a formula or a rate inversion of its own."
--
-- §4.15: "both views are locked to the same batch_id + receipt_set_version + rate_version. If
-- the OCR verdict, the accepted set or the rate changes before finalization, the server issues
-- a new summary version and both sides see the same one on refresh; an old interface is told
-- stale_summary, and finalization with a stale version returns 409."
--
-- Until now the totals were added up in the browser, in more than one place, from whatever rows
-- that screen happened to be holding. Two people looking at the same batch could therefore see
-- two different numbers, and neither could tell which was the real one. Nothing in a browser is
-- the record of what a batch came to.
--
-- The arithmetic is fixed by §4.12: add the native amounts at full precision first, then divide
-- the total by the rate, then round to the currency's places. Never add up display-rounded
-- values — that is where the drift comes from. The unrounded figure is kept for audit.
--
--   §4.13, the locked example: gross 2520.41 CNY, fee 73.41 CNY, net 2447.00 CNY at
--   1 USD = 7.20 CNY must give exactly 350.06, 10.20 and 339.86 USD.
begin;

-- ── the version of a batch's receipts ────────────────────────────────────────
--
-- A digest of every row, not only the accepted ones: a rejection is a change of verdict and
-- must move the version, otherwise an interface holding the old verdict would believe itself
-- current. Derived rather than stored, so it cannot drift out of step with the rows it
-- describes and needs no trigger to maintain.
create or replace function public.sarraf_receipt_set_version(p_batch_id text)
returns text
language sql
stable
set search_path = pg_catalog, public
as $$
  select md5(coalesce(string_agg(
    r.id
      || '|' || coalesce(r.amount::text, '')
      || '|' || coalesce(r.fee::text, '')
      || '|' || coalesce(r.net_amount::text, '')
      || '|' || coalesce(r.currency, '')
      || '|' || coalesce(r.status, '')
      || '|' || coalesce(r.counted::text, '')
      || '|' || coalesce(r.reject_code, ''), ',' order by r.id), ''))
  from public.receipts r
  where r.batch_id = p_batch_id;
$$;

-- ── the rate in force, as a snapshot ─────────────────────────────────────────
--
-- §4.10: one canonical rate, stated by hand, in one direction — 1 USD = X. The inverse is
-- read-only and derived here, never entered separately, because two independent rates can
-- contradict each other.
--
-- A currency with no rate returns pending_rate. §4.18 is explicit that a missing rate must not
-- become a zero or a stale figure from another day: the native breakdown is still shown in full
-- and the USD side is simply not yet knowable.
create or replace function public.sarraf_rate_snapshot(p_currency text)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare v_cur public.currencies%rowtype; v_code text := upper(btrim(coalesce(p_currency, '')));
begin
  if v_code = '' then
    return jsonb_build_object('status', 'pending_rate', 'reason', 'no currency on the receipts');
  end if;

  select * into v_cur from public.currencies where upper(code) = v_code;
  if not found then
    return jsonb_build_object('status', 'pending_rate', 'currency_code', v_code,
                              'reason', 'the currency is not in the rate table');
  end if;

  if v_cur.rate is null or v_cur.rate <= 0 then
    return jsonb_build_object('status', 'pending_rate', 'currency_code', v_code, 'rate_id', v_cur.id,
                              'reason', 'no ratio has been set for this currency today');
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'currency_code', v_code,
    'rate_id', v_cur.id,
    'rate_value', v_cur.rate::text,
    'rate_convention', format('1 USD = %s %s', trim(trailing '.' from trim(trailing '0' from v_cur.rate::text)), v_code),
    'inverse_value', round(1 / v_cur.rate, 10)::text,
    'rate_updated', v_cur.rate_updated,
    -- The value, not the moment it was typed. Re-entering today's ratio unchanged is not a
    -- change to any total, and must not invalidate a review that is open on the screen.
    'rate_version', md5(v_cur.id || '|' || v_cur.rate::text));
end;
$$;

-- ── the one read model ───────────────────────────────────────────────────────
--
-- Read by the administrator and by the person who sent the receipts, through this one function.
-- Whoever asks, the bytes are the same; there is no second implementation to disagree with.
--
-- Currencies are never mixed. §4.9 allows native totals in the receipt's own currency and USD
-- equivalents beside them, each carrying the amount it came from and the rate that produced it —
-- and nothing else. There is no combined figure across currencies because there is no such
-- quantity.
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
                                          'source_amount', jsonb_build_object('amount_decimal', r.gross_total::text, 'currency_code', r.currency_code)),
        'fee_total', jsonb_build_object('amount_decimal', round(r.fee_total / v_rate_value, 2)::text,
                                        'currency_code', 'USD',
                                        'unrounded', (r.fee_total / v_rate_value)::text,
                                        'source_amount', jsonb_build_object('amount_decimal', r.fee_total::text, 'currency_code', r.currency_code)),
        'net_total', jsonb_build_object('amount_decimal', round(r.net_total / v_rate_value, 2)::text,
                                        'currency_code', 'USD',
                                        'unrounded', (r.net_total / v_rate_value)::text,
                                        'source_amount', jsonb_build_object('amount_decimal', r.net_total::text, 'currency_code', r.currency_code)),
        'order_total', jsonb_build_object('amount_decimal', round(r.net_total / v_rate_value, 2)::text,
                                          'currency_code', 'USD',
                                          'unrounded', (r.net_total / v_rate_value)::text,
                                          'source_amount', jsonb_build_object('amount_decimal', r.net_total::text, 'currency_code', r.currency_code)),
        'calculated_at', v_now);
    else
      v_pending := true;
      v_usd := jsonb_build_object('status', 'pending_rate', 'reason', v_rate->>'reason');
    end if;

    v_currencies := v_currencies || jsonb_build_array(jsonb_build_object(
      'currency_code', r.currency_code,
      'count', r.n,
      'native', jsonb_build_object(
        'gross_total', jsonb_build_object('amount_decimal', r.gross_total::text, 'currency_code', r.currency_code),
        'fee_total', jsonb_build_object('amount_decimal', r.fee_total::text, 'currency_code', r.currency_code),
        'net_total', jsonb_build_object('amount_decimal', r.net_total::text, 'currency_code', r.currency_code),
        'order_total', jsonb_build_object('amount_decimal', r.net_total::text, 'currency_code', r.currency_code)),
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

-- ── refusing to act on a figure that has moved ───────────────────────────────
--
-- §4.15: finalization quoting a stale version returns 409. PostgREST maps a SQLSTATE of the
-- form PTnnn onto that HTTP status, so the interface receives a 409 and the word stale_summary
-- rather than a generic failure it would have to guess at.
create or replace function public.sarraf_assert_summary_current(p_batch_id text, p_summary_version text)
returns void
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare v_current text;
begin
  if nullif(btrim(coalesce(p_summary_version, '')), '') is null then
    raise exception using errcode = '22023',
      message = 'the summary version being acted on must be quoted';
  end if;

  v_current := public.sarraf_batch_summary(p_batch_id)->>'summary_version';
  if v_current is distinct from btrim(p_summary_version) then
    raise exception using errcode = 'PT409',
      message = 'stale_summary',
      detail = format('the figures moved: this action quoted %s, the batch is now at %s',
                      left(btrim(p_summary_version), 12), left(coalesce(v_current, '-'), 12)),
      hint = 'reload the batch and check the totals before finalizing';
  end if;
end;
$$;

-- ── finalization quotes the version it is finalizing ─────────────────────────
--
-- Recreated rather than replaced: the signature gains the version being acted on, and
-- PostgreSQL will not add a parameter to an existing function in place. The body is unchanged
-- apart from the guard, which runs before anything is written.
drop function if exists public.sarraf_finalize_receipt_batch(text, text, boolean, text);

create function public.sarraf_finalize_receipt_batch(
  p_batch_id text,
  p_reason text,
  p_owner_override boolean,
  p_command_key text,
  p_summary_version text default null
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

  -- The figures this decision was taken against must still be the figures on the batch.
  perform public.sarraf_assert_summary_current(p_batch_id, p_summary_version);

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
    'owner_override',v_override,'policy_version',v_policy.version,
    'summary_version',btrim(p_summary_version),'replayed',false);
  insert into public.receipt_audit_events(event_type,batch_id,actor_id,command_key,metadata)
    values('finalized',p_batch_id,v_actor.id,p_command_key,
      jsonb_build_object('decision',v_decision,'policy_version',v_policy.version,
        'decision_by',v_batch.decision_by,'finalized_by',v_actor.id,'owner_override',v_override,
        'reason',v_reason,'summary_version',btrim(p_summary_version)));
  insert into public.receipt_review_commands(actor_id,command_key,batch_id,decision,result)
    values(v_actor.id,p_command_key,p_batch_id,'finalize',v_result);
  return v_result;
end;
$$;

comment on function public.sarraf_finalize_receipt_batch(text,text,boolean,text,text) is
  'Finalizes a reviewed receipt batch. Refuses with PT409 stale_summary when the quoted summary version is no longer the batch''s current one.';

revoke all on function public.sarraf_finalize_receipt_batch(text,text,boolean,text,text) from public, anon;
grant execute on function public.sarraf_finalize_receipt_batch(text,text,boolean,text,text) to authenticated;
revoke all on function public.sarraf_batch_summary(text) from public, anon;
grant execute on function public.sarraf_batch_summary(text) to authenticated;
revoke all on function public.sarraf_receipt_set_version(text) from public, anon;
grant execute on function public.sarraf_receipt_set_version(text) to authenticated;
revoke all on function public.sarraf_rate_snapshot(text) from public, anon;
grant execute on function public.sarraf_rate_snapshot(text) to authenticated;
revoke all on function public.sarraf_assert_summary_current(text, text) from public, anon;
grant execute on function public.sarraf_assert_summary_current(text, text) to authenticated;

commit;
