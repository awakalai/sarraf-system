-- Canonical receipt lifecycle and authority boundary.
--
-- This migration removes the browser from every receipt verdict.  The transaction assignment
-- decides the flow, customer, partner and expected currency.  A service-role worker records OCR
-- from the stored original, and authenticated users can change state only through bounded,
-- idempotent commands.  Existing evidence is retained and legacy tables are not dropped.
begin;

-- ── Transaction assignment: the only source of receipt business context ───────────────
create table if not exists public.receipt_transaction_assignments (
  transaction_id text primary key references public.txs(id) on delete restrict,
  flow public.receipt_flow not null,
  customer_id text not null references public.app_users(id),
  partner_id text references public.app_users(id),
  office_id text references public.app_users(id),
  expected_currency text not null,
  assigned_by text references public.app_users(id),
  assignment_reason text,
  version bigint not null default 1,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  check (expected_currency ~ '^[A-Z]{3,8}$'),
  check (flow <> 'customer_buys_from_zeman' or partner_id is not null),
  check (assignment_reason is null or char_length(assignment_reason) between 8 and 700)
);
create index if not exists rta_customer_idx
  on public.receipt_transaction_assignments(customer_id, created_at desc);
create index if not exists rta_partner_idx
  on public.receipt_transaction_assignments(partner_id, created_at desc)
  where partner_id is not null;
create index if not exists rta_office_idx
  on public.receipt_transaction_assignments(office_id, created_at desc)
  where office_id is not null;

create table if not exists public.receipt_assignment_events (
  id bigint generated always as identity primary key,
  transaction_id text not null references public.txs(id) on delete restrict,
  from_assignment jsonb,
  to_assignment jsonb not null,
  reason text not null,
  actor_id text not null references public.app_users(id),
  command_key text not null,
  created_at timestamptz not null default statement_timestamp(),
  unique (actor_id, command_key),
  check (jsonb_typeof(to_assignment) = 'object'),
  check (char_length(reason) between 8 and 700)
);

-- Backfill only contexts that can be derived without guessing.  A customer-buy assignment with
-- no partner is deliberately left out: accepting a made-up partner would be worse than showing
-- the transaction in the admin's assignment queue.
insert into public.receipt_transaction_assignments(
  transaction_id, flow, customer_id, partner_id, expected_currency, assignment_reason)
select t.id,
       case when t.type = 'buy'
            then 'customer_sells_to_zeman'::public.receipt_flow
            else 'customer_buys_from_zeman'::public.receipt_flow end,
       t.cp_id, t.partner_id, upper(c.code),
       'Backfilled from the immutable transaction context'
from public.txs t
join public.currencies c on c.id = t.cur_id
where not coalesce(t.deleted, false)
  and t.type in ('buy','sell')
  and t.cp_id is not null
  and (t.type = 'buy' or t.partner_id is not null)
on conflict (transaction_id) do nothing;

-- ── Provenance, rate snapshot and idempotent command records ───────────────────────────
alter table public.receipt_documents add column if not exists intake_command_key text;
alter table public.receipt_documents add column if not exists submitted_at timestamptz;
alter table public.receipt_documents add column if not exists accepted_at timestamptz;
alter table public.receipt_documents add column if not exists finalized_at timestamptz;
alter table public.receipt_documents add column if not exists rate_value numeric(38,10);
alter table public.receipt_documents add column if not exists rate_convention text;
alter table public.receipt_documents add column if not exists rate_date date;
alter table public.receipt_documents add column if not exists rate_version bigint;
alter table public.receipt_documents add column if not exists rate_kind text;
alter table public.receipt_documents add column if not exists rate_set_by text references public.app_users(id);
alter table public.receipt_documents add column if not exists rate_captured_at timestamptz;
alter table public.receipt_documents add column if not exists summary_version bigint not null default 1;
alter table public.receipt_documents add column if not exists receipt_set_version bigint not null default 1;
alter table public.receipt_documents add column if not exists server_attested_at timestamptz;
alter table public.receipt_documents add column if not exists last_request_id text;

alter table public.receipt_documents drop constraint if exists receipt_documents_rate_snapshot_ck;
alter table public.receipt_documents add constraint receipt_documents_rate_snapshot_ck check (
  (rate_value is null and rate_convention is null and rate_date is null and rate_version is null)
  or
  (rate_value > 0 and rate_convention = '1_USD_EQUALS_X_CURRENCY'
   and rate_date is not null and rate_version is not null and rate_captured_at is not null)
) not valid;

alter table public.receipt_extractions add column if not exists image_sha256 text;
alter table public.receipt_extractions add column if not exists request_id text;
alter table public.receipt_extractions add column if not exists server_recorded boolean not null default false;
alter table public.receipt_extractions add column if not exists field_confidence jsonb not null default '{}'::jsonb;
alter table public.receipt_extractions add column if not exists attestation_version integer;
alter table public.receipt_extractions add column if not exists platform text;
alter table public.receipt_extractions add column if not exists platform_evidence text;
alter table public.receipt_extractions add column if not exists has_fee boolean;
alter table public.receipt_extractions add column if not exists transaction_status text;
create index if not exists re_ref_normalized_idx on public.receipt_extractions(
  (upper(regexp_replace(ref_no,'[^[:alnum:]]','','g')))) where ref_no is not null;
create index if not exists re_merchant_ref_normalized_idx on public.receipt_extractions(
  (upper(regexp_replace(merchant_order_no,'[^[:alnum:]]','','g')))) where merchant_order_no is not null;

create table if not exists public.receipt_command_log (
  actor_id text not null references public.app_users(id),
  command_key text not null,
  operation text not null,
  result jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (actor_id, command_key),
  check (char_length(command_key) between 12 and 180),
  check (jsonb_typeof(result) = 'object')
);

create table if not exists public.receipt_ocr_attempts (
  id bigint generated always as identity primary key,
  document_id text not null references public.receipt_documents(id) on delete restrict,
  attempt_no integer not null,
  provider text,
  model text,
  status text not null check (status in ('succeeded','retryable_failure','terminal_failure')),
  latency_ms integer,
  error_code text,
  image_sha256 text not null,
  request_id text not null,
  created_at timestamptz not null default statement_timestamp(),
  unique (document_id, attempt_no),
  unique (request_id),
  check (image_sha256 ~ '^[a-f0-9]{64}$'),
  check (latency_ms is null or latency_ms between 0 and 300000)
);

create table if not exists public.receipt_daily_rates (
  id text primary key,
  currency text not null,
  effective_date date not null,
  rate_value numeric(38,10) not null,
  convention text not null default '1_USD_EQUALS_X_CURRENCY',
  reference_kind text not null default 'manual_receipt_rate',
  version bigint not null,
  set_by text not null references public.app_users(id),
  reason text not null,
  created_at timestamptz not null default statement_timestamp(),
  unique (currency, effective_date, version),
  check (currency ~ '^[A-Z]{3,8}$'),
  check (rate_value > 0),
  check (convention = '1_USD_EQUALS_X_CURRENCY'),
  check (reference_kind = 'manual_receipt_rate'),
  check (char_length(reason) between 8 and 700)
);
create index if not exists rdr_lookup_idx
  on public.receipt_daily_rates(currency, effective_date desc, version desc);

create table if not exists public.receipt_notifications (
  id text primary key,
  forwarding_id text not null references public.receipt_forwardings(id) on delete restrict,
  document_id text not null references public.receipt_documents(id) on delete restrict,
  recipient_id text not null references public.app_users(id),
  status text not null default 'delivered' check (status in ('delivered','seen')),
  delivered_at timestamptz not null default statement_timestamp(),
  seen_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  unique (forwarding_id, recipient_id)
);

-- ── Immutable audit surfaces ───────────────────────────────────────────────────────────
create or replace function public.protect_receipt_append_only()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception using errcode='42501', message='receipt audit records are append-only';
end;
$$;

drop trigger if exists receipt_assignment_events_immutable on public.receipt_assignment_events;
create trigger receipt_assignment_events_immutable before update or delete on public.receipt_assignment_events
  for each row execute function public.protect_receipt_append_only();
drop trigger if exists receipt_command_log_immutable on public.receipt_command_log;
create trigger receipt_command_log_immutable before update or delete on public.receipt_command_log
  for each row execute function public.protect_receipt_append_only();
drop trigger if exists receipt_ocr_attempts_immutable on public.receipt_ocr_attempts;
create trigger receipt_ocr_attempts_immutable before update or delete on public.receipt_ocr_attempts
  for each row execute function public.protect_receipt_append_only();
drop trigger if exists receipt_daily_rates_immutable on public.receipt_daily_rates;
create trigger receipt_daily_rates_immutable before update or delete on public.receipt_daily_rates
  for each row execute function public.protect_receipt_append_only();
drop trigger if exists receipt_custody_ledger_immutable on public.receipt_custody_ledger;
create trigger receipt_custody_ledger_immutable before update or delete on public.receipt_custody_ledger
  for each row execute function public.protect_receipt_append_only();

-- Trigger transitions inherit the command context set by the SECURITY DEFINER command.  This
-- fixes anonymous transition rows when the service-role OCR worker advances a document.
create or replace function public.log_receipt_transition()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare
  v_actor text := nullif(current_setting('app.receipt_actor_id', true), '');
  v_reason text := nullif(current_setting('app.receipt_reason', true), '');
  v_command text := nullif(current_setting('app.receipt_command_key', true), '');
  v_request text := nullif(current_setting('app.receipt_request_id', true), '');
begin
  if v_actor is null then v_actor := public.my_app_id(); end if;
  if tg_op = 'INSERT' then
    insert into public.receipt_state_transitions(
      document_id, from_state, to_state, actor_id, reason, command_key, request_id)
    values (new.id, null, new.state, coalesce(v_actor,new.uploader_id), v_reason, v_command, v_request);
  elsif new.state is distinct from old.state then
    insert into public.receipt_state_transitions(
      document_id, from_state, to_state, actor_id, reason, command_key, request_id)
    values (new.id, old.state, new.state, v_actor, v_reason, v_command, v_request);
  end if;
  return null;
