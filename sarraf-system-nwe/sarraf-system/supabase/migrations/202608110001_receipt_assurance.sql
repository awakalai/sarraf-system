-- Receipt Assurance v1
-- Durable intake for every image, API-authorized ingestion, atomic conversion,
-- partner custody, portal privacy, append-only audit, and admin notifications.
begin;

create table if not exists public.receipt_ingestion_authorizations (
  command_key text primary key,
  actor_id text not null references public.app_users(id),
  authorization_token text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default statement_timestamp(),
  check (command_key ~ '^receipt-ingest:[A-Za-z0-9-]{16,128}$'),
  check (authorization_token ~ '^[A-Za-z0-9_-]{43}$')
);

create table if not exists public.receipt_intake_items (
  id text primary key,
  batch_id text not null references public.receipt_batches(id) on delete restrict,
  submitted_by text not null references public.app_users(id),
  customer_id text references public.app_users(id),
  partner_id text references public.app_users(id),
  direction text not null check (direction in ('in','out','buy','sell')),
  image_path text not null,
  image_hash text,
  amount numeric,
  fee numeric,
  net_amount numeric,
  currency text,
  ref_no text,
  source_status text not null,
  intake_status text not null check (intake_status in ('accepted','rejected')),
  counted boolean not null default false,
  rule_code text,
  rule_reason text,
  transaction_id text references public.txs(id),
  converted_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default statement_timestamp(),
  check (jsonb_typeof(raw) = 'object'),
  check (image_path ~ '^ingest/[A-Za-z0-9-]{16,128}/[A-Za-z0-9-]{6,128}\.jpg$'),
  check (
    (intake_status = 'accepted' and counted and amount > 0 and amount <= 1000000000000
      and coalesce(fee,0) >= 0 and coalesce(fee,0) <= amount and currency ~ '^[A-Z]{3,8}$')
    or
    (intake_status = 'rejected' and not counted and rule_code is not null and rule_reason is not null)
  )
);

create unique index if not exists receipt_intake_accepted_hash_uq
  on public.receipt_intake_items(image_hash)
  where intake_status = 'accepted' and image_hash is not null and source_status <> 'legacy';
create unique index if not exists receipt_intake_accepted_ref_uq
  on public.receipt_intake_items((upper(regexp_replace(ref_no, '[^0-9A-Za-z]', '', 'g'))))
  where intake_status = 'accepted' and source_status <> 'legacy'
    and nullif(regexp_replace(ref_no, '[^0-9A-Za-z]', '', 'g'), '') is not null;
create index if not exists receipt_intake_batch_created_idx on public.receipt_intake_items(batch_id, created_at);
create index if not exists receipt_intake_status_created_idx on public.receipt_intake_items(intake_status, created_at desc);

create table if not exists public.receipt_custody (
  item_id text primary key references public.receipt_intake_items(id) on delete restrict,
  batch_id text not null references public.receipt_batches(id) on delete restrict,
  partner_id text references public.app_users(id),
  assigned_by text not null references public.app_users(id),
  assignment_reason text not null,
  version bigint not null default 1 check (version > 0),
  assigned_at timestamptz not null default statement_timestamp(),
  check (char_length(assignment_reason) between 8 and 700)
);

create table if not exists public.receipt_custody_events (
  id bigint generated always as identity primary key,
  item_id text not null references public.receipt_intake_items(id),
  batch_id text not null references public.receipt_batches(id),
  from_partner_id text references public.app_users(id),
  to_partner_id text references public.app_users(id),
  actor_id text not null references public.app_users(id),
  reason text not null,
  command_key text not null,
  created_at timestamptz not null default statement_timestamp(),
  check (char_length(reason) between 8 and 700)
);
create index if not exists receipt_custody_partner_idx on public.receipt_custody(partner_id, assigned_at desc);
create index if not exists receipt_custody_events_item_idx on public.receipt_custody_events(item_id, created_at desc);

create table if not exists public.receipt_operation_commands (
  actor_id text not null references public.app_users(id),
  command_key text not null,
  operation text not null check (operation in ('convert','custody')),
  batch_id text not null references public.receipt_batches(id),
  result jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key(actor_id, command_key),
  check (command_key ~ '^receipt-(convert|custody):[A-Za-z0-9:_-]{16,220}$'),
  check (jsonb_typeof(result) = 'object')
);

create table if not exists public.receipt_batch_transactions (
  batch_id text not null references public.receipt_batches(id) on delete restrict,
  transaction_id text not null references public.txs(id) on delete restrict,
  partner_id text references public.app_users(id),
  item_count integer not null check (item_count > 0),
  amount numeric not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3,8}$'),
  created_by text not null references public.app_users(id),
  created_at timestamptz not null default statement_timestamp(),
  primary key(batch_id,transaction_id)
);

create table if not exists public.receipt_pending_conversions (
  approval_id text primary key,
  batch_id text not null references public.receipt_batches(id) on delete restrict,
  item_ids jsonb not null check (jsonb_typeof(item_ids)='array'),
  partner_id text references public.app_users(id),
  item_count integer not null check (item_count > 0),
  amount numeric not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3,8}$'),
  requested_by text not null references public.app_users(id),
  command_key text not null,
  status text not null default 'pending' check (status in ('pending','completed','cancelled')),
  created_at timestamptz not null default statement_timestamp(),
  resolved_at timestamptz
);

create table if not exists public.system_event_log (
  id bigint generated always as identity primary key,
  entity_table text not null,
  entity_id text,
  action text not null check (action in ('INSERT','UPDATE','DELETE')),
  actor_id text references public.app_users(id),
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default statement_timestamp()
);
create index if not exists system_event_created_idx on public.system_event_log(created_at desc);
create index if not exists system_event_entity_idx on public.system_event_log(entity_table, entity_id, created_at desc);

alter table public.receipt_ingestion_authorizations enable row level security;
alter table public.receipt_intake_items enable row level security;
alter table public.receipt_custody enable row level security;
alter table public.receipt_custody_events enable row level security;
alter table public.receipt_operation_commands enable row level security;
alter table public.receipt_batch_transactions enable row level security;
alter table public.receipt_pending_conversions enable row level security;
alter table public.system_event_log enable row level security;

