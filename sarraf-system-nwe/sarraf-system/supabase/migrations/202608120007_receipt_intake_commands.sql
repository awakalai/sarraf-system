-- Durable receipt intake (§5).
--
-- Today the browser reads a receipt first and only writes anything when the user presses send.
-- An OCR failure, a lost connection or a page reload between those two moments loses the
-- receipt entirely, and the customer is told the submission failed with nothing kept.
--
-- These commands invert that. The document row and its stored image come first; OCR is
-- something that happens to a receipt the server already holds. From 'uploaded' onwards a
-- failure can degrade the reading but can no longer lose the evidence.
--
-- receipt_documents is insert-protected from clients by design, so intake goes through
-- SECURITY DEFINER commands that re-check who may upload for the flow rather than trusting
-- the caller's claim about their own role.
begin;

-- Step 1: claim an intake slot and receive the exact storage path to upload to.
-- Called BEFORE the bytes are stored, so a crash mid-upload leaves a 'created' row that the
-- operator can see and clean up, rather than an orphaned object nobody knows about.
create or replace function public.sarraf_receipt_intake_begin(
  p_document_id text, p_flow public.receipt_flow, p_customer_id text, p_partner_id text,
  p_transaction_id text, p_batch_id text, p_expected_currency text, p_mime_type text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_path text;
  v_existing public.receipt_documents%rowtype;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then raise exception using errcode='42501', message='not authorized'; end if;
  if p_document_id !~ '^[A-Za-z0-9-]{6,128}$' then
    raise exception using errcode='22023', message='invalid document id';
  end if;
  if coalesce(p_mime_type,'') !~ '^image/(jpeg|png|webp|heic|heif)$' then
    raise exception using errcode='22023', message='unsupported image type';
  end if;

  -- Replay: the same id returns its existing slot instead of failing or duplicating.
  select * into v_existing from public.receipt_documents where id = p_document_id;
  if found then
    if v_existing.uploader_id <> v_actor.id then
      raise exception using errcode='42501', message='this intake belongs to another uploader';
    end if;
    return jsonb_build_object('document_id', v_existing.id, 'storage_path', v_existing.storage_path,
                              'state', v_existing.state, 'replayed', true);
  end if;

  v_path := format('ingest/%s/%s.jpg', coalesce(nullif(p_batch_id,''), 'solo'), p_document_id);

  -- The upload-permission trigger decides whether this actor may supply this flow at all.
  insert into public.receipt_documents(
    id, flow, state, batch_id, transaction_id, uploader_id, customer_id, partner_id,
    storage_path, expected_currency, mime_type)
  values (
    p_document_id, p_flow, 'created', nullif(p_batch_id,''), nullif(p_transaction_id,''),
    v_actor.id, nullif(p_customer_id,''), nullif(p_partner_id,''),
    v_path, nullif(upper(p_expected_currency),''), p_mime_type);

  update public.receipt_documents set state = 'uploading' where id = p_document_id;

  return jsonb_build_object('document_id', p_document_id, 'storage_path', v_path,
                            'state', 'uploading', 'replayed', false);
end;
$$;
revoke all on function public.sarraf_receipt_intake_begin(text,public.receipt_flow,text,text,text,text,text,text) from public, anon;
grant execute on function public.sarraf_receipt_intake_begin(text,public.receipt_flow,text,text,text,text,text,text) to authenticated;

-- Step 2: the bytes are stored. From here the receipt cannot be lost by a later failure.
create or replace function public.sarraf_receipt_intake_stored(
  p_document_id text, p_image_sha256 text, p_byte_size bigint
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.app_users%rowtype; v_doc public.receipt_documents%rowtype;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then raise exception using errcode='42501', message='not authorized'; end if;
  select * into v_doc from public.receipt_documents where id = p_document_id for update;
  if not found then raise exception using errcode='P0002', message='intake not found'; end if;
  if v_doc.uploader_id <> v_actor.id and v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='this intake belongs to another uploader';
  end if;
  if v_doc.state in ('uploaded','ocr_pending','ocr_processing','parsed') then
    return jsonb_build_object('document_id', v_doc.id, 'state', v_doc.state, 'replayed', true);
  end if;

  update public.receipt_documents
     set state = 'uploaded', image_sha256 = p_image_sha256, byte_size = p_byte_size
   where id = p_document_id;
  update public.receipt_documents set state = 'ocr_pending' where id = p_document_id;

  return jsonb_build_object('document_id', p_document_id, 'state', 'ocr_pending', 'replayed', false);
end;
$$;
revoke all on function public.sarraf_receipt_intake_stored(text,text,bigint) from public, anon;
grant execute on function public.sarraf_receipt_intake_stored(text,text,bigint) to authenticated;

-- Step 3: record what the reader produced, as version 1 — the original, never editable.
-- The uploader supplies the image; the SERVER decides what the numbers are, which is why
-- this writes an extraction rather than accepting fields on the document itself.
create or replace function public.sarraf_receipt_intake_extracted(
  p_document_id text, p_ok boolean, p_extraction jsonb, p_provider text, p_model text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_doc public.receipt_documents%rowtype;
  v_next public.receipt_state; v_currency text; v_expected text;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then raise exception using errcode='42501', message='not authorized'; end if;
  select * into v_doc from public.receipt_documents where id = p_document_id for update;
  if not found then raise exception using errcode='P0002', message='intake not found'; end if;
  if v_doc.uploader_id <> v_actor.id and v_actor.role not in ('admin','office') then
    raise exception using errcode='42501', message='this intake belongs to another uploader';
  end if;

  if v_doc.state = 'ocr_pending' then
    update public.receipt_documents set state = 'ocr_processing' where id = p_document_id;
  end if;

  update public.receipt_documents
     set ocr_attempts = ocr_attempts + 1, last_attempt_at = statement_timestamp()
   where id = p_document_id;

  if not coalesce(p_ok, false) then
    -- The read failed; the image stays exactly where it is and the receipt stays recoverable.
    update public.receipt_documents
       set state = 'ocr_failed_retryable',
           last_error_code = left(coalesce(p_extraction->>'error','ocr_failed'), 80)
     where id = p_document_id;
    return jsonb_build_object('document_id', p_document_id, 'state', 'ocr_failed_retryable');
  end if;

  insert into public.receipt_extractions(
    document_id, version, is_original, provider, model, raw,
    gross_amount, order_amount, fee_amount, fee_treatment, net_amount, currency,
    ref_no, merchant_order_no, payee, tx_date, tx_time, confidence)
  values (
    p_document_id, 1, true, left(p_provider,60), left(p_model,80), coalesce(p_extraction,'{}'::jsonb),
    nullif(p_extraction->>'grossAmount','')::numeric,
    nullif(p_extraction->>'orderAmount','')::numeric,
    nullif(p_extraction->>'feeAmount','')::numeric,
    nullif(p_extraction->>'feeTreatment',''),
    nullif(p_extraction->>'netAmount','')::numeric,
    nullif(upper(p_extraction->>'currency'),''),
    left(nullif(p_extraction->>'refNo',''),160),
    left(nullif(p_extraction->>'merchantOrderNo',''),160),
    left(nullif(p_extraction->>'payee',''),160),
    case when p_extraction->>'txDate' ~ '^\d{4}-\d{2}-\d{2}$' then (p_extraction->>'txDate')::date end,
    case when p_extraction->>'txTime' ~ '^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$' then (p_extraction->>'txTime')::time end,
    nullif(p_extraction->>'confidence','')::numeric)
  on conflict (document_id, version) do nothing;

  update public.receipt_documents set state = 'parsed' where id = p_document_id;

  -- The transaction's expected currency is authoritative; OCR may confirm it, never override.
  v_currency := nullif(upper(p_extraction->>'currency'),'');
  v_expected := v_doc.expected_currency;
  if v_expected is not null and v_currency is not null and v_currency <> v_expected then
    update public.receipt_documents
       set state = 'currency_mismatch',
           rule_code = 'currency_mismatch',
           rule_reason = format('فیشەکە بە %s خوێندرایەوە بەڵام مامەڵەکە %s ـە', v_currency, v_expected)
     where id = p_document_id;
    return jsonb_build_object('document_id', p_document_id, 'state', 'currency_mismatch');
  end if;

  -- Anything the reader was unsure of goes to a human rather than straight through.
  v_next := case
    when coalesce(nullif(p_extraction->>'confidence','')::numeric, 0) < 0.72 then 'needs_manual_review'
    when v_currency is null then 'needs_manual_review'
    when nullif(p_extraction->>'grossAmount','') is null then 'needs_manual_review'
    else 'validated'
  end;
  update public.receipt_documents set state = v_next where id = p_document_id;

  return jsonb_build_object('document_id', p_document_id, 'state', v_next);
end;
$$;
revoke all on function public.sarraf_receipt_intake_extracted(text,boolean,jsonb,text,text) from public, anon;
grant execute on function public.sarraf_receipt_intake_extracted(text,boolean,jsonb,text,text) to authenticated;

-- What an uploader may see about their own receipts: status, never internal detail.
create or replace function public.sarraf_my_receipt_intakes(p_limit integer default 50)
returns table(id text, state public.receipt_state, flow public.receipt_flow,
              received_at timestamptz, ocr_attempts integer, rule_reason text)
language sql security definer stable
set search_path = pg_catalog, public
as $$
  select d.id, d.state, d.flow, d.received_at, d.ocr_attempts, d.rule_reason
  from public.receipt_documents d
  where d.uploader_id = public.my_app_id()
  order by d.received_at desc
  limit least(greatest(coalesce(p_limit,50),1),200);
$$;
revoke all on function public.sarraf_my_receipt_intakes(integer) from public, anon;
grant execute on function public.sarraf_my_receipt_intakes(integer) to authenticated;

commit;
