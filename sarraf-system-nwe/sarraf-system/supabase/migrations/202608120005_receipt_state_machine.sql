-- Receipt state machine, custody and forwarding.
--
-- §2 names the two business flows explicitly, because "in/out" and "buy/sell" do not say who
-- may upload what:
--
--   customer_sells_to_zeman   the customer uploads their own sale receipts.
--   customer_buys_from_zeman  only the ASSIGNED partner uploads; the customer never does.
--
-- §7 requires one state machine shared by UI, API and database, with transitions that are
-- checked rather than assumed. §5 requires the image to be durable BEFORE OCR, so a failed
-- read can never lose a receipt. §13/§2 require that an uploader can never author the
-- extracted values — only staff may correct them, and only as a new version that keeps the
-- original readable.
begin;

do $$ begin
  create type public.receipt_flow as enum ('customer_sells_to_zeman','customer_buys_from_zeman');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.receipt_state as enum (
    'created','uploading','uploaded','ocr_pending','ocr_processing','parsed',
    'needs_manual_review','validated','submitted','matched','accepted','rejected',
    'finalized','forwarded','delivered','seen',
    'upload_failed_retryable','ocr_failed_retryable','failed_terminal',
    'duplicate','currency_mismatch','tamper_suspected','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.delivery_status as enum ('queued','sent','delivered','seen','failed_retryable','failed_terminal');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Durable intake: the row exists as soon as the image is stored, before any OCR.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.receipt_documents (
  id text primary key,
  flow public.receipt_flow not null,
  state public.receipt_state not null default 'created',
  batch_id text,
  transaction_id text,
  -- Who legitimately supplies this document, decided by the flow, not by the client.
  uploader_id text not null references public.app_users(id),
  customer_id text references public.app_users(id),
  partner_id text references public.app_users(id),
  -- Evidence.
  storage_path text not null,
  image_sha256 text,
  byte_size bigint,
  mime_type text,
  -- Server-side expectation the OCR must confirm and may never override.
  expected_currency text,
  received_at timestamptz not null default statement_timestamp(),
  ocr_attempts integer not null default 0,
  last_attempt_at timestamptz,
  last_error_code text,
  counted boolean not null default false,
  rule_code text,
  rule_reason text,
  created_at timestamptz not null default statement_timestamp(),
  check (image_sha256 is null or image_sha256 ~ '^[a-f0-9]{64}$'),
  check (expected_currency is null or expected_currency ~ '^[A-Z]{3,8}$'),
  check (byte_size is null or (byte_size > 0 and byte_size <= 20971520)),
  -- A counted document must have passed review; a rejected one must say why.
  check (not counted or state in ('accepted','finalized','forwarded','delivered','seen')),
  check (state <> 'rejected' or (rule_code is not null and rule_reason is not null))
);
create index if not exists rd_state_idx on public.receipt_documents(state, received_at desc);
create index if not exists rd_batch_idx on public.receipt_documents(batch_id);
create index if not exists rd_uploader_idx on public.receipt_documents(uploader_id, received_at desc);
create index if not exists rd_customer_idx on public.receipt_documents(customer_id) where customer_id is not null;
create index if not exists rd_partner_idx on public.receipt_documents(partner_id) where partner_id is not null;
-- One accepted document per image, enforced by the database rather than by a client check.
create unique index if not exists rd_hash_uq on public.receipt_documents(image_sha256)
  where image_sha256 is not null and counted;

-- ─────────────────────────────────────────────────────────────────────────────
-- Extractions are versioned and immutable. A correction is a NEW version; the original
-- reading stays readable forever.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.receipt_extractions (
  id bigint generated always as identity primary key,
  document_id text not null references public.receipt_documents(id),
  version integer not null,
  is_original boolean not null default false,
  provider text,
  model text,
  ocr_version text,
  raw jsonb not null default '{}'::jsonb,
  gross_amount numeric(38,10),
  order_amount numeric(38,10),
  fee_amount numeric(38,10),
  fee_treatment text,
  net_amount numeric(38,10),
  currency text,
  ref_no text,
  merchant_order_no text,
  payee text,
  tx_date date,
  tx_time time,
  confidence numeric(5,4),
  -- Only set on a correction.
  corrected_by text references public.app_users(id),
  correction_reason text,
  corrected_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  unique (document_id, version),
  check (jsonb_typeof(raw) = 'object'),
  check (currency is null or currency ~ '^[A-Z]{3,8}$'),
  check (fee_treatment is null or fee_treatment in
    ('added_on_top','deducted_from_principal','included_in_total','no_fee','unknown')),
  -- A correction must name who made it and why; an original must not pretend to be one.
  check (is_original or (corrected_by is not null and char_length(coalesce(correction_reason,'')) >= 8))
);
create index if not exists re_doc_idx on public.receipt_extractions(document_id, version desc);

