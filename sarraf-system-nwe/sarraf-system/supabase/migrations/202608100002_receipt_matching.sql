-- Phase A3: explainable recommendations and human-authorized batch matching.
-- Existing cardinality is preserved: one transaction reference per batch; a transaction may
-- continue to have multiple receipt batches. No ledger/accounting table is read for update.
alter table public.receipt_batches add column if not exists tx_id text references public.txs(id);
alter table public.receipt_batches add column if not exists receipt_stage text not null default 'received';
alter table public.receipt_batches add column if not exists matched_score integer;
alter table public.receipt_batches add column if not exists match_reason text;
alter table public.receipt_batches add column if not exists matched_at timestamptz;
alter table public.receipt_batches add column if not exists matched_by text references public.app_users(id);
alter table public.receipt_batches add column if not exists match_version bigint not null default 0;
alter table public.receipt_batches add constraint receipt_batches_stage_a3 check (receipt_stage in ('received','reading','needs_review','verified','matched','archived')) not valid;
alter table public.receipt_batches add constraint receipt_batches_match_score_a3 check (matched_score between 0 and 100) not valid;

create table if not exists public.receipt_match_commands (
  actor_id text not null references public.app_users(id),
  command_key text not null,
  batch_id text not null references public.receipt_batches(id),
  tx_id text not null references public.txs(id),
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(actor_id, command_key),
  check (command_key ~ '^receipt-match:[A-Za-z0-9:_-]{16,220}$')
);
alter table public.receipt_match_commands enable row level security;
revoke all on public.receipt_match_commands from public, anon, authenticated;

create index if not exists idx_receipt_batches_stage_created_a3 on public.receipt_batches(receipt_stage, created_at desc);
create index if not exists idx_receipt_batches_tx_a3 on public.receipt_batches(tx_id) where tx_id is not null;
create index if not exists idx_receipts_ref_a3 on public.receipts(ref_no) where ref_no is not null;
create index if not exists idx_receipts_hash_a3 on public.receipts(image_hash) where image_hash is not null;

create or replace function public.sarraf_receipt_match_candidates(p_batch_id text, p_limit integer default 8)
returns table(tx_id text, tx_code integer, tx_type text, tx_status text, tx_amount numeric,
  tx_currency text, tx_counterparty text, tx_date timestamptz, score integer, reasons jsonb)
language plpgsql security definer stable set search_path=pg_catalog,public as $$
declare v_actor public.app_users%rowtype; v_batch public.receipt_batches%rowtype;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found then raise exception using errcode='42501',message='not authorized'; end if;
  select * into v_batch from public.receipt_batches where id=p_batch_id;
  if not found then raise exception using errcode='P0002',message='receipt batch not found'; end if;
  if v_actor.role not in ('admin','office')
    and not (v_actor.role='customer' and v_batch.customer_id=v_actor.id)
    and not (v_actor.role='partner' and v_batch.partner_id=v_actor.id)
  then raise exception using errcode='42501',message='not authorized'; end if;

  return query
  with receipt_signal as (
    select array_agg(distinct upper(regexp_replace(coalesce(r.ref_no,''),'[^[:alnum:]]','','g'))) filter(where nullif(r.ref_no,'') is not null) refs,
      array_agg(distinct upper(regexp_replace(coalesce(r.raw->>'merchantOrderNo',r.raw->>'merchant_order_no',''),'[^[:alnum:]]','','g')))
        filter(where nullif(coalesce(r.raw->>'merchantOrderNo',r.raw->>'merchant_order_no',''),'') is not null) merchant_refs,
      min(coalesce(r.tx_date::timestamptz,r.created_at)) receipt_date,
      string_agg(distinct lower(coalesce(r.receiver,'')),' ') payees
    from public.receipts r where r.batch_id=v_batch.id
  ), ranked as (
    select t.*, c.code currency_code, rs.*,
      (upper(regexp_replace(t.code::text,'[^[:alnum:]]','','g'))=any(coalesce(rs.refs,array[]::text[]))) exact_order,
      (upper(regexp_replace(t.code::text,'[^[:alnum:]]','','g'))=any(coalesce(rs.merchant_refs,array[]::text[]))) exact_merchant,
      abs(t.amount-v_batch.total_net) amount_delta,
      greatest(.01,abs(v_batch.total_net)*.001) amount_tolerance,
      abs(extract(epoch from (t.date-rs.receipt_date)))/3600 time_hours,
      (upper(c.code)=upper(v_batch.currency)) currency_match,
      (t.cp_id is not distinct from v_batch.customer_id) customer_match,
      (t.partner_id is not distinct from v_batch.partner_id) partner_match,
      ((v_batch.direction in ('in','buy') and t.type='buy') or (v_batch.direction in ('out','sell') and t.type='sell')) direction_match
    from public.txs t join public.currencies c on c.id=t.cur_id cross join receipt_signal rs
    where not t.deleted and t.status in ('completed','pending')
      and (v_actor.role in ('admin','office') or t.cp_id=v_actor.id or t.partner_id=v_actor.id)
      and t.date between coalesce(rs.receipt_date,v_batch.created_at)-interval '14 days' and coalesce(rs.receipt_date,v_batch.created_at)+interval '14 days'
  ), scored as (
    select x.*, greatest(0,least(100,
      (case when exact_order then 55 else 0 end)+(case when exact_merchant then 50 else 0 end)+
      (case when currency_match then 15 else -45 end)+(case when amount_delta<=amount_tolerance then 20 else -20 end)+
      (case when time_hours<=24 then 8 when time_hours<=72 then 4 else -8 end)+
      (case when customer_match then 10 else -20 end)+(case when partner_match then 8 else -12 end)+
      (case when direction_match then 5 else -15 end)))::integer calculated_score
    from ranked x
  )
  select s.id,s.code,s.type,s.status,s.amount,s.currency_code,coalesce(s.cp_name,u.name),s.date,s.calculated_score,
    jsonb_build_object('exact_order_no',s.exact_order,'exact_merchant_order_no',s.exact_merchant,
      'currency_match',s.currency_match,'amount_delta',s.amount_delta,'amount_tolerance',s.amount_tolerance,
      'time_hours',round(s.time_hours::numeric,2),'customer_match',s.customer_match,
      'partner_match',s.partner_match,'direction_match',s.direction_match,
      'penalties',jsonb_strip_nulls(jsonb_build_object('currency',case when not s.currency_match then -45 end,
        'amount',case when s.amount_delta>s.amount_tolerance then -20 end,'date',case when s.time_hours>72 then -8 end,
        'customer',case when not s.customer_match then -20 end,'partner',case when not s.partner_match then -12 end,
        'direction',case when not s.direction_match then -15 end)))
    from scored s left join public.app_users u on u.id=s.cp_id
    order by s.calculated_score desc,s.time_hours,s.id limit least(greatest(coalesce(p_limit,8),1),20);