end;
$$;

create or replace function public.receipt_request_aal()
returns text language sql stable set search_path = pg_catalog as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.aal', true), ''),
    case when nullif(current_setting('request.jwt.claims', true), '') is not null
         then (current_setting('request.jwt.claims', true)::jsonb ->> 'aal') end,
    'aal1');
$$;

create or replace function public.receipt_json_numeric(p_value jsonb, p_key text)
returns numeric language plpgsql immutable set search_path = pg_catalog as $$
declare v text;
begin
  v := nullif(btrim(p_value->>p_key), '');
  if v is null then return null; end if;
  if v !~ '^-?[0-9]+([.][0-9]{1,10})?$' then return null; end if;
  return v::numeric;
end;
$$;

-- A server-side duplicate verdict may be reached after submit/match when a normalized reference
-- collides during the administrator's acceptance command.  All other legacy transitions remain
-- unchanged; finalized evidence can never move back into review.
create or replace function public.receipt_transition_allowed(
  p_from public.receipt_state, p_to public.receipt_state
) returns boolean language sql immutable set search_path = pg_catalog as $$
  select case
    when p_from in ('seen','failed_terminal','cancelled') then false
    when p_from is null then p_to='created'
    when p_from='created' then p_to in ('uploading','cancelled')
    when p_from='uploading' then p_to in ('uploaded','upload_failed_retryable','cancelled')
    when p_from='upload_failed_retryable' then p_to in ('uploading','failed_terminal','cancelled')
    when p_from='uploaded' then p_to in ('ocr_pending','needs_manual_review','cancelled')
    when p_from='ocr_pending' then p_to in ('ocr_processing','ocr_failed_retryable','needs_manual_review')
    when p_from='ocr_processing' then p_to in
      ('parsed','ocr_failed_retryable','needs_manual_review','duplicate','currency_mismatch','tamper_suspected')
    when p_from='ocr_failed_retryable' then p_to in ('ocr_pending','needs_manual_review','failed_terminal')
    when p_from='parsed' then p_to in
      ('validated','needs_manual_review','duplicate','currency_mismatch','tamper_suspected')
    when p_from='needs_manual_review' then p_to in
      ('validated','rejected','duplicate','currency_mismatch','tamper_suspected')
    when p_from in ('duplicate','currency_mismatch','tamper_suspected') then p_to in ('needs_manual_review','rejected')
    when p_from='validated' then p_to in
      ('submitted','needs_manual_review','rejected','duplicate','currency_mismatch','tamper_suspected')
    when p_from='submitted' then p_to in
      ('matched','accepted','rejected','needs_manual_review','duplicate','currency_mismatch','tamper_suspected')
    when p_from='matched' then p_to in ('accepted','rejected','duplicate','currency_mismatch','tamper_suspected')
    when p_from='accepted' then p_to in ('finalized','rejected')
    when p_from='finalized' then p_to='forwarded'
    when p_from='forwarded' then p_to in ('delivered','seen')
    when p_from='delivered' then p_to='seen'
    when p_from='rejected' then p_to='needs_manual_review'
    else false
  end;
$$;