create or replace function public.protect_receipt_extractions()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception using errcode='42501',
    message='receipt extractions are immutable; record a correction as a new version';
end;
$$;
drop trigger if exists receipt_extractions_immutable on public.receipt_extractions;
create trigger receipt_extractions_immutable before update or delete on public.receipt_extractions
  for each row execute function public.protect_receipt_extractions();

-- ─────────────────────────────────────────────────────────────────────────────
-- Transitions: recorded, and checked against an explicit table of what may follow what.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.receipt_state_transitions (
  id bigint generated always as identity primary key,
  document_id text not null references public.receipt_documents(id),
  from_state public.receipt_state,
  to_state public.receipt_state not null,
  actor_id text references public.app_users(id),
  reason text,
  command_key text,
  request_id text,
  created_at timestamptz not null default statement_timestamp()
);
create index if not exists rst_doc_idx on public.receipt_state_transitions(document_id, created_at);

create or replace function public.receipt_transition_allowed(
  p_from public.receipt_state, p_to public.receipt_state
) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select case
    -- Terminal states accept nothing further.
    when p_from in ('seen','failed_terminal','cancelled') then false
    when p_from is null then p_to = 'created'
    when p_from = 'created' then p_to in ('uploading','cancelled')
    when p_from = 'uploading' then p_to in ('uploaded','upload_failed_retryable','cancelled')
    when p_from = 'upload_failed_retryable' then p_to in ('uploading','failed_terminal','cancelled')
    -- The image is durable from here on; a failure can no longer lose it.
    when p_from = 'uploaded' then p_to in ('ocr_pending','needs_manual_review','cancelled')
    when p_from = 'ocr_pending' then p_to in ('ocr_processing','ocr_failed_retryable','needs_manual_review')
    when p_from = 'ocr_processing' then p_to in
      ('parsed','ocr_failed_retryable','needs_manual_review','duplicate','currency_mismatch','tamper_suspected')
    when p_from = 'ocr_failed_retryable' then p_to in ('ocr_pending','needs_manual_review','failed_terminal')
    when p_from = 'parsed' then p_to in
      ('validated','needs_manual_review','duplicate','currency_mismatch','tamper_suspected')
    when p_from = 'needs_manual_review' then p_to in ('validated','rejected','duplicate','currency_mismatch','tamper_suspected')
    when p_from in ('duplicate','currency_mismatch','tamper_suspected') then p_to in ('needs_manual_review','rejected')
    when p_from = 'validated' then p_to in ('submitted','needs_manual_review','rejected')
    when p_from = 'submitted' then p_to in ('matched','accepted','rejected','needs_manual_review')
    when p_from = 'matched' then p_to in ('accepted','rejected')
    when p_from = 'accepted' then p_to in ('finalized','rejected')
    when p_from = 'finalized' then p_to = 'forwarded'
    -- A failed delivery is tracked on receipt_forwardings.delivery_status, not by moving the
    -- document backwards: the receipt is still forwarded, the channel is what failed.
    when p_from = 'forwarded' then p_to in ('delivered','seen')
    when p_from = 'delivered' then p_to = 'seen'
    when p_from = 'rejected' then p_to = 'needs_manual_review'  -- reopen, audited
    else false
  end;
$$;