revoke all on public.receipt_ingestion_authorizations, public.receipt_operation_commands from public, anon, authenticated;
grant select,insert,update,delete on public.receipt_ingestion_authorizations to service_role;
revoke all on public.receipt_pending_conversions from public, anon, authenticated;
revoke all on public.receipt_intake_items, public.receipt_custody, public.receipt_custody_events, public.system_event_log from public, anon, authenticated;
revoke all on public.receipt_batch_transactions from public, anon, authenticated;
grant select,insert,update,delete on public.receipt_intake_items to service_role;
grant select on public.receipt_intake_items, public.receipt_custody, public.receipt_custody_events, public.receipt_batch_transactions, public.system_event_log to authenticated;

drop policy if exists receipt_intake_staff_read on public.receipt_intake_items;
create policy receipt_intake_staff_read on public.receipt_intake_items for select to authenticated
using (public.is_admin() or public.my_role() = 'office');
drop policy if exists receipt_intake_partner_custody_read on public.receipt_intake_items;
create policy receipt_intake_partner_custody_read on public.receipt_intake_items for select to authenticated
using (exists (
  select 1 from public.receipt_custody c
  where c.item_id = receipt_intake_items.id and c.partner_id = public.my_app_id()
));

drop policy if exists receipt_custody_staff_read on public.receipt_custody;
create policy receipt_custody_staff_read on public.receipt_custody for select to authenticated
using (public.is_admin() or public.my_role() = 'office');
drop policy if exists receipt_custody_partner_read on public.receipt_custody;
create policy receipt_custody_partner_read on public.receipt_custody for select to authenticated
using (partner_id = public.my_app_id());
drop policy if exists receipt_custody_events_staff_read on public.receipt_custody_events;
create policy receipt_custody_events_staff_read on public.receipt_custody_events for select to authenticated
using (public.is_admin() or public.my_role() = 'office');
drop policy if exists receipt_custody_events_partner_read on public.receipt_custody_events;
create policy receipt_custody_events_partner_read on public.receipt_custody_events for select to authenticated
using (from_partner_id = public.my_app_id() or to_partner_id = public.my_app_id());
drop policy if exists system_event_admin_read on public.system_event_log;
create policy system_event_admin_read on public.system_event_log for select to authenticated using (public.is_admin());
drop policy if exists receipt_batch_transactions_staff_read on public.receipt_batch_transactions;
create policy receipt_batch_transactions_staff_read on public.receipt_batch_transactions for select to authenticated
using (public.is_admin() or public.my_role()='office');
drop policy if exists receipt_batch_transactions_partner_read on public.receipt_batch_transactions;
create policy receipt_batch_transactions_partner_read on public.receipt_batch_transactions for select to authenticated
using (partner_id=public.my_app_id());

-- Backfill durable intake for legacy receipt rows with preserved images.
insert into public.receipt_intake_items(
  id,batch_id,submitted_by,customer_id,partner_id,direction,image_path,image_hash,
  amount,fee,net_amount,currency,ref_no,source_status,intake_status,counted,rule_code,rule_reason,raw,created_at
)
select
  r.id,r.batch_id,coalesce(r.uploaded_by,b.uploaded_by,b.customer_id,b.partner_id),r.customer_id,r.partner_id,
  coalesce(r.direction,b.direction,'in'),r.image_path,r.image_hash,r.amount,coalesce(r.fee,0),
  coalesce(r.net_amount,r.amount-coalesce(r.fee,0)),r.currency,r.ref_no,'legacy',
  case when coalesce(r.counted,true) and r.status not in ('dup','error','rejected')
      and r.amount > 0 and r.amount <= 1000000000000
      and coalesce(r.fee,0) between 0 and r.amount and r.currency ~ '^[A-Z]{3,8}$'
    then 'accepted' else 'rejected' end,
  coalesce(r.counted,true) and r.status not in ('dup','error','rejected')
    and r.amount > 0 and r.amount <= 1000000000000
    and coalesce(r.fee,0) between 0 and r.amount and r.currency ~ '^[A-Z]{3,8}$',
  case when coalesce(r.counted,true) and r.status not in ('dup','error','rejected')
      and r.amount > 0 and r.amount <= 1000000000000
      and coalesce(r.fee,0) between 0 and r.amount and r.currency ~ '^[A-Z]{3,8}$'
    then null else coalesce(r.reject_code,'legacy_rejected') end,
  case when coalesce(r.counted,true) and r.status not in ('dup','error','rejected')
      and r.amount > 0 and r.amount <= 1000000000000
      and coalesce(r.fee,0) between 0 and r.amount and r.currency ~ '^[A-Z]{3,8}$'
    then null else coalesce(r.reject_reason,r.note,'فیشی کۆن؛ پێشتر هەژمار نەکراوە') end,
  coalesce(r.raw,'{}'::jsonb),coalesce(r.created_at,b.created_at,statement_timestamp())
from public.receipts r
join public.receipt_batches b on b.id = r.batch_id
where r.image_path is not null
  and coalesce(r.uploaded_by,b.uploaded_by,b.customer_id,b.partner_id) is not null
on conflict(id) do nothing;

