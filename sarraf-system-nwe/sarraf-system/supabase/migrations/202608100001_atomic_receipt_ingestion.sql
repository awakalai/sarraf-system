-- Phase A2: authenticated, idempotent and transactional receipt ingestion.
create table if not exists public.receipt_ingestion_commands (
  actor_id text not null references public.app_users(id),
  command_key text not null,
  batch_id text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (actor_id, command_key),
  unique (batch_id),
  check (char_length(command_key) between 16 and 160)
);

create table if not exists public.receipt_audit_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  batch_id text not null,
  receipt_id text,
  actor_id text not null references public.app_users(id),
  command_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  check (event_type in ('batch_created','receipt_created','manual_correction','verified','rejected','matched','archived')),
  check (jsonb_typeof(metadata) = 'object')
);

alter table public.receipt_ingestion_commands enable row level security;
alter table public.receipt_audit_events enable row level security;
revoke all on public.receipt_ingestion_commands, public.receipt_audit_events from anon, authenticated;
grant select on public.receipt_audit_events to authenticated;
create policy receipt_audit_admin_read on public.receipt_audit_events for select to authenticated using (public.is_admin());
create policy receipt_audit_actor_read on public.receipt_audit_events for select to authenticated using (actor_id = public.my_app_id());

create or replace function public.sarraf_ingest_receipt_batch(p_batch jsonb, p_receipts jsonb, p_command_key text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, storage
as $$
declare
  v_actor public.app_users%rowtype;
  v_batch_id text := btrim(p_batch->>'id');
  v_customer_id text := nullif(btrim(p_batch->>'customer_id'), '');
  v_partner_id text := nullif(btrim(p_batch->>'partner_id'), '');
  v_count int;
  r jsonb;
  v_path text;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then raise exception using errcode='42501', message='not authorized'; end if;
  if p_batch is null or jsonb_typeof(p_batch) <> 'object' or jsonb_typeof(p_receipts) <> 'array' then
    raise exception using errcode='22023', message='invalid receipt command';
  end if;
  if octet_length(p_receipts::text) > 1048576 then raise exception using errcode='22023', message='receipt metadata too large'; end if;
  if p_command_key !~ '^receipt-ingest:[A-Za-z0-9-]{16,128}$' or v_batch_id !~ '^[A-Za-z0-9-]{16,128}$' then
    raise exception using errcode='22023', message='invalid command identity';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || p_command_key, 0));
  if exists (select 1 from public.receipt_ingestion_commands where actor_id=v_actor.id and command_key=p_command_key) then
    return (select jsonb_build_object('batch_id', batch_id, 'replayed', true) from public.receipt_ingestion_commands where actor_id=v_actor.id and command_key=p_command_key);
  end if;
  if v_actor.role not in ('admin','office') and not (v_actor.role='customer' and v_customer_id=v_actor.id) and not (v_actor.role='partner' and v_partner_id=v_actor.id) then
    raise exception using errcode='42501', message='context not authorized';
  end if;
  if v_customer_id is not null and not exists(select 1 from public.app_users where id=v_customer_id and role='customer' and not deleted) then raise exception using errcode='22023', message='invalid customer'; end if;
  if v_partner_id is not null and not exists(select 1 from public.app_users where id=v_partner_id and role='partner' and not deleted) then raise exception using errcode='22023', message='invalid partner'; end if;
  v_count := jsonb_array_length(p_receipts);
  if v_count < 1 or v_count > 25 then raise exception using errcode='22023', message='invalid receipt count'; end if;
  if (p_batch->>'direction') not in ('in','out','buy','sell') or coalesce(p_batch->>'currency','') !~ '^[A-Z]{3,8}$' then raise exception using errcode='22023', message='invalid batch metadata'; end if;

  for r in select value from jsonb_array_elements(p_receipts) loop
    if jsonb_typeof(r) <> 'object' or jsonb_typeof(coalesce(r->'raw','{}'::jsonb)) <> 'object' then raise exception using errcode='22023', message='invalid receipt metadata'; end if;
    if (r->>'id') !~ '^[A-Za-z0-9-]{6,128}$' or r->>'batch_id' <> v_batch_id then raise exception using errcode='22023', message='invalid receipt identity'; end if;
    if nullif(r->>'amount','') is null or (r->>'amount')::numeric <= 0 or (r->>'amount')::numeric > 1000000000000 then raise exception using errcode='22023', message='invalid amount'; end if;
    if coalesce((r->>'fee')::numeric,0) < 0 or coalesce((r->>'fee')::numeric,0) > (r->>'amount')::numeric then raise exception using errcode='22023', message='invalid fee'; end if;
    if coalesce(r->>'currency','') !~ '^[A-Z]{3,8}$' or coalesce(r->>'status','') not in ('ok','suspect','error','rejected') then raise exception using errcode='22023', message='invalid receipt metadata'; end if;
    v_path := r->>'image_path';
    if v_path <> format('ingest/%s/%s.jpg', v_batch_id, r->>'id') then raise exception using errcode='22023', message='invalid object path'; end if;
    if not exists (select 1 from storage.objects o where o.bucket_id='receipts' and o.name=v_path and o.owner_id=auth.uid()::text and coalesce((o.metadata->>'size')::bigint,0) between 1 and 10485760 and lower(coalesce(o.metadata->>'mimetype','')) in ('image/jpeg','image/png','image/webp','image/heic','image/heif')) then
      raise exception using errcode='22023', message='invalid staged object';
    end if;
  end loop;

  -- Totals and ownership are derived here; browser-calculated values are deliberately ignored.
  insert into public.receipt_batches(id,customer_id,customer_name,partner_id,direction,status,currency,total_gross,total_fee,total_net,n,dup_n,rejected_n,uploaded_by,source)
  select v_batch_id,v_customer_id,case when v_customer_id is null then left(nullif(p_batch->>'customer_name',''),120) else (select name from public.app_users where id=v_customer_id) end,v_partner_id,p_batch->>'direction','new',p_batch->>'currency',
    sum((x->>'amount')::numeric),sum(coalesce((x->>'fee')::numeric,0)),sum(coalesce(nullif(x->>'net_amount','')::numeric,(x->>'amount')::numeric-coalesce((x->>'fee')::numeric,0))),
    v_count,0,count(*) filter (where x->>'status' in ('error','rejected')),v_actor.id,left(coalesce(p_batch->>'source','app'),30)
  from jsonb_array_elements(p_receipts) x;

  for r in select value from jsonb_array_elements(p_receipts) loop
    insert into public.receipts(id,batch_id,customer_id,customer_name,direction,amount,fee,fee_original,fee_discount,platform,net_amount,currency,sender,receiver,ref_no,tx_time,tx_date,bank,note,image_hash,image_path,status,counted,reject_code,reject_reason,dup_of,dup_of_date,dup_of_who,uploaded_by,raw)
    values(r->>'id',v_batch_id,v_customer_id,case when v_customer_id is null then left(nullif(r->>'customer_name',''),120) else (select name from public.app_users where id=v_customer_id) end,p_batch->>'direction',(r->>'amount')::numeric,coalesce((r->>'fee')::numeric,0),nullif(r->>'fee_original','')::numeric,coalesce((r->>'fee_discount')::numeric,0),left(r->>'platform',60),nullif(r->>'net_amount','')::numeric,r->>'currency',left(r->>'sender',160),left(r->>'receiver',160),left(r->>'ref_no',160),nullif(r->>'tx_time','')::time,nullif(r->>'tx_date','')::date,left(r->>'bank',80),left(r->>'note',1000),left(r->>'image_hash',256),r->>'image_path',r->>'status',coalesce((r->>'counted')::boolean,true),left(r->>'reject_code',60),left(r->>'reject_reason',500),nullif(r->>'dup_of',''),nullif(r->>'dup_of_date','')::timestamptz,left(r->>'dup_of_who',160),v_actor.id,coalesce(r->'raw','{}'::jsonb));
    insert into public.receipt_audit_events(event_type,batch_id,receipt_id,actor_id,command_key,metadata) values('receipt_created',v_batch_id,r->>'id',v_actor.id,p_command_key,jsonb_build_object('status',r->>'status','currency',r->>'currency','amount',r->>'amount','image_hash',left(r->>'image_hash',256),'ref_no',left(r->>'ref_no',160)));
  end loop;
  insert into public.receipt_audit_events(event_type,batch_id,actor_id,command_key,metadata) values('batch_created',v_batch_id,v_actor.id,p_command_key,jsonb_build_object('receipt_count',v_count,'customer_id',v_customer_id,'partner_id',v_partner_id,'source',left(coalesce(p_batch->>'source','app'),30)));
  insert into public.receipt_ingestion_commands(actor_id,command_key,batch_id) values(v_actor.id,p_command_key,v_batch_id);
  return jsonb_build_object('batch_id',v_batch_id,'receipt_count',v_count,'replayed',false);