-- Validation runs BEFORE the write; the transition is logged AFTER it, because
-- receipt_state_transitions.document_id references a row that does not exist yet during
-- a BEFORE INSERT trigger.
create or replace function public.enforce_receipt_transition()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'created' then
      raise exception using errcode='23514',
        message=format('a receipt document must start at created, not %s', new.state);
    end if;
    return new;
  end if;

  if new.state is distinct from old.state
     and not public.receipt_transition_allowed(old.state, new.state) then
    raise exception using errcode='23514',
      message=format('receipt %s cannot move from %s to %s', old.id, old.state, new.state);
  end if;

  -- Evidence is written once. Re-pointing a stored object would invalidate every attestation.
  if new.storage_path is distinct from old.storage_path
     or (old.image_sha256 is not null and new.image_sha256 is distinct from old.image_sha256) then
    raise exception using errcode='42501',
      message=format('the stored evidence for receipt %s is immutable', old.id);
  end if;
  if new.flow is distinct from old.flow or new.uploader_id is distinct from old.uploader_id then
    raise exception using errcode='42501',
      message=format('the flow and uploader of receipt %s are immutable', old.id);
  end if;
  return new;
end;
$$;
drop trigger if exists receipt_documents_transition on public.receipt_documents;
create trigger receipt_documents_transition
  before insert or update on public.receipt_documents
  for each row execute function public.enforce_receipt_transition();

create or replace function public.log_receipt_transition()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.receipt_state_transitions(document_id, from_state, to_state, actor_id)
    values (new.id, null, new.state, new.uploader_id);
  elsif new.state is distinct from old.state then
    insert into public.receipt_state_transitions(document_id, from_state, to_state, actor_id)
    values (new.id, old.state, new.state, public.my_app_id());
  end if;
  return null;
end;
$$;
drop trigger if exists receipt_documents_transition_log on public.receipt_documents;
create trigger receipt_documents_transition_log
  after insert or update on public.receipt_documents
  for each row execute function public.log_receipt_transition();

-- ─────────────────────────────────────────────────────────────────────────────
-- Custody and forwarding (§8)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.receipt_forwardings (
  id text primary key,
  document_id text not null references public.receipt_documents(id),
  batch_id text,
  transaction_id text,
  from_actor_type public.party_kind not null,
  from_actor_id text,
  to_actor_type public.party_kind not null,
  to_actor_id text not null references public.app_users(id),
  delivery_channel text not null default 'in_app',
  delivery_status public.delivery_status not null default 'queued',
  forwarded_by text not null references public.app_users(id),
  forwarded_at timestamptz not null default statement_timestamp(),
  delivered_at timestamptz,
  seen_at timestamptz,
  last_error_code text,
  retry_count integer not null default 0,
  version bigint not null default 1,
  command_key text,
  -- One live forwarding per document per recipient; a retry updates it, never duplicates it.
  unique (document_id, to_actor_id)
);
create index if not exists rf_to_idx on public.receipt_forwardings(to_actor_id, delivery_status);
create index if not exists rf_doc_idx on public.receipt_forwardings(document_id);

-- Only an accepted or finalized document may be forwarded. §8.5 is explicit that pending,
-- duplicate and rejected receipts must never reach a portal.
create or replace function public.enforce_forwardable_document()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare v_state public.receipt_state;
begin
  select state into v_state from public.receipt_documents where id = new.document_id;
  if v_state is null then
    raise exception using errcode='23503', message='unknown receipt document';
  end if;
  if v_state not in ('accepted','finalized','forwarded','delivered','seen') then
    raise exception using errcode='23514',
      message=format('receipt %s is %s and cannot be forwarded', new.document_id, v_state);
  end if;
  return new;
end;
$$;
drop trigger if exists receipt_forwarding_guard on public.receipt_forwardings;
create trigger receipt_forwarding_guard before insert on public.receipt_forwardings
  for each row execute function public.enforce_forwardable_document();