-- API-authorized, idempotent ingestion. Invalid items are quarantined rather
-- than discarded and never enter the accounting receipt set.
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
  v_currency text := upper(coalesce(nullif(btrim(p_batch->>'currency'),''),'UNKNOWN'));
  v_count int;
  v_accepted int := 0;
  v_rejected int := 0;
  v_duplicates int := 0;
  v_total_gross numeric := 0;
  v_total_fee numeric := 0;
  v_total_net numeric := 0;
  v_authorized_actor text;
  v_authorization_token text := p_batch->>'_authorization_token';
  r jsonb;
  v_path text;
  v_amount numeric;
  v_fee numeric;
  v_net numeric;
  v_row_currency text;
  v_ref text;
  v_hash text;
  v_rule_code text;
  v_rule_reason text;
  v_accept boolean;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then raise exception using errcode='42501', message='not authorized'; end if;
  if p_batch is null or jsonb_typeof(p_batch) <> 'object' or jsonb_typeof(p_receipts) <> 'array' then
    raise exception using errcode='22023', message='invalid receipt command';
  end if;
  if octet_length(p_receipts::text) > 1572864 then raise exception using errcode='22023', message='receipt metadata too large'; end if;
  if p_command_key !~ '^receipt-ingest:[A-Za-z0-9-]{16,128}$' or v_batch_id !~ '^[A-Za-z0-9-]{16,128}$' then
    raise exception using errcode='22023', message='invalid command identity';
  end if;
  if (p_batch->>'direction') not in ('in','out','buy','sell') or v_currency !~ '^[A-Z]{3,8}$' then
    raise exception using errcode='22023', message='invalid batch metadata';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || p_command_key, 0));

  delete from public.receipt_ingestion_authorizations
  where command_key = p_command_key and actor_id = v_actor.id
    and authorization_token = v_authorization_token
    and expires_at > statement_timestamp()
  returning actor_id into v_authorized_actor;
  if v_authorized_actor is null then
    raise exception using errcode='42501', message='receipt command was not authorized by the ingestion service';
  end if;

  if exists (select 1 from public.receipt_ingestion_commands where actor_id=v_actor.id and command_key=p_command_key) then
    return (select jsonb_build_object('batch_id',batch_id,'replayed',true) from public.receipt_ingestion_commands where actor_id=v_actor.id and command_key=p_command_key);
  end if;
  if v_actor.role not in ('admin','office')
    and not (v_actor.role='customer' and v_customer_id=v_actor.id)
    and not (v_actor.role='partner' and v_partner_id=v_actor.id) then
    raise exception using errcode='42501', message='context not authorized';
  end if;
  if v_customer_id is not null and not exists(select 1 from public.app_users where id=v_customer_id and role='customer' and not deleted) then
    raise exception using errcode='22023', message='invalid customer';
  end if;
  if v_partner_id is not null and not exists(select 1 from public.app_users where id=v_partner_id and role='partner' and not deleted) then
    raise exception using errcode='22023', message='invalid partner';
  end if;
  v_count := jsonb_array_length(p_receipts);
  if v_count < 1 or v_count > 25 then raise exception using errcode='22023', message='invalid receipt count'; end if;

  -- Validate every staged object before writing any relational row.
  for r in select value from jsonb_array_elements(p_receipts) loop
    if jsonb_typeof(r) <> 'object' or jsonb_typeof(coalesce(r->'raw','{}'::jsonb)) <> 'object' then
      raise exception using errcode='22023', message='invalid receipt metadata';
    end if;
    if (r->>'id') !~ '^[A-Za-z0-9-]{6,128}$' or r->>'batch_id' <> v_batch_id then
      raise exception using errcode='22023', message='invalid receipt identity';
    end if;
    v_path := r->>'image_path';
    if v_path <> format('ingest/%s/%s.jpg',v_batch_id,r->>'id') then raise exception using errcode='22023', message='invalid object path'; end if;
    if not exists (
      select 1 from storage.objects o
      where o.bucket_id='receipts' and o.name=v_path and o.owner_id=auth.uid()::text
        and coalesce((o.metadata->>'size')::bigint,0) between 1 and 10485760
        and lower(coalesce(o.metadata->>'mimetype',o.metadata->>'contentType','')) in ('image/jpeg','image/png','image/webp','image/heic','image/heif')
    ) then raise exception using errcode='22023', message='invalid staged object'; end if;
  end loop;

  insert into public.receipt_batches(
    id,customer_id,customer_name,partner_id,direction,status,currency,total_gross,total_fee,total_net,n,dup_n,rejected_n,uploaded_by,source,receipt_stage
  ) values (
    v_batch_id,v_customer_id,
    case when v_customer_id is null then left(nullif(p_batch->>'customer_name',''),120) else (select name from public.app_users where id=v_customer_id) end,
    v_partner_id,p_batch->>'direction','new',v_currency,0,0,0,v_count,0,0,v_actor.id,left(coalesce(p_batch->>'source','app'),30),'reading'
  );

  for r in select value from jsonb_array_elements(p_receipts) loop
    v_amount := case when coalesce(r->>'amount','') ~ '^\d+(\.\d+)?$' then (r->>'amount')::numeric else null end;
    v_fee := case when coalesce(r->>'fee','') ~ '^\d+(\.\d+)?$' then (r->>'fee')::numeric else 0 end;
    v_net := case when coalesce(r->>'net_amount','') ~ '^\d+(\.\d+)?$' then (r->>'net_amount')::numeric
      when v_amount is not null then v_amount-v_fee else null end;
    v_row_currency := upper(nullif(btrim(r->>'currency'),''));
    v_ref := left(nullif(btrim(r->>'ref_no'),''),160);
    v_hash := case when coalesce(r->>'image_hash','') ~ '^[a-f0-9]{64}$' then r->>'image_hash' else null end;
    v_rule_code := left(coalesce(nullif(r->>'rule_code',''),nullif(r->>'reject_code',''),'server_rejected'),80);
    v_rule_reason := left(coalesce(nullif(r->>'rule_reason',''),nullif(r->>'reject_reason',''),'فیشەکە یاساکانی ناردنی نەبڕیوە'),700);
    v_accept := coalesce(r->>'intake_status','')='accepted'
      and coalesce(r->>'status','')='ok' and coalesce(r->>'counted','') in ('true','t','1')
      and v_amount > 0 and v_amount <= 1000000000000 and v_fee >= 0 and v_fee <= v_amount
      and v_row_currency ~ '^[A-Z]{3,8}$' and v_row_currency = v_currency;

    if v_accept and exists (
      select 1 from public.receipt_intake_items i
      where i.intake_status='accepted'
        and ((v_hash is not null and i.image_hash=v_hash)
          or (nullif(regexp_replace(v_ref,'[^0-9A-Za-z]','','g'),'') is not null
            and upper(regexp_replace(i.ref_no,'[^0-9A-Za-z]','','g'))=upper(regexp_replace(v_ref,'[^0-9A-Za-z]','','g'))))
    ) then
      v_accept := false; v_rule_code := 'duplicate'; v_rule_reason := 'هەمان وێنە یان ژمارەی مامەڵە پێشتر تۆمار کراوە';
    end if;

    if v_accept then
      v_accepted := v_accepted + 1;
      v_total_gross := v_total_gross + v_amount;
      v_total_fee := v_total_fee + v_fee;
      v_total_net := v_total_net + v_net;
      insert into public.receipt_intake_items(
        id,batch_id,submitted_by,customer_id,partner_id,direction,image_path,image_hash,amount,fee,net_amount,currency,ref_no,
        source_status,intake_status,counted,rule_code,rule_reason,raw
      ) values (
        r->>'id',v_batch_id,v_actor.id,v_customer_id,v_partner_id,p_batch->>'direction',r->>'image_path',v_hash,v_amount,v_fee,v_net,v_row_currency,v_ref,
        left(coalesce(r->>'source_status',r->>'status','ok'),24),'accepted',true,
        nullif(left(r->>'rule_code',80),''),nullif(left(r->>'rule_reason',700),''),coalesce(r->'raw','{}'::jsonb)
      );
      insert into public.receipts(
        id,batch_id,customer_id,customer_name,direction,amount,fee,fee_original,fee_discount,platform,net_amount,currency,
        sender,receiver,ref_no,tx_time,tx_date,bank,note,image_hash,image_path,status,counted,reject_code,reject_reason,
        dup_of,dup_of_date,dup_of_who,uploaded_by,partner_id,raw
      ) values (
        r->>'id',v_batch_id,v_customer_id,
        case when v_customer_id is null then left(nullif(r->>'customer_name',''),120) else (select name from public.app_users where id=v_customer_id) end,
        p_batch->>'direction',v_amount,v_fee,
        case when coalesce(r->>'fee_original','') ~ '^\d+(\.\d+)?$' then (r->>'fee_original')::numeric else null end,
        case when coalesce(r->>'fee_discount','') ~ '^\d+(\.\d+)?$' then (r->>'fee_discount')::numeric else 0 end,
        left(r->>'platform',60),v_net,v_row_currency,left(r->>'sender',160),left(r->>'receiver',160),v_ref,
        case when coalesce(r->>'tx_time','') ~ '^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$' then (r->>'tx_time')::time else null end,
        case when coalesce(r->>'tx_date','') ~ '^\d{4}-\d{2}-\d{2}$' then (r->>'tx_date')::date else null end,
        left(r->>'bank',80),left(r->>'note',1000),v_hash,r->>'image_path','ok',true,null,null,
        nullif(r->>'dup_of',''),nullif(r->>'dup_of_date','')::timestamptz,left(r->>'dup_of_who',160),v_actor.id,v_partner_id,coalesce(r->'raw','{}'::jsonb)
      );
      insert into public.receipt_audit_events(event_type,batch_id,receipt_id,actor_id,command_key,metadata)
      values('receipt_created',v_batch_id,r->>'id',v_actor.id,p_command_key,
        jsonb_build_object('intake_status','accepted','currency',v_row_currency,'amount',v_amount,'image_hash',v_hash,'ref_no',v_ref));
    else
      v_rejected := v_rejected + 1;
      if v_rule_code in ('duplicate','same_batch','same_ref','same_image') then v_duplicates := v_duplicates + 1; end if;
      insert into public.receipt_intake_items(
        id,batch_id,submitted_by,customer_id,partner_id,direction,image_path,image_hash,amount,fee,net_amount,currency,ref_no,
        source_status,intake_status,counted,rule_code,rule_reason,raw
      ) values (
        r->>'id',v_batch_id,v_actor.id,v_customer_id,v_partner_id,p_batch->>'direction',r->>'image_path',v_hash,v_amount,v_fee,v_net,v_row_currency,v_ref,
        left(coalesce(r->>'source_status',r->>'status','rejected'),24),'rejected',false,v_rule_code,v_rule_reason,coalesce(r->'raw','{}'::jsonb)
      );
      insert into public.receipt_audit_events(event_type,batch_id,receipt_id,actor_id,command_key,metadata)
      values('rejected',v_batch_id,r->>'id',v_actor.id,p_command_key,
        jsonb_build_object('intake_status','rejected','rule_code',v_rule_code,'rule_reason',v_rule_reason,'image_hash',v_hash,'ref_no',v_ref));
    end if;
  end loop;

  update public.receipt_batches set
    total_gross=v_total_gross,total_fee=v_total_fee,total_net=v_total_net,n=v_count,
    dup_n=v_duplicates,rejected_n=v_rejected,
    status=case when v_accepted>0 then 'new' else 'done' end,
    receipt_stage=case when v_accepted>0 then 'verified' else 'rejected' end
  where id=v_batch_id;
  insert into public.receipt_audit_events(event_type,batch_id,actor_id,command_key,metadata)
  values('batch_created',v_batch_id,v_actor.id,p_command_key,
    jsonb_build_object('receipt_count',v_count,'accepted_count',v_accepted,'rejected_count',v_rejected,
      'customer_id',v_customer_id,'partner_id',v_partner_id,'source',left(coalesce(p_batch->>'source','app'),30)));
  insert into public.receipt_ingestion_commands(actor_id,command_key,batch_id) values(v_actor.id,p_command_key,v_batch_id);
  return jsonb_build_object('batch_id',v_batch_id,'receipt_count',v_count,'accepted_count',v_accepted,'rejected_count',v_rejected,'replayed',false);