end;
$$;

revoke all on function public.sarraf_ingest_receipt_batch(jsonb,jsonb,text) from public, anon;
grant execute on function public.sarraf_ingest_receipt_batch(jsonb,jsonb,text) to authenticated;

-- Audit rows remain append-only even for privileged table owners using normal DML.
create or replace function public.prevent_receipt_audit_mutation() returns trigger language plpgsql set search_path=pg_catalog as $$ begin raise exception using errcode='42501',message='receipt audit is append-only'; end $$;
create trigger receipt_audit_immutable before update or delete on public.receipt_audit_events for each row execute function public.prevent_receipt_audit_mutation();

create or replace function public.audit_receipt_transition() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_actor text;
begin
  select id into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if v_actor is null then return new; end if;
  if old.status is distinct from new.status or old.amount is distinct from new.amount or old.currency is distinct from new.currency or old.ref_no is distinct from new.ref_no then
    insert into public.receipt_audit_events(event_type,batch_id,receipt_id,actor_id,command_key,metadata)
    values(case when new.status in ('verified','confirmed','ok') then 'verified' when new.status in ('rejected','error') then 'rejected' when new.status='matched' then 'matched' when new.status='archived' then 'archived' else 'manual_correction' end,
      new.batch_id,new.id,v_actor,'transition:'||txid_current()::text,
      jsonb_build_object('before',jsonb_build_object('status',old.status,'amount',old.amount,'currency',old.currency,'ref_no',old.ref_no),'after',jsonb_build_object('status',new.status,'amount',new.amount,'currency',new.currency,'ref_no',new.ref_no)));
  end if;
  return new;
end $$;
drop trigger if exists receipt_transition_audit on public.receipts;
create trigger receipt_transition_audit after update on public.receipts for each row execute function public.audit_receipt_transition();