-- ── Admin assignment command ──────────────────────────────────────────────────────────
create or replace function public.sarraf_set_receipt_assignment(
  p_transaction_id text, p_partner_id text, p_office_id text,
  p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor public.app_users%rowtype; v_tx public.txs%rowtype; v_cur text;
  v_flow public.receipt_flow; v_before jsonb; v_result jsonb; v_version bigint;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='only an administrator may assign receipt work';
  end if;
  if public.receipt_request_aal() <> 'aal2' then
    raise exception using errcode='42501', message='multi-factor authentication is required';
  end if;
  if char_length(btrim(coalesce(p_reason,''))) < 8 then
    raise exception using errcode='22023', message='an 8-character reason is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_result from public.receipt_command_log
   where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_result || jsonb_build_object('replayed',true); end if;

  select * into v_tx from public.txs where id=p_transaction_id and not coalesce(deleted,false) for update;
  if not found or v_tx.cp_id is null or v_tx.type not in ('buy','sell') then
    raise exception using errcode='22023', message='transaction has no assignable receipt context';
  end if;
  select upper(code) into v_cur from public.currencies where id=v_tx.cur_id;
  if v_cur is null then raise exception using errcode='22023', message='transaction currency is invalid'; end if;
  v_flow := case when v_tx.type='buy' then 'customer_sells_to_zeman'::public.receipt_flow
                 else 'customer_buys_from_zeman'::public.receipt_flow end;
  if v_flow='customer_buys_from_zeman' and not exists(
    select 1 from public.app_users where id=p_partner_id and role='partner' and not deleted) then
    raise exception using errcode='22023', message='an active assigned partner is required';
  end if;
  if p_office_id is not null and not exists(
    select 1 from public.app_users where id=p_office_id and role='office' and not deleted) then
    raise exception using errcode='22023', message='the selected office is invalid';
  end if;

  select to_jsonb(a), a.version into v_before, v_version
    from public.receipt_transaction_assignments a where transaction_id=p_transaction_id for update;
  v_version := coalesce(v_version,0)+1;
  insert into public.receipt_transaction_assignments(
    transaction_id,flow,customer_id,partner_id,office_id,expected_currency,
    assigned_by,assignment_reason,version)
  values (p_transaction_id,v_flow,v_tx.cp_id,nullif(p_partner_id,''),nullif(p_office_id,''),v_cur,
          v_actor.id,left(btrim(p_reason),700),v_version)
  on conflict (transaction_id) do update set
    flow=excluded.flow, customer_id=excluded.customer_id, partner_id=excluded.partner_id,
    office_id=excluded.office_id, expected_currency=excluded.expected_currency,
    assigned_by=excluded.assigned_by, assignment_reason=excluded.assignment_reason,
    version=excluded.version, updated_at=statement_timestamp();

  v_result := jsonb_build_object(
    'transaction_id',p_transaction_id,'flow',v_flow,'customer_id',v_tx.cp_id,
    'partner_id',nullif(p_partner_id,''),'office_id',nullif(p_office_id,''),
    'expected_currency',v_cur,'version',v_version,'replayed',false);
  insert into public.receipt_assignment_events(
    transaction_id,from_assignment,to_assignment,reason,actor_id,command_key)
  values (p_transaction_id,v_before,v_result,left(btrim(p_reason),700),v_actor.id,p_command_key);
  insert into public.receipt_command_log(actor_id,command_key,operation,result)
  values (v_actor.id,p_command_key,'set_receipt_assignment',v_result);
  return v_result;
end;
$$;

-- ── Intake: the browser supplies identity and bytes, never business context or OCR ─────
create or replace function public.sarraf_receipt_intake_begin_v2(
  p_document_id text, p_transaction_id text, p_batch_id text, p_mime_type text,
  p_command_key text, p_override_reason text default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor public.app_users%rowtype; v_a public.receipt_transaction_assignments%rowtype;
  v_existing public.receipt_documents%rowtype; v_path text; v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found then raise exception using errcode='42501', message='not authorized'; end if;
  if p_document_id !~ '^[A-Za-z0-9-]{6,128}$'
     or coalesce(p_transaction_id,'') !~ '^[A-Za-z0-9._:-]{1,140}$'
     or (p_batch_id is not null and p_batch_id !~ '^[A-Za-z0-9._:-]{1,140}$')
     or coalesce(p_command_key,'') !~ '^receipt-intake:[A-Za-z0-9._:-]{8,150}$' then
    raise exception using errcode='22023', message='invalid receipt identity';
  end if;
  if coalesce(p_mime_type,'') !~ '^image/(jpeg|png|webp|heic|heif)$' then
    raise exception using errcode='22023', message='unsupported image type';
  end if;
  select * into v_a from public.receipt_transaction_assignments
   where transaction_id=p_transaction_id;
  if not found then
    raise exception using errcode='42501', message='the transaction has no receipt assignment';
  end if;

  if v_actor.role='customer' then
    if v_a.flow <> 'customer_sells_to_zeman' or v_a.customer_id <> v_actor.id then
      raise exception using errcode='42501', message='customers may upload only their own sale receipt';
    end if;
  elsif v_actor.role='partner' then
    if v_a.flow <> 'customer_buys_from_zeman' or v_a.partner_id <> v_actor.id then
      raise exception using errcode='42501', message='only the assigned partner may upload this receipt';
    end if;
  elsif v_actor.role='admin' then
    if public.receipt_request_aal() <> 'aal2' then
      raise exception using errcode='42501', message='multi-factor authentication is required';
    end if;
    if char_length(btrim(coalesce(p_override_reason,''))) < 8 then
      raise exception using errcode='22023', message='an admin override requires a reason';
    end if;
  else
    raise exception using errcode='42501', message='this role cannot upload receipts';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select * into v_existing from public.receipt_documents where id=p_document_id;
  if found then
    if v_existing.uploader_id<>v_actor.id or v_existing.transaction_id is distinct from p_transaction_id
       or v_existing.intake_command_key is distinct from p_command_key then
      raise exception using errcode='42501', message='receipt identity belongs to another context';
    end if;
    return jsonb_build_object('document_id',v_existing.id,'storage_path',v_existing.storage_path,
      'state',v_existing.state,'transaction_id',v_existing.transaction_id,'flow',v_existing.flow,
      'expected_currency',v_existing.expected_currency,'replayed',true);
  end if;

  v_path := format('ingest/%s/%s.%s',coalesce(nullif(p_batch_id,''),p_transaction_id),p_document_id,
    case p_mime_type when 'image/jpeg' then 'jpg' when 'image/png' then 'png'
      when 'image/webp' then 'webp' when 'image/heic' then 'heic' else 'heif' end);
  perform set_config('app.receipt_actor_id',v_actor.id,true);
  perform set_config('app.receipt_reason',coalesce(p_override_reason,'Receipt intake claimed by assigned uploader'),true);
  perform set_config('app.receipt_command_key',p_command_key,true);
  insert into public.receipt_documents(
    id,flow,state,batch_id,transaction_id,uploader_id,customer_id,partner_id,
    storage_path,expected_currency,mime_type,intake_command_key)
  values (p_document_id,v_a.flow,'created',nullif(p_batch_id,''),p_transaction_id,v_actor.id,
          v_a.customer_id,v_a.partner_id,v_path,v_a.expected_currency,p_mime_type,p_command_key);
  update public.receipt_documents set state='uploading' where id=p_document_id;
  -- Purchase evidence begins in the assigned partner's custody. Publishing it later grants the
  -- customer a read/delivery record; it does not pretend that custody moved to the customer.
  if v_a.flow='customer_buys_from_zeman' then
    insert into public.receipt_custody_ledger(
      document_id,from_partner_id,to_partner_id,transaction_id,reason,actor_id,command_key)
    values(p_document_id,null,v_a.partner_id,p_transaction_id,
      'Assigned partner supplied original payment evidence',v_actor.id,p_command_key);
  end if;
  v_result := jsonb_build_object('document_id',p_document_id,'storage_path',v_path,
    'state','uploading','transaction_id',p_transaction_id,'flow',v_a.flow,
    'expected_currency',v_a.expected_currency,'replayed',false);
  insert into public.receipt_command_log(actor_id,command_key,operation,result)
  values (v_actor.id,p_command_key,'receipt_intake_begin',v_result);
  return v_result;
end;
$$;

-- Only the service-role worker may attest bytes and write the original extraction.  Granting this
-- to authenticated would restore the exact client-forged OCR vulnerability this migration fixes.
create or replace function public.sarraf_receipt_record_server_extraction(
  p_document_id text, p_image_sha256 text, p_byte_size bigint, p_mime_type text,
  p_ok boolean, p_extraction jsonb, p_provider text, p_model text,
  p_latency_ms integer, p_request_id text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_doc public.receipt_documents%rowtype; v_attempt integer; v_currency text;
  v_conf numeric; v_next public.receipt_state; v_duplicate text; v_fee_treatment text;
begin
  if p_image_sha256 !~ '^[a-f0-9]{64}$' or p_byte_size is null
     or p_byte_size<1 or p_byte_size>20971520
     or p_mime_type !~ '^image/(jpeg|png|webp|heic|heif)$'
     or char_length(coalesce(p_request_id,''))<8 then
    raise exception using errcode='22023', message='invalid stored receipt attestation';
  end if;
  select * into v_doc from public.receipt_documents where id=p_document_id for update;
  if not found then raise exception using errcode='P0002', message='receipt intake not found'; end if;
  if exists(select 1 from public.receipt_extractions where document_id=p_document_id and is_original) then
    return jsonb_build_object('document_id',p_document_id,'state',v_doc.state,'replayed',true);
  end if;
  if v_doc.state not in ('uploading','upload_failed_retryable','uploaded','ocr_pending','ocr_failed_retryable') then
    raise exception using errcode='23514', message='receipt is not waiting for server OCR';
  end if;
  if v_doc.image_sha256 is not null and v_doc.image_sha256<>p_image_sha256 then
    raise exception using errcode='42501', message='stored receipt bytes changed after attestation';
  end if;
  perform set_config('app.receipt_request_id',p_request_id,true);
  perform set_config('app.receipt_command_key','server-ocr:'||p_request_id,true);
  perform set_config('app.receipt_reason','Server verified the stored original and recorded OCR',true);

  if v_doc.state='upload_failed_retryable' then
    update public.receipt_documents set state='uploading' where id=p_document_id;
  end if;
  if (select state from public.receipt_documents where id=p_document_id)='uploading' then
    update public.receipt_documents set image_sha256=p_image_sha256,byte_size=p_byte_size,
      mime_type=p_mime_type,server_attested_at=statement_timestamp(),last_request_id=p_request_id,
      state='uploaded' where id=p_document_id;
  end if;
  if (select state from public.receipt_documents where id=p_document_id)='uploaded' then
    update public.receipt_documents set state='ocr_pending' where id=p_document_id;
  end if;
  if (select state from public.receipt_documents where id=p_document_id)='ocr_failed_retryable' then
    update public.receipt_documents set state='ocr_pending' where id=p_document_id;
  end if;
  update public.receipt_documents set state='ocr_processing',ocr_attempts=ocr_attempts+1,
    last_attempt_at=statement_timestamp(),last_request_id=p_request_id where id=p_document_id;
  select ocr_attempts into v_attempt from public.receipt_documents where id=p_document_id;

  if not coalesce(p_ok,false) then
    insert into public.receipt_ocr_attempts(
      document_id,attempt_no,provider,model,status,latency_ms,error_code,image_sha256,request_id)
    values (p_document_id,v_attempt,left(p_provider,60),left(p_model,80),'retryable_failure',
      p_latency_ms,left(coalesce(p_extraction->>'error','ocr_failed'),80),p_image_sha256,p_request_id);
    update public.receipt_documents set state='ocr_failed_retryable',
      last_error_code=left(coalesce(p_extraction->>'error','ocr_failed'),80) where id=p_document_id;
    return jsonb_build_object('document_id',p_document_id,'state','ocr_failed_retryable','replayed',false);
  end if;

  v_currency := nullif(upper(regexp_replace(coalesce(p_extraction->>'currency',''),'[^A-Z]','','g')),'');
  v_conf := public.receipt_json_numeric(p_extraction,'confidence');
  v_fee_treatment := case when p_extraction->>'feeTreatment' in
    ('added_on_top','deducted_from_principal','included_in_total','no_fee','unknown')
    then p_extraction->>'feeTreatment' else 'unknown' end;
  insert into public.receipt_extractions(
    document_id,version,is_original,provider,model,ocr_version,raw,
    gross_amount,order_amount,fee_amount,fee_treatment,net_amount,currency,
    ref_no,merchant_order_no,payee,tx_date,tx_time,confidence,field_confidence,
    platform,platform_evidence,has_fee,transaction_status,
    image_sha256,request_id,server_recorded,attestation_version)
  values (p_document_id,1,true,left(p_provider,60),left(p_model,80),
    left(coalesce(p_extraction->>'ocrVersion','server-v1'),40),coalesce(p_extraction,'{}'::jsonb),
    abs(public.receipt_json_numeric(p_extraction,'grossAmount')),
    abs(public.receipt_json_numeric(p_extraction,'orderAmount')),
    abs(public.receipt_json_numeric(p_extraction,'feeAmount')),v_fee_treatment,
    abs(public.receipt_json_numeric(p_extraction,'netAmount')),v_currency,
    left(nullif(p_extraction->>'refNo',''),160),left(nullif(p_extraction->>'merchantOrderNo',''),160),
    left(nullif(p_extraction->>'payee',''),160),
    case when p_extraction->>'txDate' ~ '^\d{4}-\d{2}-\d{2}$' then (p_extraction->>'txDate')::date end,
    case when p_extraction->>'txTime' ~ '^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$' then (p_extraction->>'txTime')::time end,
    v_conf,case when jsonb_typeof(p_extraction->'fieldConfidence')='object'
                then p_extraction->'fieldConfidence' else '{}'::jsonb end,
    case
      when coalesce(p_extraction->>'platform','') ~* '(wechat|weixin|微信)' then 'wechat'
      when coalesce(p_extraction->>'platform','') ~* '(alipay|ali[ -]?pay|支付宝)' then 'alipay'
      when nullif(btrim(coalesce(p_extraction->>'platform','')),'') is null then 'unknown'
      else 'other' end,
    left(nullif(p_extraction->>'platformEvidence',''),300),
    case
      when coalesce(public.receipt_json_numeric(p_extraction,'feeAmount'),0)>0 then true
      when v_fee_treatment='no_fee' then false
      when v_fee_treatment in ('added_on_top','deducted_from_principal','included_in_total') then true
      else null end,
    left(nullif(p_extraction->>'transactionStatus',''),80),
    p_image_sha256,p_request_id,true,1);
  insert into public.receipt_ocr_attempts(
    document_id,attempt_no,provider,model,status,latency_ms,image_sha256,request_id)
  values (p_document_id,v_attempt,left(p_provider,60),left(p_model,80),'succeeded',
          p_latency_ms,p_image_sha256,p_request_id);
  update public.receipt_documents set state='parsed',last_error_code=null where id=p_document_id;

  select id into v_duplicate from public.receipt_documents
   where id<>p_document_id and image_sha256=p_image_sha256
     and state in ('accepted','finalized','forwarded','delivered','seen')
   order by received_at limit 1;
  if v_duplicate is not null then
    update public.receipt_documents set state='duplicate',counted=false,
      rule_code='exact_image_duplicate',rule_reason='Exact image already belongs to receipt '||v_duplicate
      where id=p_document_id;
    return jsonb_build_object('document_id',p_document_id,'state','duplicate','duplicate_of',v_duplicate);
  end if;
  if v_currency is null then
    v_next:='needs_manual_review';
    update public.receipt_documents set rule_code='currency_unconfirmed',
      rule_reason='OCR did not provide reliable currency evidence' where id=p_document_id;
  elsif v_currency<>v_doc.expected_currency then
    v_next:='currency_mismatch';
    update public.receipt_documents set rule_code='currency_mismatch',
      rule_reason=format('OCR read %s but the assigned transaction requires %s',v_currency,v_doc.expected_currency)
      where id=p_document_id;
  elsif coalesce(v_conf,0)<0.72
     or public.receipt_json_numeric(p_extraction,'grossAmount') is null
     or nullif(p_extraction->>'refNo','') is null
     or coalesce(p_extraction->>'platform','') !~* '(wechat|weixin|微信|alipay|ali[ -]?pay|支付宝)'
     or coalesce(p_extraction->>'txDate','') !~ '^\d{4}-\d{2}-\d{2}$'
     or (nullif(btrim(coalesce(p_extraction->>'payee','')),'') is null
         and nullif(btrim(coalesce(p_extraction->>'recipientNote',p_extraction->>'merchantName','')),'') is null)
     or coalesce(p_extraction->>'feeTreatment','unknown')='unknown'
     or coalesce(p_extraction->>'transactionStatus','') !~* '(success|completed|successful)' then
    v_next:='needs_manual_review';
    update public.receipt_documents set rule_code='manual_review_required',
      rule_reason='Critical OCR fields need staff verification' where id=p_document_id;
  else
    v_next:='validated';
    update public.receipt_documents set rule_code=null,rule_reason=null where id=p_document_id;
  end if;
  update public.receipt_documents set state=v_next where id=p_document_id;
  return jsonb_build_object('document_id',p_document_id,'state',v_next,'replayed',false);
end;
$$;

create or replace function public.sarraf_receipt_submit(
  p_document_ids jsonb, p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor public.app_users%rowtype; v_doc public.receipt_documents%rowtype; d text;
  v_submitted integer:=0; v_review integer:=0; v_result jsonb; v_prev jsonb;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found then raise exception using errcode='42501', message='not authorized'; end if;
  if p_document_ids is null or jsonb_typeof(p_document_ids)<>'array'
     or jsonb_array_length(p_document_ids)<1 or jsonb_array_length(p_document_ids)>25 then
    raise exception using errcode='22023', message='invalid receipt selection';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_prev from public.receipt_command_log
   where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_prev||jsonb_build_object('replayed',true); end if;
  perform set_config('app.receipt_actor_id',v_actor.id,true);
  perform set_config('app.receipt_reason','Uploader submitted stored receipt evidence',true);
  perform set_config('app.receipt_command_key',p_command_key,true);
  for d in select distinct jsonb_array_elements_text(p_document_ids) order by 1 loop
    select * into v_doc from public.receipt_documents where id=d for update;
    if not found or (v_doc.uploader_id<>v_actor.id and v_actor.role<>'admin') then
      raise exception using errcode='42501', message='receipt selection is outside your assignment';
    end if;
    if v_doc.state='validated' then
      update public.receipt_documents set state='submitted',submitted_at=statement_timestamp() where id=d;
      v_submitted:=v_submitted+1;
    elsif v_doc.state in ('ocr_failed_retryable','uploaded','ocr_pending') then
      if v_doc.state='ocr_failed_retryable' then
        update public.receipt_documents set state='needs_manual_review',
          rule_code='manual_submission',rule_reason='Uploader requested staff review after OCR failure' where id=d;
      elsif v_doc.state='uploaded' then
        update public.receipt_documents set state='needs_manual_review',
          rule_code='manual_submission',rule_reason='Uploader requested staff review before OCR completed' where id=d;
      else
        update public.receipt_documents set state='needs_manual_review',
          rule_code='manual_submission',rule_reason='Uploader requested staff review while OCR was pending' where id=d;
      end if;
      v_review:=v_review+1;
    elsif v_doc.state='needs_manual_review' then
      v_review:=v_review+1;
    elsif v_doc.state not in ('submitted','matched','accepted','finalized','forwarded','delivered','seen') then
      raise exception using errcode='23514', message=format('receipt %s cannot be submitted from %s',d,v_doc.state);
    end if;
  end loop;
  v_result:=jsonb_build_object('submitted',v_submitted,'manual_review',v_review,'replayed',false);
  insert into public.receipt_command_log(actor_id,command_key,operation,result)
  values(v_actor.id,p_command_key,'receipt_submit',v_result);
  return v_result;
end;
$$;

-- ── Review/correction: one audited command replaces direct table writes ────────────────
create or replace function public.sarraf_receipt_review_command(
  p_document_id text, p_action text, p_changes jsonb,
  p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor public.app_users%rowtype; v_doc public.receipt_documents%rowtype;
  v_current public.receipt_extractions%rowtype; v_version integer; v_result jsonb; v_prev jsonb;
  v_currency text; v_duplicate text; v_has_extraction boolean;
  v_ref_norm text; v_merchant_norm text; v_lock_key text; v_duplicate_kind text;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' then
    raise exception using errcode='42501', message='only an administrator may review receipts';
  end if;
  if public.receipt_request_aal()<>'aal2' then
    raise exception using errcode='42501', message='multi-factor authentication is required';
  end if;
  if p_action not in ('accept','reject','correct','reopen')
     or char_length(btrim(coalesce(p_reason,'')))<8 then
    raise exception using errcode='22023', message='a valid action and 8-character reason are required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_prev from public.receipt_command_log
   where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_prev||jsonb_build_object('replayed',true); end if;
  select * into v_doc from public.receipt_documents where id=p_document_id for update;
  if not found then raise exception using errcode='P0002', message='receipt not found'; end if;
  select * into v_current from public.receipt_extractions where document_id=p_document_id
   order by version desc limit 1;
  v_has_extraction := found;
  perform set_config('app.receipt_actor_id',v_actor.id,true);
  perform set_config('app.receipt_reason',left(btrim(p_reason),700),true);
  perform set_config('app.receipt_command_key',p_command_key,true);

  if p_action='correct' then
    if not v_has_extraction then raise exception using errcode='22023', message='there is no extraction to correct'; end if;
    if v_doc.state not in ('parsed','needs_manual_review','validated','submitted',
                           'duplicate','currency_mismatch','tamper_suspected') then
      raise exception using errcode='23514', message='accepted or finalized evidence cannot be corrected; reject and reopen first';
    end if;
    if p_changes is null or jsonb_typeof(p_changes)<>'object' or p_changes='{}'::jsonb
       or exists(select 1 from jsonb_object_keys(p_changes) k
                 where k not in ('grossAmount','orderAmount','feeAmount','feeTreatment','netAmount',
                                 'currency','refNo','merchantOrderNo','payee','platform','txDate','txTime')) then
      raise exception using errcode='22023', message='invalid correction fields';
    end if;
    if exists(
      select 1 from unnest(array['grossAmount','orderAmount','feeAmount','netAmount']) as keys(key)
      where p_changes ? key and (
        public.receipt_json_numeric(p_changes,key) is null
        or public.receipt_json_numeric(p_changes,key)<0)
    ) then raise exception using errcode='22023', message='corrected amounts must be non-negative numbers'; end if;
    if p_changes ? 'feeTreatment' and coalesce(p_changes->>'feeTreatment','') not in
       ('added_on_top','deducted_from_principal','included_in_total','no_fee','unknown') then
      raise exception using errcode='22023', message='invalid corrected fee treatment';
    end if;
    if p_changes ? 'currency' and coalesce(upper(p_changes->>'currency'),'')!~'^[A-Z]{3,8}$' then
      raise exception using errcode='22023', message='invalid corrected currency';
    end if;
    if p_changes ? 'txDate' and coalesce(p_changes->>'txDate','')!~'^\d{4}-\d{2}-\d{2}$' then
      raise exception using errcode='22023', message='invalid corrected receipt date';
    end if;
    if p_changes ? 'txTime' and coalesce(p_changes->>'txTime','')!~'^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$' then
      raise exception using errcode='22023', message='invalid corrected receipt time';
    end if;
    if exists(
      select 1 from unnest(array['refNo','merchantOrderNo','payee','platform']) as keys(key)
      where p_changes ? key and jsonb_typeof(p_changes->key)<>'string'
    ) then raise exception using errcode='22023', message='corrected receipt text must be a string'; end if;
    if p_changes ? 'platform' and coalesce(p_changes->>'platform','') !~*
       '(wechat|weixin|微信|alipay|ali[ -]?pay|支付宝)' then
      raise exception using errcode='22023', message='corrected platform must be WeChat or Alipay';
    end if;
    v_version:=v_current.version+1;
    v_currency:=coalesce(nullif(upper(p_changes->>'currency'),''),v_current.currency);
    if v_currency is distinct from v_doc.expected_currency then
      raise exception using errcode='22023', message='correction currency must match the assigned transaction';
    end if;
    insert into public.receipt_extractions(
      document_id,version,is_original,provider,model,ocr_version,raw,
      gross_amount,order_amount,fee_amount,fee_treatment,net_amount,currency,
      ref_no,merchant_order_no,payee,tx_date,tx_time,confidence,field_confidence,
      platform,platform_evidence,has_fee,transaction_status,
      image_sha256,request_id,server_recorded,attestation_version,
      corrected_by,correction_reason,corrected_at)
    values (p_document_id,v_version,false,v_current.provider,v_current.model,v_current.ocr_version,v_current.raw,
      coalesce(abs(public.receipt_json_numeric(p_changes,'grossAmount')),v_current.gross_amount),
      coalesce(abs(public.receipt_json_numeric(p_changes,'orderAmount')),v_current.order_amount),
      coalesce(abs(public.receipt_json_numeric(p_changes,'feeAmount')),v_current.fee_amount),
      coalesce(case when p_changes->>'feeTreatment' in
        ('added_on_top','deducted_from_principal','included_in_total','no_fee','unknown')
        then p_changes->>'feeTreatment' end,v_current.fee_treatment),
      coalesce(abs(public.receipt_json_numeric(p_changes,'netAmount')),v_current.net_amount),v_currency,
      coalesce(left(nullif(p_changes->>'refNo',''),160),v_current.ref_no),
      coalesce(left(nullif(p_changes->>'merchantOrderNo',''),160),v_current.merchant_order_no),
      coalesce(left(nullif(p_changes->>'payee',''),160),v_current.payee),
      coalesce(case when p_changes->>'txDate'~'^\d{4}-\d{2}-\d{2}$' then (p_changes->>'txDate')::date end,v_current.tx_date),
      coalesce(case when p_changes->>'txTime'~'^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$' then (p_changes->>'txTime')::time end,v_current.tx_time),
      v_current.confidence,v_current.field_confidence,
      coalesce(case
        when coalesce(p_changes->>'platform','')~*'(wechat|weixin|微信)' then 'wechat'
        when coalesce(p_changes->>'platform','')~*'(alipay|ali[ -]?pay|支付宝)' then 'alipay'
        end,v_current.platform),
      v_current.platform_evidence,
      case
        when coalesce(abs(public.receipt_json_numeric(p_changes,'feeAmount')),v_current.fee_amount,0)>0 then true
        when coalesce(p_changes->>'feeTreatment',v_current.fee_treatment)='no_fee' then false
        when coalesce(p_changes->>'feeTreatment',v_current.fee_treatment) in
          ('added_on_top','deducted_from_principal','included_in_total') then true
        else null end,
      v_current.transaction_status,
      v_current.image_sha256,
      v_current.request_id,true,v_current.attestation_version,v_actor.id,left(btrim(p_reason),700),statement_timestamp());
    if not exists(
      select 1 from public.receipt_extractions e
      where e.document_id=p_document_id and e.version=v_version and (
        e.gross_amount is distinct from v_current.gross_amount
        or e.order_amount is distinct from v_current.order_amount
        or e.fee_amount is distinct from v_current.fee_amount
        or e.fee_treatment is distinct from v_current.fee_treatment
        or e.net_amount is distinct from v_current.net_amount
        or e.currency is distinct from v_current.currency
        or e.ref_no is distinct from v_current.ref_no
        or e.merchant_order_no is distinct from v_current.merchant_order_no
        or e.payee is distinct from v_current.payee
        or e.platform is distinct from v_current.platform
        or e.tx_date is distinct from v_current.tx_date
        or e.tx_time is distinct from v_current.tx_time)
    ) then raise exception using errcode='22023', message='correction does not change any receipt field'; end if;
    if v_doc.state in ('parsed','validated','submitted','duplicate','currency_mismatch','tamper_suspected') then
      update public.receipt_documents set state='needs_manual_review',counted=false,
        rule_code='staff_correction',rule_reason=left(btrim(p_reason),700) where id=p_document_id;
    end if;
    v_result:=jsonb_build_object('document_id',p_document_id,'action','correct','version',v_version,
                                 'state','needs_manual_review','replayed',false);
  elsif p_action='accept' then
    if not v_has_extraction or coalesce(v_current.net_amount,v_current.order_amount,v_current.gross_amount)<=0
       or v_current.currency is distinct from v_doc.expected_currency or v_doc.transaction_id is null then
      raise exception using errcode='23514', message='receipt is missing a matched amount, currency or transaction';
    end if;
    if v_current.gross_amount is null or v_current.gross_amount<=0
       or v_current.fee_amount is null or v_current.fee_amount<0
       or v_current.net_amount is null or v_current.net_amount<=0
       or coalesce(v_current.ref_no,v_current.merchant_order_no) is null
       or v_current.tx_date is null
       or v_current.platform not in ('wechat','alipay')
       or v_current.has_fee is null
       or (nullif(btrim(coalesce(v_current.payee,'')),'') is null
           and nullif(btrim(coalesce(v_current.raw->>'recipientNote',v_current.raw->>'merchantName','')),'') is null)
       or coalesce(v_current.fee_treatment,'unknown')='unknown' then
      raise exception using errcode='23514', message='receipt identity, fee treatment and amounts require correction before acceptance';
    end if;
    if (
      v_current.fee_treatment='added_on_top' and (
        v_current.order_amount is null
        or abs(v_current.gross_amount-(v_current.order_amount+v_current.fee_amount))>0.01
        or abs(v_current.net_amount-v_current.order_amount)>0.01)
      ) or (
      v_current.fee_treatment in ('included_in_total','deducted_from_principal') and (
        v_current.order_amount is null or v_current.fee_amount>v_current.order_amount
        or abs(v_current.gross_amount-v_current.order_amount)>0.01
        or abs(v_current.net_amount-(v_current.order_amount-v_current.fee_amount))>0.01)
      ) or (
      v_current.fee_treatment='no_fee' and (
        v_current.fee_amount<>0
        or abs(v_current.net_amount-coalesce(v_current.order_amount,v_current.gross_amount))>0.01
        or (v_current.order_amount is not null and abs(v_current.gross_amount-v_current.order_amount)>0.01))
      ) then
      raise exception using errcode='23514', message='receipt gross, fee, order and net amounts do not reconcile';
    end if;
    v_ref_norm:=nullif(upper(regexp_replace(coalesce(v_current.ref_no,''),'[^[:alnum:]]','','g')),'');
    v_merchant_norm:=nullif(upper(regexp_replace(coalesce(v_current.merchant_order_no,''),'[^[:alnum:]]','','g')),'');
    -- Independent, ordered locks make same-image, same-reference and same-merchant-reference
    -- acceptance races serialize even when they involve different document rows.
    for v_lock_key in
      select distinct key from unnest(array[
        case when v_doc.image_sha256 is not null then 'hash:'||v_doc.image_sha256 end,
        case when char_length(coalesce(v_ref_norm,''))>=4 then 'ref:'||v_ref_norm end,
        case when char_length(coalesce(v_merchant_norm,''))>=4 then 'merchant:'||v_merchant_norm end
      ]) keys(key) where key is not null order by key
    loop
      perform pg_advisory_xact_lock(hashtextextended('receipt-duplicate:'||v_lock_key,0));
    end loop;
    select d.id,
      case when d.image_sha256=v_doc.image_sha256 then 'exact_image_duplicate'
           when v_ref_norm is not null and upper(regexp_replace(coalesce(e.ref_no,''),'[^[:alnum:]]','','g'))=v_ref_norm
             then 'exact_reference_duplicate'
           else 'exact_merchant_reference_duplicate' end
      into v_duplicate,v_duplicate_kind
    from public.receipt_documents d
    join lateral (
      select x.* from public.receipt_extractions x where x.document_id=d.id order by x.version desc limit 1
    ) e on true
    where d.id<>p_document_id and d.counted and (
      (v_doc.image_sha256 is not null and d.image_sha256=v_doc.image_sha256)
      or (char_length(coalesce(v_ref_norm,''))>=4
          and upper(regexp_replace(coalesce(e.ref_no,''),'[^[:alnum:]]','','g'))=v_ref_norm)
      or (char_length(coalesce(v_merchant_norm,''))>=4
          and upper(regexp_replace(coalesce(e.merchant_order_no,''),'[^[:alnum:]]','','g'))=v_merchant_norm)
    ) order by d.accepted_at nulls last,d.received_at,d.id limit 1;
    if v_duplicate is not null then
      update public.receipt_documents set state='duplicate',counted=false,
        rule_code=v_duplicate_kind,rule_reason='Receipt identity is already counted by another accepted document'
        where id=p_document_id;
      v_result:=jsonb_build_object('document_id',p_document_id,'action','accept','state','duplicate',
        'counted',false,'rule_code',v_duplicate_kind,'replayed',false);
      insert into public.receipt_command_log(actor_id,command_key,operation,result)
      values(v_actor.id,p_command_key,'receipt_review_accept',v_result);
      return v_result;
    end if;
    if v_doc.state in ('duplicate','currency_mismatch','tamper_suspected') then
      update public.receipt_documents set state='needs_manual_review' where id=p_document_id;
    elsif v_doc.state='ocr_failed_retryable' then
      update public.receipt_documents set state='needs_manual_review' where id=p_document_id;
    elsif v_doc.state='rejected' then
      update public.receipt_documents set state='needs_manual_review' where id=p_document_id;
    end if;
    if (select state from public.receipt_documents where id=p_document_id)='parsed' then
      update public.receipt_documents set state='validated' where id=p_document_id;
    elsif (select state from public.receipt_documents where id=p_document_id)='needs_manual_review' then
      update public.receipt_documents set state='validated' where id=p_document_id;
    end if;
    if (select state from public.receipt_documents where id=p_document_id)='validated' then
      update public.receipt_documents set state='submitted',submitted_at=coalesce(submitted_at,statement_timestamp()) where id=p_document_id;
    end if;
    if (select state from public.receipt_documents where id=p_document_id)='submitted' then
      update public.receipt_documents set state='matched' where id=p_document_id;
    end if;
    if (select state from public.receipt_documents where id=p_document_id)='matched' then
      update public.receipt_documents set state='accepted',counted=true,accepted_at=statement_timestamp(),
        rule_code=null,rule_reason=null where id=p_document_id;
    end if;
    if (select state from public.receipt_documents where id=p_document_id)<>'accepted' then
      raise exception using errcode='23514', message='receipt cannot be accepted from its current state';
    end if;
    v_result:=jsonb_build_object('document_id',p_document_id,'action','accept','state','accepted','counted',true,'replayed',false);
  elsif p_action='reject' then
    if v_doc.state='ocr_failed_retryable' then
      update public.receipt_documents set state='needs_manual_review' where id=p_document_id;
    elsif v_doc.state='parsed' then
      update public.receipt_documents set state='needs_manual_review' where id=p_document_id;
    elsif v_doc.state='accepted' then
      null;
    elsif v_doc.state not in ('needs_manual_review','validated','submitted','matched','duplicate','currency_mismatch','tamper_suspected') then
      raise exception using errcode='23514', message='receipt cannot be rejected from its current state';
    end if;
    update public.receipt_documents set state='rejected',counted=false,
      rule_code='manual_reject',rule_reason=left(btrim(p_reason),700) where id=p_document_id;
    v_result:=jsonb_build_object('document_id',p_document_id,'action','reject','state','rejected','counted',false,'replayed',false);
  else
    if v_doc.state<>'rejected' then raise exception using errcode='23514', message='only a rejected receipt can be reopened'; end if;
    update public.receipt_documents set state='needs_manual_review',counted=false,
      rule_code='reopened',rule_reason=left(btrim(p_reason),700) where id=p_document_id;
    v_result:=jsonb_build_object('document_id',p_document_id,'action','reopen','state','needs_manual_review','replayed',false);
  end if;
  insert into public.receipt_command_log(actor_id,command_key,operation,result)
  values(v_actor.id,p_command_key,'receipt_review_'||p_action,v_result);
  return v_result;
end;
$$;

-- ── Manual daily rate and immutable finalization snapshot ──────────────────────────────
create or replace function public.sarraf_set_receipt_daily_rate(
  p_currency text, p_effective_date date, p_rate numeric,
  p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor public.app_users%rowtype; v_version bigint; v_id text; v_result jsonb; v_prev jsonb;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' or public.receipt_request_aal()<>'aal2' then
    raise exception using errcode='42501', message='admin MFA is required to set a receipt rate';
  end if;
  if upper(btrim(coalesce(p_currency,'')))!~'^[A-Z]{3,8}$' or p_effective_date is null
     or p_rate is null or p_rate<=0 or char_length(btrim(coalesce(p_reason,'')))<8 then
    raise exception using errcode='22023', message='invalid manual receipt rate';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_prev from public.receipt_command_log where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_prev||jsonb_build_object('replayed',true); end if;
  -- Two administrators setting the same business-day rate must serialize on the rate itself,
  -- not merely on their unrelated command keys.
  perform pg_advisory_xact_lock(hashtextextended(
    'receipt-rate:'||upper(btrim(p_currency))||':'||p_effective_date::text,0));
  select coalesce(max(version),0)+1 into v_version from public.receipt_daily_rates
   where currency=upper(btrim(p_currency)) and effective_date=p_effective_date;
  v_id:='rr-'||md5(upper(btrim(p_currency))||':'||p_effective_date::text||':'||v_version::text);
  insert into public.receipt_daily_rates(id,currency,effective_date,rate_value,version,set_by,reason)
  values(v_id,upper(btrim(p_currency)),p_effective_date,p_rate,v_version,v_actor.id,left(btrim(p_reason),700));
  v_result:=jsonb_build_object('id',v_id,'currency',upper(btrim(p_currency)),
    'effective_date',p_effective_date,'rate_value',p_rate,'convention','1_USD_EQUALS_X_CURRENCY',
    'version',v_version,'replayed',false);
  insert into public.receipt_command_log(actor_id,command_key,operation,result)
  values(v_actor.id,p_command_key,'set_receipt_daily_rate',v_result);
  return v_result;
end;
$$;

create or replace function public.sarraf_receipt_finalize_command(
  p_document_id text, p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor public.app_users%rowtype; v_doc public.receipt_documents%rowtype;
  v_rate public.receipt_daily_rates%rowtype; v_business_date date; v_result jsonb; v_prev jsonb;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' or public.receipt_request_aal()<>'aal2' then
    raise exception using errcode='42501', message='admin MFA is required to finalize receipts';
  end if;
  if char_length(btrim(coalesce(p_reason,'')))<8 then
    raise exception using errcode='22023', message='an 8-character reason is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_prev from public.receipt_command_log where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_prev||jsonb_build_object('replayed',true); end if;
  select * into v_doc from public.receipt_documents where id=p_document_id for update;
  if not found or v_doc.state<>'accepted' or not v_doc.counted or v_doc.transaction_id is null then
    raise exception using errcode='23514', message='only an accepted matched receipt can be finalized';
  end if;
  select coalesce((t.date at time zone 'Asia/Baghdad')::date,
                  (statement_timestamp() at time zone 'Asia/Baghdad')::date)
    into v_business_date from public.txs t where t.id=v_doc.transaction_id;
  if v_doc.expected_currency='USD' then
    v_rate.id:='USD-1'; v_rate.rate_value:=1; v_rate.effective_date:=v_business_date;
    v_rate.version:=1; v_rate.set_by:=v_actor.id; v_rate.reference_kind:='manual_receipt_rate';
  else
    select * into v_rate from public.receipt_daily_rates
     where currency=v_doc.expected_currency and effective_date=v_business_date
     order by version desc limit 1;
    if not found then
      update public.receipt_documents set rule_code='pending_rate',
        rule_reason='نرخی USD/'||v_doc.expected_currency||' ـی ئەم ڕۆژە دانەنراوە' where id=p_document_id;
      v_result:=jsonb_build_object('document_id',p_document_id,'state','accepted','valuation_status','pending_rate',
        'rate_date',v_business_date,'replayed',false);
      insert into public.receipt_command_log(actor_id,command_key,operation,result)
      values(v_actor.id,p_command_key,'receipt_finalize',v_result);
      return v_result;
    end if;
  end if;
  perform set_config('app.receipt_actor_id',v_actor.id,true);
  perform set_config('app.receipt_reason',left(btrim(p_reason),700),true);
  perform set_config('app.receipt_command_key',p_command_key,true);
  update public.receipt_documents set state='finalized',finalized_at=statement_timestamp(),
    rate_value=v_rate.rate_value,rate_convention='1_USD_EQUALS_X_CURRENCY',
    rate_date=v_rate.effective_date,rate_version=v_rate.version,
    rate_kind=coalesce(v_rate.reference_kind,'manual_receipt_rate'),rate_set_by=v_rate.set_by,
    rate_captured_at=statement_timestamp(),summary_version=summary_version+1,
    rule_code=null,rule_reason=null where id=p_document_id;
  v_result:=jsonb_build_object('document_id',p_document_id,'state','finalized','valuation_status','valued',
    'rate_value',v_rate.rate_value,'rate_convention','1_USD_EQUALS_X_CURRENCY',
    'rate_date',v_rate.effective_date,'rate_version',v_rate.version,'replayed',false);
  insert into public.receipt_command_log(actor_id,command_key,operation,result)
  values(v_actor.id,p_command_key,'receipt_finalize',v_result);
  return v_result;
end;
$$;

-- ── Exact-recipient forwarding: the client no longer supplies a recipient id ──────────
create or replace function public.sarraf_forward_receipts_v2(
  p_document_ids jsonb, p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor public.app_users%rowtype; v_doc public.receipt_documents%rowtype;
  v_a public.receipt_transaction_assignments%rowtype; v_to text; v_kind public.party_kind;
  v_forwarding text; d text; v_forwarded integer:=0; v_destinations jsonb:='[]'::jsonb;
  v_result jsonb; v_prev jsonb;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' or public.receipt_request_aal()<>'aal2' then
    raise exception using errcode='42501', message='admin MFA is required to forward receipts';
  end if;
  if p_document_ids is null or jsonb_typeof(p_document_ids)<>'array'
     or jsonb_array_length(p_document_ids)<1 or jsonb_array_length(p_document_ids)>100
     or char_length(btrim(coalesce(p_reason,'')))<8 then
    raise exception using errcode='22023', message='receipts and an 8-character reason are required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_prev from public.receipt_command_log where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_prev||jsonb_build_object('replayed',true); end if;
  perform set_config('app.receipt_actor_id',v_actor.id,true);
  perform set_config('app.receipt_reason',left(btrim(p_reason),700),true);
  perform set_config('app.receipt_command_key',p_command_key,true);
  for d in select distinct jsonb_array_elements_text(p_document_ids) order by 1 loop
    select * into v_doc from public.receipt_documents where id=d for update;
    if not found or v_doc.state<>'finalized' or v_doc.transaction_id is null then
      raise exception using errcode='23514', message=format('receipt %s is not finalized',d);
    end if;
    select * into v_a from public.receipt_transaction_assignments
     where transaction_id=v_doc.transaction_id;
    if not found or v_a.flow<>v_doc.flow then
      raise exception using errcode='42501', message='receipt assignment no longer matches the document';
    end if;
    if v_doc.flow<>'customer_buys_from_zeman' then
      raise exception using errcode='23514', message='only assigned partner evidence is published to a customer';
    end if;
    if v_doc.partner_id is distinct from v_a.partner_id or v_doc.customer_id is distinct from v_a.customer_id then
      raise exception using errcode='42501', message='receipt parties no longer match the transaction assignment';
    end if;
    v_to:=v_a.customer_id; v_kind:='customer';
    if v_to is null then raise exception using errcode='23514', message='the exact recipient has not been assigned'; end if;
    v_forwarding:='fwd-'||md5(d||':'||v_to);
    insert into public.receipt_forwardings(
      id,document_id,batch_id,transaction_id,from_actor_type,from_actor_id,
      to_actor_type,to_actor_id,delivery_channel,delivery_status,forwarded_by,
      forwarded_at,delivered_at,command_key)
    values(v_forwarding,d,v_doc.batch_id,v_doc.transaction_id,'partner',v_a.partner_id,v_kind,v_to,
      'in_app','delivered',v_actor.id,statement_timestamp(),statement_timestamp(),p_command_key)
    on conflict(document_id,to_actor_id) do nothing;
    if not found then raise exception using errcode='23505', message='receipt was already forwarded to its assigned recipient'; end if;
    update public.receipt_documents set state='forwarded' where id=d;
    update public.receipt_documents set state='delivered' where id=d;
    insert into public.receipt_notifications(id,forwarding_id,document_id,recipient_id,status)
    values('rn-'||md5(v_forwarding||':'||v_to),v_forwarding,d,v_to,'delivered')
    on conflict(forwarding_id,recipient_id) do nothing;
    v_forwarded:=v_forwarded+1;
    v_destinations:=v_destinations||jsonb_build_object(
      'document_id',d,'to_actor_id',v_to,'to_role',v_kind,'delivery_status','delivered');
  end loop;
  v_result:=jsonb_build_object('forwarded',v_forwarded,'destinations',v_destinations,'replayed',false);
  insert into public.receipt_command_log(actor_id,command_key,operation,result)
  values(v_actor.id,p_command_key,'forward_receipts_v2',v_result);
  return v_result;
end;
$$;

create or replace function public.sarraf_receipt_mark_seen_v2(p_document_id text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_me text; v_f public.receipt_forwardings%rowtype;
begin
  v_me:=public.my_app_id();
  if v_me is null then raise exception using errcode='42501', message='not authorized'; end if;
  select * into v_f from public.receipt_forwardings
   where document_id=p_document_id and to_actor_id=v_me for update;
  if not found then raise exception using errcode='42501', message='receipt was not forwarded to this account'; end if;
  if v_f.delivery_status='seen' then
    return jsonb_build_object('document_id',p_document_id,'status','seen','replayed',true);
  end if;
  perform set_config('app.receipt_actor_id',v_me,true);
  perform set_config('app.receipt_reason','Assigned recipient opened the forwarded receipt',true);
  update public.receipt_forwardings set delivery_status='seen',seen_at=statement_timestamp(),version=version+1
   where id=v_f.id;
  update public.receipt_notifications set status='seen',seen_at=statement_timestamp()
   where forwarding_id=v_f.id and recipient_id=v_me;
  update public.receipt_documents set state='seen' where id=p_document_id and state='delivered';
  return jsonb_build_object('document_id',p_document_id,'status','seen','replayed',false);
end;
$$;

-- Canonical read model: the same snapshot is returned to staff and the uploader.  Raw OCR is
-- never included.  USD values are null until a manual rate snapshot exists.
create or replace function public.sarraf_receipt_summary(p_document_id text)
returns jsonb language plpgsql security definer stable set search_path = pg_catalog, public as $$
declare
  v_doc public.receipt_documents%rowtype; v_x public.receipt_extractions%rowtype;
  v_available public.receipt_daily_rates%rowtype; v_me text; v_role text; v_business_date date;
begin
  v_me:=public.my_app_id(); v_role:=public.my_role();
  select * into v_doc from public.receipt_documents where id=p_document_id;
  if not found or not (
    v_role='admin' or v_doc.uploader_id=v_me or exists(
      select 1 from public.receipt_forwardings f where f.document_id=v_doc.id and f.to_actor_id=v_me)
  ) then raise exception using errcode='42501', message='receipt is outside this account'; end if;
  select * into v_x from public.receipt_extractions where document_id=p_document_id order by version desc limit 1;
  select (t.date at time zone 'Asia/Baghdad')::date into v_business_date
    from public.txs t where t.id=v_doc.transaction_id;
  if v_doc.expected_currency='USD' then
    v_available.rate_value:=1; v_available.version:=1; v_available.effective_date:=v_business_date;
  else
    select * into v_available from public.receipt_daily_rates
      where currency=v_doc.expected_currency and effective_date=v_business_date
      order by version desc limit 1;
  end if;
  return jsonb_build_object(
    'document_id',v_doc.id,'transaction_id',v_doc.transaction_id,'flow',v_doc.flow,'state',v_doc.state,
    'received_at',v_doc.received_at,'counted',v_doc.counted,'currency',v_x.currency,
    'gross_amount',v_x.gross_amount,'order_amount',v_x.order_amount,'fee_amount',v_x.fee_amount,
    'net_amount',v_x.net_amount,'ref_no',v_x.ref_no,'merchant_order_no',v_x.merchant_order_no,
    'payee',v_x.payee,'tx_date',v_x.tx_date,'tx_time',v_x.tx_time,
    'business_date',v_business_date,
    'rate_value',v_doc.rate_value,'rate_convention',v_doc.rate_convention,'rate_date',v_doc.rate_date,
    'rate_version',v_doc.rate_version,'rate_kind',v_doc.rate_kind,'rate_captured_at',v_doc.rate_captured_at,
    'available_rate_value',coalesce(v_doc.rate_value,v_available.rate_value),
    'available_rate_version',coalesce(v_doc.rate_version,v_available.version),
    'gross_usd',case when v_doc.rate_value>0 then round(v_x.gross_amount/v_doc.rate_value,2) end,
    'fee_usd',case when v_doc.rate_value>0 then round(v_x.fee_amount/v_doc.rate_value,2) end,
    'net_usd',case when v_doc.rate_value>0 then round(v_x.net_amount/v_doc.rate_value,2) end,
    'valuation_status',case when v_doc.rate_value>0 then 'valued' else 'pending_rate' end,
    'summary_version',v_doc.summary_version,'receipt_set_version',v_doc.receipt_set_version,
    'reason',case when v_role='admin' then v_doc.rule_reason else null end);
end;
$$;

-- Uploader status is intentionally plain-language-safe. Internal rule text and cross-record
-- identifiers never leave through this compatibility-shaped read model.
create or replace function public.sarraf_my_receipt_intakes(p_limit integer default 50)
returns table(id text, state public.receipt_state, flow public.receipt_flow,
              received_at timestamptz, ocr_attempts integer, rule_reason text)
language sql security definer stable set search_path = pg_catalog, public as $$
  select d.id,d.state,d.flow,d.received_at,d.ocr_attempts,
    case
      when d.state='duplicate' then 'وێنەکە پێشتر تۆمارکراوە'
      when d.state='currency_mismatch' then 'دراوی فیشەکە لەگەڵ مامەڵەکە یەک ناگرێتەوە'
      when d.state='tamper_suspected' then 'فیشەکە پشکنینی زیاتر پێویستە'
      when d.state='rejected' then 'فیشەکە لەلایەن ئەدمینەوە ڕەتکراوەتەوە'
      when d.state='needs_manual_review' then 'فیشەکە لە پشکنینی ئەدمیندایە'
      else null
    end
  from public.receipt_documents d
  where d.uploader_id=public.my_app_id()
  order by d.received_at desc
  limit least(greatest(coalesce(p_limit,50),1),200);
$$;

-- One canonical portal aggregate for both uploaders and assigned recipients. Accepted values
-- are never mixed across currencies, and USD totals stay null if any counted row lacks a frozen
-- rate snapshot (rather than understating the total).
create or replace function public.sarraf_portal_receipt_summary_v2(p_days integer default 365)
returns jsonb language plpgsql security definer stable set search_path = pg_catalog, public as $$
declare v_actor public.app_users%rowtype; v_days integer:=least(greatest(coalesce(p_days,365),1),3650); v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role not in ('customer','partner') then
    raise exception using errcode='42501',message='portal receipt summary is not authorized';
  end if;
  with visible as (
    select d.*,x.currency,x.gross_amount,x.order_amount,x.fee_amount,x.net_amount,x.ref_no,x.tx_date
    from public.receipt_documents d
    left join lateral (
      select e.* from public.receipt_extractions e where e.document_id=d.id order by e.version desc limit 1
    ) x on true
    where d.received_at>=statement_timestamp()-make_interval(days=>v_days)
      and (d.uploader_id=v_actor.id or exists(
        select 1 from public.receipt_forwardings f where f.document_id=d.id and f.to_actor_id=v_actor.id))
  ), totals as (
    select currency,
      coalesce(sum(gross_amount) filter(where counted),0) total_gross,
      coalesce(sum(fee_amount) filter(where counted),0) total_fee,
      coalesce(sum(net_amount) filter(where counted),0) total_net,
      count(*) filter(where counted) accepted_count,
      count(*) filter(where counted and rate_value is null) pending_rate_count,
      case when count(*) filter(where counted and rate_value is null)=0
        then coalesce(sum(round(gross_amount/rate_value,2)) filter(where counted),0) end total_gross_usd,
      case when count(*) filter(where counted and rate_value is null)=0
        then coalesce(sum(round(fee_amount/rate_value,2)) filter(where counted),0) end total_fee_usd,
      case when count(*) filter(where counted and rate_value is null)=0
        then coalesce(sum(round(net_amount/rate_value,2)) filter(where counted),0) end total_net_usd
    from visible where currency is not null
    group by currency
    having count(*) filter(where counted)>0
  ), recent as (
    select id,currency,net_amount total_net,state::text receipt_stage,received_at created_at,
      1::integer n,case when state in ('rejected','duplicate') then 1 else 0 end rejected_n,
      transaction_id,rate_value,
      case when rate_value>0 then round(net_amount/rate_value,2) end total_net_usd
    from visible order by received_at desc limit 50
  )
  select jsonb_build_object(
    'totals',coalesce((select jsonb_agg(to_jsonb(t) order by t.total_net desc) from totals t),'[]'::jsonb),
    'batches',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc) from recent r),'[]'::jsonb),
    'batch_count',(select count(*) from visible),
    'accepted_count',(select count(*) from visible where counted),
    'rejected_count',(select count(*) from visible where state in ('rejected','duplicate')),
    'pending_count',(select count(*) from visible where not counted and state not in ('rejected','duplicate'))
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.sarraf_my_forwarded_receipts_v2(p_limit integer default 100)
returns table(
  document_id text, delivery_status public.delivery_status, forwarded_at timestamptz,
  seen_at timestamptz, storage_path text, currency text,
  gross_amount numeric, order_amount numeric, fee_amount numeric, net_amount numeric,
  ref_no text, merchant_order_no text, tx_date date, transaction_id text,
  rate_value numeric, rate_convention text, rate_date date, rate_version bigint,
  gross_usd numeric, fee_usd numeric, net_usd numeric)
language sql security definer stable set search_path = pg_catalog, public as $$
  select f.document_id,f.delivery_status,f.forwarded_at,f.seen_at,d.storage_path,
    x.currency,x.gross_amount,x.order_amount,x.fee_amount,x.net_amount,
    x.ref_no,x.merchant_order_no,x.tx_date,f.transaction_id,
    d.rate_value,d.rate_convention,d.rate_date,d.rate_version,
    case when d.rate_value>0 then round(x.gross_amount/d.rate_value,2) end,
    case when d.rate_value>0 then round(x.fee_amount/d.rate_value,2) end,
    case when d.rate_value>0 then round(x.net_amount/d.rate_value,2) end
  from public.receipt_forwardings f
  join public.receipt_documents d on d.id=f.document_id
  left join lateral (
    select e.* from public.receipt_extractions e where e.document_id=d.id order by e.version desc limit 1
  ) x on true
  where f.to_actor_id=public.my_app_id()
  order by f.forwarded_at desc
  limit least(greatest(coalesce(p_limit,100),1),300);
$$;

-- ── Least privilege and removal of legacy command bypasses ─────────────────────────────
alter table public.receipt_transaction_assignments enable row level security;
alter table public.receipt_assignment_events enable row level security;
alter table public.receipt_command_log enable row level security;
alter table public.receipt_ocr_attempts enable row level security;
alter table public.receipt_daily_rates enable row level security;
alter table public.receipt_notifications enable row level security;

revoke all on public.receipt_transaction_assignments,public.receipt_assignment_events,
  public.receipt_command_log,public.receipt_ocr_attempts,public.receipt_daily_rates,
  public.receipt_notifications from public,anon,authenticated;
grant select on public.receipt_transaction_assignments,public.receipt_daily_rates,
  public.receipt_notifications to authenticated;
grant select on public.receipt_assignment_events,public.receipt_command_log,
  public.receipt_ocr_attempts to authenticated;

drop policy if exists rta_admin_read on public.receipt_transaction_assignments;
create policy rta_admin_read on public.receipt_transaction_assignments for select to authenticated
  using(public.is_admin());
drop policy if exists rta_party_read on public.receipt_transaction_assignments;
create policy rta_party_read on public.receipt_transaction_assignments for select to authenticated
  using(customer_id=public.my_app_id() or partner_id=public.my_app_id() or office_id=public.my_app_id());
drop policy if exists rae_admin_read on public.receipt_assignment_events;
create policy rae_admin_read on public.receipt_assignment_events for select to authenticated
  using(public.is_admin());
drop policy if exists rcl_admin_read on public.receipt_command_log;
create policy rcl_admin_read on public.receipt_command_log for select to authenticated
  using(public.is_admin());
drop policy if exists roa_admin_read on public.receipt_ocr_attempts;
create policy roa_admin_read on public.receipt_ocr_attempts for select to authenticated
  using(public.is_admin());
drop policy if exists rdr_authenticated_read on public.receipt_daily_rates;
create policy rdr_authenticated_read on public.receipt_daily_rates for select to authenticated
  using(public.my_app_id() is not null);
drop policy if exists rn_admin_read on public.receipt_notifications;
create policy rn_admin_read on public.receipt_notifications for select to authenticated using(public.is_admin());
drop policy if exists rn_own_read on public.receipt_notifications;
create policy rn_own_read on public.receipt_notifications for select to authenticated using(recipient_id=public.my_app_id());

-- Offices no longer receive blanket access to raw receipt data or custody/audit history.
drop policy if exists rd_staff_read on public.receipt_documents;
create policy rd_staff_read on public.receipt_documents for select to authenticated using(public.is_admin());
drop policy if exists rd_uploader_read on public.receipt_documents;
drop policy if exists rd_forwarded_read on public.receipt_documents;
drop policy if exists re_staff_read on public.receipt_extractions;
create policy re_staff_read on public.receipt_extractions for select to authenticated using(public.is_admin());
drop policy if exists rst_staff_read on public.receipt_state_transitions;
create policy rst_staff_read on public.receipt_state_transitions for select to authenticated using(public.is_admin());
drop policy if exists rst_own_read on public.receipt_state_transitions;
drop policy if exists rf_staff_read on public.receipt_forwardings;
create policy rf_staff_read on public.receipt_forwardings for select to authenticated using(public.is_admin());
drop policy if exists rf_recipient_read on public.receipt_forwardings;
drop policy if exists rcl_staff_read on public.receipt_custody_ledger;
create policy rcl_staff_read on public.receipt_custody_ledger for select to authenticated using(public.is_admin());

revoke execute on function public.sarraf_receipt_intake_begin(text,public.receipt_flow,text,text,text,text,text,text) from authenticated;
revoke execute on function public.sarraf_receipt_intake_stored(text,text,bigint) from authenticated;
revoke execute on function public.sarraf_receipt_intake_extracted(text,boolean,jsonb,text,text) from authenticated;
revoke execute on function public.sarraf_forward_receipts(jsonb,text,text,text,text) from authenticated;
revoke execute on function public.sarraf_receipt_mark_delivered(text) from authenticated;
revoke execute on function public.sarraf_receipt_mark_seen(text) from authenticated;

revoke all on function public.sarraf_receipt_record_server_extraction(
  text,text,bigint,text,boolean,jsonb,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.sarraf_receipt_record_server_extraction(
  text,text,bigint,text,boolean,jsonb,text,text,integer,text) to service_role;

revoke all on function public.sarraf_set_receipt_assignment(text,text,text,text,text) from public,anon;
revoke all on function public.sarraf_receipt_intake_begin_v2(text,text,text,text,text,text) from public,anon;
revoke all on function public.sarraf_receipt_submit(jsonb,text) from public,anon;
revoke all on function public.sarraf_receipt_review_command(text,text,jsonb,text,text) from public,anon;
revoke all on function public.sarraf_set_receipt_daily_rate(text,date,numeric,text,text) from public,anon;
revoke all on function public.sarraf_receipt_finalize_command(text,text,text) from public,anon;
revoke all on function public.sarraf_forward_receipts_v2(jsonb,text,text) from public,anon;
revoke all on function public.sarraf_receipt_mark_seen_v2(text) from public,anon;
revoke all on function public.sarraf_receipt_summary(text) from public,anon;
revoke all on function public.sarraf_my_receipt_intakes(integer) from public,anon;
revoke all on function public.sarraf_portal_receipt_summary_v2(integer) from public,anon;
revoke all on function public.sarraf_my_forwarded_receipts_v2(integer) from public,anon;

grant execute on function public.sarraf_set_receipt_assignment(text,text,text,text,text) to authenticated;
grant execute on function public.sarraf_receipt_intake_begin_v2(text,text,text,text,text,text) to authenticated;
grant execute on function public.sarraf_receipt_submit(jsonb,text) to authenticated;
grant execute on function public.sarraf_receipt_review_command(text,text,jsonb,text,text) to authenticated;
grant execute on function public.sarraf_set_receipt_daily_rate(text,date,numeric,text,text) to authenticated;
grant execute on function public.sarraf_receipt_finalize_command(text,text,text) to authenticated;
grant execute on function public.sarraf_forward_receipts_v2(jsonb,text,text) to authenticated;
grant execute on function public.sarraf_receipt_mark_seen_v2(text) to authenticated;
grant execute on function public.sarraf_receipt_summary(text) to authenticated;
grant execute on function public.sarraf_my_receipt_intakes(integer) to authenticated;
grant execute on function public.sarraf_portal_receipt_summary_v2(integer) to authenticated;
grant execute on function public.sarraf_my_forwarded_receipts_v2(integer) to authenticated;

-- Supabase Storage is not present in the portable clean-schema verifier, so install these
-- policies conditionally. When present, the same canonical document that authorizes the read
-- model also authorizes a short-lived signed URL. Once claimed, an original cannot be updated or
-- deleted by its uploader.
do $storage_policies$
begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists receipt_storage_assurance_read on storage.objects';
    execute $policy$
      create policy receipt_storage_assurance_read on storage.objects
      as restrictive for select to authenticated using (
        bucket_id <> 'receipts' or (
          (owner_id=auth.uid()::text and name like 'ingest/%'
           and created_at>statement_timestamp()-interval '30 minutes')
          or public.is_admin()
          or exists(select 1 from public.receipt_documents d where d.storage_path=name and (
            d.uploader_id=public.my_app_id()
            or exists(select 1 from public.receipt_forwardings f
                      where f.document_id=d.id and f.to_actor_id=public.my_app_id())
          ))
          or exists(select 1 from public.receipts r where r.image_path=name and (
            r.partner_id=public.my_app_id()
            or exists(select 1 from public.receipt_custody c
                      where c.item_id=r.id and c.partner_id=public.my_app_id())
          ))
        )
      )
    $policy$;
    execute 'drop policy if exists receipt_storage_assurance_delete on storage.objects';
    execute $policy$
      create policy receipt_storage_assurance_delete on storage.objects
      as restrictive for delete to authenticated using (
        bucket_id <> 'receipts' or (
          owner_id=auth.uid()::text and name like 'ingest/%'
          and not exists(select 1 from public.receipt_intake_items i where i.image_path=name)
          and not exists(select 1 from public.receipts r where r.image_path=name)
          and not exists(select 1 from public.receipt_documents d where d.storage_path=name)
        )
      )
    $policy$;
    execute 'drop policy if exists receipt_storage_assurance_update on storage.objects';
    execute $policy$
      create policy receipt_storage_assurance_update on storage.objects
      as restrictive for update to authenticated using (
        bucket_id <> 'receipts' or (
          owner_id=auth.uid()::text and name like 'ingest/%'
          and not exists(select 1 from public.receipt_intake_items i where i.image_path=name)
          and not exists(select 1 from public.receipts r where r.image_path=name)
          and not exists(select 1 from public.receipt_documents d where d.storage_path=name)
        )
      ) with check (
        bucket_id <> 'receipts' or (
          owner_id=auth.uid()::text and name like 'ingest/%'
          and not exists(select 1 from public.receipt_intake_items i where i.image_path=name)
          and not exists(select 1 from public.receipts r where r.image_path=name)
          and not exists(select 1 from public.receipt_documents d where d.storage_path=name)
        )
      )
    $policy$;
  end if;
end;
$storage_policies$;

commit;