end;
$$;

revoke all on function public.sarraf_ingest_receipt_batch(jsonb,jsonb,text) from public, anon;
grant execute on function public.sarraf_ingest_receipt_batch(jsonb,jsonb,text) to authenticated;

-- Customer portal receives totals and lifecycle only; individual receipt rows
-- and images remain server-side. Assigned partners retain custody detail access.
create or replace function public.sarraf_portal_receipt_summary(p_days integer default 365)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare v_actor public.app_users%rowtype; v_result jsonb; v_days int := greatest(1,least(coalesce(p_days,365),3650));
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role not in ('customer','partner') then raise exception using errcode='42501',message='portal receipt summary is not authorized'; end if;
  with visible as (
    select b.* from public.receipt_batches b
    where b.created_at >= statement_timestamp()-(v_days||' days')::interval
      and ((v_actor.role='customer' and b.customer_id=v_actor.id) or (v_actor.role='partner' and b.partner_id=v_actor.id))
  ), totals as (
    select currency,sum(total_gross) total_gross,sum(total_fee) total_fee,sum(total_net) total_net,
      sum(greatest(coalesce(n,0)-coalesce(rejected_n,0),0)) accepted_count,sum(coalesce(rejected_n,0)) rejected_count
    from visible group by currency order by sum(total_net) desc
  ), recent as (
    select id,currency,total_net,receipt_stage,created_at,n,rejected_n
    from visible order by created_at desc limit 50
  )
  select jsonb_build_object(
    'totals',coalesce((select jsonb_agg(to_jsonb(t)) from totals t),'[]'::jsonb),
    'batches',coalesce((select jsonb_agg(to_jsonb(r)) from recent r),'[]'::jsonb),
    'batch_count',(select count(*) from visible),
    'accepted_count',(select coalesce(sum(greatest(coalesce(n,0)-coalesce(rejected_n,0),0)),0) from visible),
    'rejected_count',(select coalesce(sum(coalesce(rejected_n,0)),0) from visible)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.sarraf_portal_receipt_summary(integer) from public, anon;
grant execute on function public.sarraf_portal_receipt_summary(integer) to authenticated;

-- Individual receipt records are no longer customer-readable. A partner may
-- read only receipts explicitly held in that partner's custody.
drop policy if exists receipts_portal_read_b on public.receipts;
drop policy if exists receipts_assurance_read on public.receipts;
create policy receipts_assurance_read on public.receipts for select to authenticated using (
  public.is_admin() or public.my_role()='office'
  or partner_id=public.my_app_id()
  or exists(select 1 from public.receipt_custody c where c.item_id=receipts.id and c.partner_id=public.my_app_id())
);
revoke insert, update, delete on public.receipts, public.receipt_batches from authenticated;
grant select on public.receipts, public.receipt_batches to authenticated;

-- Restrictive Storage policies compose with any existing permissive policy.
-- Uploaders can read/delete only fresh, uncommitted staging objects; committed
-- images are immutable and visible only to staff or the assigned custodian.
drop policy if exists receipt_storage_assurance_read on storage.objects;
create policy receipt_storage_assurance_read on storage.objects as restrictive for select to authenticated using (
  bucket_id <> 'receipts' or (
    (owner_id=auth.uid()::text and name like 'ingest/%' and created_at>statement_timestamp()-interval '30 minutes')
    or public.is_admin() or public.my_role()='office'
    or exists(select 1 from public.receipts r where r.image_path=name and (
      r.partner_id=public.my_app_id() or exists(select 1 from public.receipt_custody c where c.item_id=r.id and c.partner_id=public.my_app_id())
    ))
  )
);
drop policy if exists receipt_storage_assurance_delete on storage.objects;
create policy receipt_storage_assurance_delete on storage.objects as restrictive for delete to authenticated using (
  bucket_id <> 'receipts' or (
    owner_id=auth.uid()::text and name like 'ingest/%'
    and not exists(select 1 from public.receipt_intake_items i where i.image_path=name)
    and not exists(select 1 from public.receipts r where r.image_path=name)
  )
);
drop policy if exists receipt_storage_assurance_update on storage.objects;
create policy receipt_storage_assurance_update on storage.objects as restrictive for update to authenticated using (
  bucket_id <> 'receipts' or (
    owner_id=auth.uid()::text and name like 'ingest/%'
    and not exists(select 1 from public.receipt_intake_items i where i.image_path=name)
    and not exists(select 1 from public.receipts r where r.image_path=name)
  )
) with check (
  bucket_id <> 'receipts' or (
    owner_id=auth.uid()::text and name like 'ingest/%'
    and not exists(select 1 from public.receipt_intake_items i where i.image_path=name)
    and not exists(select 1 from public.receipts r where r.image_path=name)
  )
);

create or replace function public.sarraf_assign_receipt_custody(
  p_batch_id text,p_allocations jsonb,p_reason text,p_command_key text
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_actor public.app_users%rowtype; v_batch public.receipt_batches%rowtype; v_result jsonb; a jsonb;
  v_item public.receipt_intake_items%rowtype; v_previous text; v_partner text; v_count int:=0; v_batch_partner text;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' then raise exception using errcode='42501',message='receipt custody is not authorized'; end if;
  if p_command_key !~ '^receipt-custody:[A-Za-z0-9:_-]{16,220}$' or char_length(btrim(coalesce(p_reason,'')))<8 then
    raise exception using errcode='22023',message='invalid custody command';
  end if;
  if jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations)<1 or jsonb_array_length(p_allocations)>25 then
    raise exception using errcode='22023',message='invalid receipt allocations';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_result from public.receipt_operation_commands where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_result||jsonb_build_object('replayed',true); end if;
  select * into v_batch from public.receipt_batches where id=p_batch_id for update;
  if not found then raise exception using errcode='P0002',message='receipt batch not found'; end if;
  if v_batch.receipt_stage<>'verified' then raise exception using errcode='22023',message='receipt batch is not eligible for custody'; end if;

  for a in select value from jsonb_array_elements(p_allocations) loop
    select * into v_item from public.receipt_intake_items
    where id=a->>'receipt_id' and batch_id=p_batch_id and intake_status='accepted' and transaction_id is null for update;
    if not found then raise exception using errcode='22023',message='allocation contains an ineligible receipt'; end if;
    v_partner:=nullif(btrim(a->>'partner_id'),'');
    if v_partner is not null and not exists(select 1 from public.app_users where id=v_partner and role='partner' and not deleted) then
      raise exception using errcode='22023',message='allocation contains an invalid partner';
    end if;
    select partner_id into v_previous from public.receipt_custody where item_id=v_item.id;
    insert into public.receipt_custody(item_id,batch_id,partner_id,assigned_by,assignment_reason)
    values(v_item.id,p_batch_id,v_partner,v_actor.id,left(btrim(p_reason),700))
    on conflict(item_id) do update set partner_id=excluded.partner_id,assigned_by=excluded.assigned_by,
      assignment_reason=excluded.assignment_reason,version=receipt_custody.version+1,assigned_at=statement_timestamp();
    update public.receipt_intake_items set partner_id=v_partner where id=v_item.id;
    update public.receipts set partner_id=v_partner where id=v_item.id;
    insert into public.receipt_custody_events(item_id,batch_id,from_partner_id,to_partner_id,actor_id,reason,command_key)
    values(v_item.id,p_batch_id,v_previous,v_partner,v_actor.id,left(btrim(p_reason),700),p_command_key);
    insert into public.receipt_audit_events(event_type,batch_id,receipt_id,actor_id,command_key,metadata)
    values('manual_correction',p_batch_id,v_item.id,v_actor.id,p_command_key,
      jsonb_build_object('operation','custody','from_partner_id',v_previous,'to_partner_id',v_partner,'reason',left(btrim(p_reason),700)));
    v_count:=v_count+1;
  end loop;

  select case when count(*)>0 and count(*)=count(c.partner_id) and count(distinct c.partner_id)=1 then max(c.partner_id) else null end
  into v_batch_partner
  from public.receipt_intake_items i left join public.receipt_custody c on c.item_id=i.id
  where i.batch_id=p_batch_id and i.intake_status='accepted';
  update public.receipt_batches set partner_id=v_batch_partner where id=p_batch_id;
  v_result:=jsonb_build_object('batch_id',p_batch_id,'assigned_count',v_count,'batch_partner_id',v_batch_partner,'replayed',false);
  insert into public.receipt_operation_commands(actor_id,command_key,operation,batch_id,result)
  values(v_actor.id,p_command_key,'custody',p_batch_id,v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_assign_receipt_custody(text,jsonb,text,text) from public,anon;
grant execute on function public.sarraf_assign_receipt_custody(text,jsonb,text,text) to authenticated;

create or replace function public.sarraf_convert_receipt_batch_to_transaction(
  p_batch_id text,p_receipt_ids jsonb,p_tx jsonb,p_reason text,p_command_key text
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_actor public.app_users%rowtype; v_batch public.receipt_batches%rowtype; v_result jsonb; v_previous jsonb;
  v_total numeric; v_currency text; v_currency_id text; v_count int; v_currency_count int; v_partner_count int;
  v_expected_type text; v_cp text; v_partner text; v_remaining int; v_primary_tx text;
  v_tx jsonb; v_tx_id text; v_tx_command text; v_approval_id text;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' then raise exception using errcode='42501',message='receipt conversion is not authorized'; end if;
  if p_command_key !~ '^receipt-convert:[A-Za-z0-9:_-]{16,220}$' or char_length(btrim(coalesce(p_reason,'')))<8
    or jsonb_typeof(p_tx)<>'object' or jsonb_typeof(p_receipt_ids)<>'array'
    or jsonb_array_length(p_receipt_ids)<1 or jsonb_array_length(p_receipt_ids)>25 then
    raise exception using errcode='22023',message='invalid receipt conversion command';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_previous from public.receipt_operation_commands where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_previous||jsonb_build_object('replayed',true); end if;
  select * into v_batch from public.receipt_batches where id=p_batch_id for update;
  if not found then raise exception using errcode='P0002',message='receipt batch not found'; end if;
  if v_batch.receipt_stage<>'verified' then raise exception using errcode='22023',message='receipt batch is not verified for conversion'; end if;

  with requested as (select distinct jsonb_array_elements_text(p_receipt_ids) id)
  select count(*),sum(i.net_amount),min(i.currency),count(distinct i.currency),count(distinct i.partner_id),max(i.partner_id)
  into v_count,v_total,v_currency,v_currency_count,v_partner_count,v_partner
  from public.receipt_intake_items i join requested q on q.id=i.id
  where i.batch_id=p_batch_id and i.intake_status='accepted' and i.counted and i.transaction_id is null;
  if v_count<>jsonb_array_length(p_receipt_ids) or v_count<1 or v_total<=0 or v_currency_count<>1 or v_partner_count>1 then
    raise exception using errcode='22023',message='selected receipts are ineligible, reused, mixed-currency, or split across partners';
  end if;
  select id into v_currency_id from public.currencies where upper(code)=upper(v_currency) limit 1;
  if v_currency_id is null or p_tx->>'cur_id' is distinct from v_currency_id then raise exception using errcode='22023',message='transaction currency does not match accepted receipts'; end if;

  v_expected_type:=case when v_batch.direction in ('out','sell') then 'sell' else 'buy' end;
  if p_tx->>'type' is distinct from v_expected_type then raise exception using errcode='22023',message='transaction direction does not match receipts'; end if;
  v_cp:=nullif(btrim(p_tx->>'cp_id'),'');
  if v_batch.customer_id is not null then
    if v_cp is distinct from v_batch.customer_id then raise exception using errcode='22023',message='transaction customer does not match receipts'; end if;
  elsif v_cp is null or not exists(select 1 from public.app_users where id=v_cp and role='customer' and not deleted) then
    raise exception using errcode='22023',message='partner receipt conversion requires a valid customer';
  end if;
  if v_partner is null then v_partner:=v_batch.partner_id; end if;
  v_tx:=p_tx||jsonb_build_object('amount',v_total,'cur_id',v_currency_id,'cp_id',v_cp,'partner_id',v_partner,'edited',false,'deleted',false);
  v_tx_command:=format('tx:%s:%s',v_actor.id,md5(p_command_key));
  v_result:=public.sarraf_commit_transactions(
    jsonb_build_array(v_tx),'[]'::jsonb,p_batch_id,v_tx_command,
    case when v_expected_type='buy' then 'کڕین لە فیشە پەسەندکراوەکان' else 'فرۆشتن لە فیشە پەسەندکراوەکان' end,
    left(btrim(p_reason),700)
  );
  v_tx_id:=coalesce(v_result->'transactions'->0->>'id',v_result->'transaction'->>'id');
  if v_tx_id is not null then
    insert into public.receipt_batch_transactions(batch_id,transaction_id,partner_id,item_count,amount,currency,created_by)
    values(p_batch_id,v_tx_id,v_partner,v_count,v_total,v_currency,v_actor.id) on conflict do nothing;
    update public.receipt_intake_items set transaction_id=v_tx_id,converted_at=statement_timestamp()
    where batch_id=p_batch_id and id in (select jsonb_array_elements_text(p_receipt_ids)) and transaction_id is null;
    select count(*) into v_remaining from public.receipt_intake_items
      where batch_id=p_batch_id and intake_status='accepted' and counted and transaction_id is null;
    select transaction_id into v_primary_tx from public.receipt_batch_transactions where batch_id=p_batch_id order by created_at,transaction_id limit 1;
    update public.receipt_batches set
      tx_id=case when v_remaining=0 then v_primary_tx else null end,
      status=case when v_remaining=0 then 'done' else 'new' end,
      receipt_stage=case when v_remaining=0 then 'matched' else 'verified' end,
      decision_status=case when v_remaining=0 then 'accepted' else null end,
      decision_reason=case when v_remaining=0 then left(btrim(p_reason),700) else null end,
      decision_by=case when v_remaining=0 then v_actor.id else null end,
      decided_at=case when v_remaining=0 then statement_timestamp() else null end,
      matched_at=case when v_remaining=0 then statement_timestamp() else null end,
      matched_by=case when v_remaining=0 then v_actor.id else null end,
      match_reason=case when v_remaining=0 then left(btrim(p_reason),700) else null end
    where id=p_batch_id;
    insert into public.receipt_audit_events(event_type,batch_id,actor_id,command_key,metadata)
    values('matched',p_batch_id,v_actor.id,p_command_key,
      jsonb_build_object('operation','converted_to_transaction','tx_id',v_tx_id,'receipt_ids',p_receipt_ids,
        'accepted_count',v_count,'remaining_count',v_remaining,'total_net',v_total,'currency',v_currency,'reason',left(btrim(p_reason),700)));
  elsif coalesce((v_result->>'approval_required')::boolean,false) and nullif(v_result->>'approval_id','') is not null then
    v_approval_id:=v_result->>'approval_id';
    insert into public.receipt_pending_conversions(
      approval_id,batch_id,item_ids,partner_id,item_count,amount,currency,requested_by,command_key
    ) values(v_approval_id,p_batch_id,p_receipt_ids,v_partner,v_count,v_total,v_currency,v_actor.id,p_command_key)
    on conflict(approval_id) do nothing;
  end if;
  v_result:=coalesce(v_result,'{}'::jsonb)||jsonb_build_object('receipt_batch_id',p_batch_id,'receipt_ids',p_receipt_ids,
    'accepted_count',v_count,'accepted_total',v_total,'accepted_currency',v_currency);
  insert into public.receipt_operation_commands(actor_id,command_key,operation,batch_id,result)
  values(v_actor.id,p_command_key,'convert',p_batch_id,v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_convert_receipt_batch_to_transaction(text,jsonb,jsonb,text,text) from public,anon;
grant execute on function public.sarraf_convert_receipt_batch_to_transaction(text,jsonb,jsonb,text,text) to authenticated;

create or replace function public.sarraf_reconcile_receipt_conversions()
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_actor public.app_users%rowtype; p record; v_tx_id text; v_done int:=0; v_cancelled int:=0;
  v_remaining int; v_primary_tx text;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' then raise exception using errcode='42501',message='receipt conversion reconciliation is not authorized'; end if;
  for p in
    select pc.*,a.status approval_status,a.result approval_result
    from public.receipt_pending_conversions pc join public.approval_requests a on a.id=pc.approval_id
    where pc.status='pending' and a.status in ('executed','approved','rejected','cancelled','expired','failed')
    for update of pc
  loop
    if p.approval_status in ('rejected','cancelled','expired','failed') then
      update public.receipt_pending_conversions set status='cancelled',resolved_at=statement_timestamp() where approval_id=p.approval_id;
      v_cancelled:=v_cancelled+1;
      continue;
    end if;
    v_tx_id:=coalesce(
      p.approval_result->'transactions'->0->>'id',p.approval_result->'transaction'->>'id',
      p.approval_result->'result'->'transactions'->0->>'id',p.approval_result->'result'->'transaction'->>'id'
    );
    if v_tx_id is null or not exists(select 1 from public.txs where id=v_tx_id and not deleted) then continue; end if;
    insert into public.receipt_batch_transactions(batch_id,transaction_id,partner_id,item_count,amount,currency,created_by)
    values(p.batch_id,v_tx_id,p.partner_id,p.item_count,p.amount,p.currency,p.requested_by) on conflict do nothing;
    update public.receipt_intake_items set transaction_id=v_tx_id,converted_at=statement_timestamp()
    where batch_id=p.batch_id and id in (select jsonb_array_elements_text(p.item_ids)) and transaction_id is null;
    update public.receipt_pending_conversions set status='completed',resolved_at=statement_timestamp() where approval_id=p.approval_id;
    select count(*) into v_remaining from public.receipt_intake_items
      where batch_id=p.batch_id and intake_status='accepted' and counted and transaction_id is null;
    select transaction_id into v_primary_tx from public.receipt_batch_transactions where batch_id=p.batch_id order by created_at,transaction_id limit 1;
    update public.receipt_batches set
      tx_id=case when v_remaining=0 then v_primary_tx else null end,
      status=case when v_remaining=0 then 'done' else 'new' end,
      receipt_stage=case when v_remaining=0 then 'matched' else 'verified' end,
      decision_status=case when v_remaining=0 then 'accepted' else null end,
      decision_reason=case when v_remaining=0 then 'پەسەندکردنی دوو قۆناغیی گۆڕینی فیش بۆ مامەڵە' else null end,
      decision_by=case when v_remaining=0 then p.requested_by else null end,
      decided_at=case when v_remaining=0 then statement_timestamp() else null end,
      matched_at=case when v_remaining=0 then statement_timestamp() else null end,
      matched_by=case when v_remaining=0 then p.requested_by else null end,
      match_reason=case when v_remaining=0 then 'پەسەندکردنی دوو قۆناغیی گۆڕینی فیش بۆ مامەڵە' else null end
    where id=p.batch_id;
    insert into public.receipt_audit_events(event_type,batch_id,actor_id,command_key,metadata)
    values('matched',p.batch_id,p.requested_by,p.command_key,
      jsonb_build_object('operation','approved_receipt_conversion','approval_id',p.approval_id,'tx_id',v_tx_id,
        'receipt_ids',p.item_ids,'remaining_count',v_remaining,'total_net',p.amount,'currency',p.currency));
    v_done:=v_done+1;
  end loop;
  return jsonb_build_object('completed',v_done,'cancelled',v_cancelled);
end;
$$;
revoke all on function public.sarraf_reconcile_receipt_conversions() from public,anon;
grant execute on function public.sarraf_reconcile_receipt_conversions() to authenticated;

-- Append-only, database-generated activity trail and immediate admin notes.
create or replace function public.capture_financial_event()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_actor text; v_before jsonb; v_after jsonb; v_row jsonb; v_ref text; v_title text; v_link text;
begin
  select id into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if tg_op='DELETE' then v_before:=to_jsonb(old); v_after:=null; v_row:=v_before;
  elsif tg_op='UPDATE' then v_before:=to_jsonb(old); v_after:=to_jsonb(new); v_row:=v_after;
  else v_before:=null; v_after:=to_jsonb(new); v_row:=v_after; end if;
  -- OCR payloads can contain sensitive bank data and are already retained in the
  -- access-controlled intake table.  Keep the audit trail useful without making
  -- a second, indefinitely growing copy of that evidence.
  if tg_table_name in ('receipts','receipt_intake_items') then
    v_before:=v_before - 'raw';
    v_after:=v_after - 'raw';
    v_row:=coalesce(v_after,v_before);
  end if;
  v_ref:=coalesce(v_row->>'id',v_row->>'batch_id',v_row->>'tx_id');
  insert into public.system_event_log(entity_table,entity_id,action,actor_id,before_data,after_data)
  values(tg_table_name,v_ref,tg_op,v_actor,v_before,v_after);
  v_title:=case tg_table_name
    when 'txs' then 'گۆڕانکاری لە مامەڵە'
    when 'ledger' then 'جوڵەی نوێی دەفتەر'
    when 'account_ledger' then 'جوڵەی نوێی حیساب'
    when 'account_transfers' then 'گواستنەوەی حیساب'
    when 'day_closes' then 'بەستنی ڕۆژ'
    when 'receipts' then 'گۆڕانکاری لە فیش'
    when 'receipt_intake_items' then 'دۆخی نوێی فیش'
    when 'receipt_batches' then 'گۆڕانکاری لە کۆمەڵە فیش'
    when 'receipt_custody' then 'گواستنەوەی فیش بۆ هاوبەش'
    when 'receipt_batch_transactions' then 'گۆڕینی فیش بۆ مامەڵە'
    when 'receipt_pending_conversions' then 'چاوەڕوانی پەسەندکردنی گۆڕینی فیش'
    when 'app_users' then 'گۆڕانکاری لە بەکارهێنەر'
    when 'currencies' then 'گۆڕانکاری لە دراو و نرخ'
    else 'جوڵەی نوێ لە سیستەم' end;
  v_link:=case when tg_table_name in ('receipts','receipt_batches') then 'receipts' when tg_table_name='txs' then 'txs' else 'admin-center' end;
  insert into public.notes(id,user_id,kind,title,body,link,ref_id)
  values(gen_random_uuid()::text,null,'system_event',v_title,
    concat(tg_op,' · ',tg_table_name,case when v_ref is not null then ' · '||v_ref else '' end),v_link,v_ref);
  perform pg_notify('zeman_admin_events',jsonb_build_object('table',tg_table_name,'action',tg_op,'ref_id',v_ref)::text);
  return case when tg_op='DELETE' then old else new end;
end;
$$;

do $$
declare v_table text; v_trigger text;
begin
  foreach v_table in array array['txs','ledger','account_ledger','account_transfers','day_closes','receipts','receipt_intake_items','receipt_batches','receipt_custody','receipt_batch_transactions','receipt_pending_conversions','app_users','currencies'] loop
    if to_regclass('public.'||v_table) is not null then
      v_trigger:='zeman_event_'||v_table;
      execute format('drop trigger if exists %I on public.%I',v_trigger,v_table);
      execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.capture_financial_event()',v_trigger,v_table);
    end if;
  end loop;
end;
$$;

create or replace function public.prevent_system_event_mutation()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception using errcode='42501',message='system event log is append-only'; end;
$$;
drop trigger if exists system_event_immutable on public.system_event_log;
create trigger system_event_immutable before update or delete on public.system_event_log
for each row execute function public.prevent_system_event_mutation();

-- Bring old, fully valid unprocessed batches into the explicit verified state.
update public.receipt_batches b set receipt_stage='verified'
where b.receipt_stage in ('received','reading','needs_review') and b.tx_id is null
  and exists(select 1 from public.receipt_intake_items i where i.batch_id=b.id and i.intake_status='accepted')
  and not exists(select 1 from public.receipt_intake_items i where i.batch_id=b.id and i.intake_status not in ('accepted','rejected'));

commit;