create table if not exists public.receipt_custody_ledger (
  id bigint generated always as identity primary key,
  document_id text not null references public.receipt_documents(id),
  from_partner_id text references public.app_users(id),
  to_partner_id text references public.app_users(id),
  transaction_id text,
  reason text not null,
  actor_id text not null references public.app_users(id),
  command_key text,
  created_at timestamptz not null default statement_timestamp(),
  check (char_length(reason) between 8 and 700)
);
create index if not exists rcl_doc_idx on public.receipt_custody_ledger(document_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Who may upload what (§2 permission matrix), decided by the database.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.receipt_upload_allowed(
  p_flow public.receipt_flow, p_role text, p_actor_id text,
  p_customer_id text, p_partner_id text
) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select case
    when p_role = 'admin' then true
    -- A customer uploads only their own sale receipts.
    when p_flow = 'customer_sells_to_zeman' then p_role = 'customer' and p_actor_id = p_customer_id
    -- A purchase is evidenced by the ASSIGNED partner; the customer never uploads here.
    when p_flow = 'customer_buys_from_zeman' then p_role = 'partner' and p_actor_id = p_partner_id
    else false
  end;
$$;

create or replace function public.enforce_receipt_upload_permission()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare v_role text;
begin
  select role into v_role from public.app_users where id = new.uploader_id and not deleted;
  if v_role is null then
    raise exception using errcode='23503', message='unknown uploader';
  end if;
  if not public.receipt_upload_allowed(new.flow, v_role, new.uploader_id, new.customer_id, new.partner_id) then
    raise exception using errcode='42501',
      message=format('a %s may not upload a %s receipt', v_role, new.flow);
  end if;
  return new;
end;
$$;
drop trigger if exists receipt_upload_permission on public.receipt_documents;
create trigger receipt_upload_permission before insert on public.receipt_documents
  for each row execute function public.enforce_receipt_upload_permission();

-- ─────────────────────────────────────────────────────────────────────────────
-- Security
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.receipt_documents enable row level security;
alter table public.receipt_extractions enable row level security;
alter table public.receipt_state_transitions enable row level security;
alter table public.receipt_forwardings enable row level security;
alter table public.receipt_custody_ledger enable row level security;

revoke all on public.receipt_documents, public.receipt_extractions,
  public.receipt_state_transitions, public.receipt_forwardings, public.receipt_custody_ledger
  from public, anon, authenticated;
grant select on public.receipt_documents, public.receipt_state_transitions,
  public.receipt_forwardings to authenticated;
-- Raw extractions and custody history are staff-only: they carry bank detail and internal notes.
grant select on public.receipt_extractions, public.receipt_custody_ledger to authenticated;

drop policy if exists rd_staff_read on public.receipt_documents;
create policy rd_staff_read on public.receipt_documents for select to authenticated
  using (public.is_admin() or public.my_role() = 'office');
drop policy if exists rd_uploader_read on public.receipt_documents;
create policy rd_uploader_read on public.receipt_documents for select to authenticated
  using (uploader_id = public.my_app_id());
-- A party sees a document only once it has actually been forwarded to them.
drop policy if exists rd_forwarded_read on public.receipt_documents;
create policy rd_forwarded_read on public.receipt_documents for select to authenticated
  using (exists (select 1 from public.receipt_forwardings f
                 where f.document_id = receipt_documents.id
                   and f.to_actor_id = public.my_app_id()));

drop policy if exists re_staff_read on public.receipt_extractions;
create policy re_staff_read on public.receipt_extractions for select to authenticated
  using (public.is_admin() or public.my_role() = 'office');

drop policy if exists rst_staff_read on public.receipt_state_transitions;
create policy rst_staff_read on public.receipt_state_transitions for select to authenticated
  using (public.is_admin() or public.my_role() = 'office');
drop policy if exists rst_own_read on public.receipt_state_transitions;
create policy rst_own_read on public.receipt_state_transitions for select to authenticated
  using (exists (select 1 from public.receipt_documents d
                 where d.id = receipt_state_transitions.document_id
                   and d.uploader_id = public.my_app_id()));

drop policy if exists rf_staff_read on public.receipt_forwardings;
create policy rf_staff_read on public.receipt_forwardings for select to authenticated
  using (public.is_admin() or public.my_role() = 'office');
drop policy if exists rf_recipient_read on public.receipt_forwardings;
create policy rf_recipient_read on public.receipt_forwardings for select to authenticated
  using (to_actor_id = public.my_app_id());

drop policy if exists rcl_staff_read on public.receipt_custody_ledger;
create policy rcl_staff_read on public.receipt_custody_ledger for select to authenticated
  using (public.is_admin() or public.my_role() = 'office');

commit;