end $$;

revoke all on function public.sarraf_receipt_match_candidates(text,integer) from public,anon;
grant execute on function public.sarraf_receipt_match_candidates(text,integer) to authenticated;

create or replace function public.sarraf_confirm_receipt_match(p_batch_id text,p_tx_id text,p_reason text,p_command_key text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_actor public.app_users%rowtype; v_batch public.receipt_batches%rowtype; v_tx public.txs%rowtype; v_candidate record; v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role not in ('admin','office') then raise exception using errcode='42501',message='not authorized'; end if;
  if p_command_key !~ '^receipt-match:[A-Za-z0-9:_-]{16,220}$' then raise exception using errcode='22023',message='invalid request identity'; end if;
  perform pg_advisory_xact_lock(hashtextextended('receipt-batch:'||p_batch_id,0));
  select result into v_result from public.receipt_match_commands where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_result||jsonb_build_object('replayed',true); end if;
  select * into v_batch from public.receipt_batches where id=p_batch_id for update;
  if not found then raise exception using errcode='P0002',message='receipt batch not found'; end if;
  select * into v_tx from public.txs where id=p_tx_id for share;
  if not found or v_tx.deleted or v_tx.status not in ('completed','pending') then raise exception using errcode='22023',message='transaction is not eligible'; end if;
  if v_batch.receipt_stage='archived' then raise exception using errcode='22023',message='archived batch cannot be matched'; end if;
  if v_batch.tx_id is not null and v_batch.tx_id<>p_tx_id then raise exception using errcode='40001',message='receipt batch was already matched'; end if;
  if v_batch.customer_id is not null and v_tx.cp_id is distinct from v_batch.customer_id then raise exception using errcode='22023',message='objects do not share an authorized context'; end if;
  if v_batch.partner_id is not null and v_tx.partner_id is distinct from v_batch.partner_id then raise exception using errcode='22023',message='objects do not share an authorized context'; end if;
  select * into v_candidate from public.sarraf_receipt_match_candidates(p_batch_id,20) c where c.tx_id=p_tx_id;
  if not found then raise exception using errcode='22023',message='transaction is outside the safe candidate window'; end if;
  if v_candidate.score<80 and char_length(btrim(coalesce(p_reason,'')))<8 then raise exception using errcode='22023',message='a review reason is required'; end if;
  v_result:=jsonb_build_object('batch_id',p_batch_id,'tx_id',p_tx_id,'score',v_candidate.score,'replayed',false);
  update public.receipt_batches set tx_id=p_tx_id,receipt_stage='matched',status='done',matched_score=v_candidate.score,
    match_reason=left(nullif(btrim(p_reason),''),500),matched_at=clock_timestamp(),matched_by=v_actor.id,match_version=match_version+1 where id=p_batch_id;
  insert into public.receipt_audit_events(event_type,batch_id,actor_id,command_key,metadata)
    values('matched',p_batch_id,v_actor.id,p_command_key,jsonb_build_object('tx_id',p_tx_id,'score',v_candidate.score,'reason',left(nullif(btrim(p_reason),''),500),'signals',v_candidate.reasons));
  insert into public.receipt_match_commands values(v_actor.id,p_command_key,p_batch_id,p_tx_id,v_result,clock_timestamp());
  return v_result;
end $$;
revoke all on function public.sarraf_confirm_receipt_match(text,text,text,text) from public,anon;
grant execute on function public.sarraf_confirm_receipt_match(text,text,text,text) to authenticated;
