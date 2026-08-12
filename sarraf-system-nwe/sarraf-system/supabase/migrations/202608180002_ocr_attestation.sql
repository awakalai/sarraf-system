-- What the reader read, attested by the server, and unrepeatable.
--
-- The owner's report, back in the first round: "there must not be an edit — the details of the
-- images must not be changed. 1200 came to me, the image says so. How can they edit it and make
-- it more?" The edit control was removed from the uploader's screen. That is a screen, and a
-- screen is not a control: the extraction still travelled from the browser to the ingestion
-- command as ordinary JSON, so anything that could reach the network could change 1200 into
-- 12000 and the database would have believed it.
--
-- So the reading is attested where it happens. The OCR route, having authenticated the user,
-- records what it read: a nonce, the hash of the image it read, and the digest of the figures it
-- extracted. The browser never sees a secret and cannot mint one of these rows. When the batch
-- arrives, the digest is recomputed from the figures actually submitted; if they were altered on
-- the way, the two digests differ and the batch is refused.
--
-- The nonce is redeemed exactly once, so the same reading cannot be presented for two receipts.
begin;

create table if not exists public.ocr_attestations (
  nonce text primary key,
  issued_to text not null references public.app_users(id),
  image_sha256 text not null,
  -- The digest of the figures the reader produced, computed by sarraf_extraction_digest below.
  extraction_digest text not null,
  provider text,
  model text,
  issued_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  redeemed_receipt_id text,
  check (nonce ~ '^[A-Za-z0-9_-]{24,128}$'),
  check (image_sha256 ~ '^[a-f0-9]{64}$'),
  check (extraction_digest ~ '^[a-f0-9]{64}$'),
  check (expires_at > issued_at)
);
create index if not exists ocr_att_user_idx on public.ocr_attestations(issued_to, issued_at desc);
create index if not exists ocr_att_open_idx on public.ocr_attestations(expires_at) where redeemed_at is null;

alter table public.ocr_attestations enable row level security;
revoke all on public.ocr_attestations from public, anon, authenticated;

create or replace function public.protect_ocr_attestations()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception using errcode = '42501',
    message = 'an attestation is written once by the reader and never altered';
end;
$$;
drop trigger if exists ocr_attestations_immutable on public.ocr_attestations;
create trigger ocr_attestations_immutable
  before delete on public.ocr_attestations
  for each row execute function public.protect_ocr_attestations();

-- The canonical shape of a reading: the fields that carry money or identify the payment, in a
-- fixed order, with nothing else. Both the reader and this database compute it the same way, so
-- a difference between the two digests means the figures changed in between and nothing else.
--
-- Amounts are normalised to a plain decimal so that 1200, 1200.0 and "1200.00" are one number
-- and not three. Text is trimmed but never case-folded — a payee's name is part of the reading.
create or replace function public.sarraf_extraction_digest(p_extraction jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select encode(sha256(convert_to(concat_ws('|',
    coalesce(trim_scale(nullif(p_extraction->>'amount','')::numeric)::text, ''),
    coalesce(trim_scale(nullif(p_extraction->>'fee','')::numeric)::text, ''),
    coalesce(trim_scale(nullif(p_extraction->>'net_amount','')::numeric)::text, ''),
    upper(coalesce(btrim(p_extraction->>'currency'), '')),
    coalesce(btrim(p_extraction->>'ref_no'), ''),
    coalesce(btrim(p_extraction->>'merchant_order_no'), ''),
    coalesce(btrim(p_extraction->>'tx_date'), ''),
    coalesce(btrim(p_extraction->>'receiver'), ''),
    coalesce(btrim(p_extraction->>'sender'), '')
  ), 'UTF8')), 'hex');
$$;

-- Written by the OCR route, which reaches the database with the service key. No signed-in user
-- can call it, so no browser can attest to its own arithmetic.
create or replace function public.sarraf_record_ocr_attestation(
  p_nonce text, p_issued_to text, p_image_sha256 text, p_extraction jsonb,
  p_provider text default null, p_model text default null, p_ttl_seconds int default 3600
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_digest text;
begin
  v_digest := public.sarraf_extraction_digest(p_extraction);
  insert into public.ocr_attestations(
    nonce, issued_to, image_sha256, extraction_digest, provider, model, expires_at)
  values (p_nonce, p_issued_to, lower(btrim(p_image_sha256)), v_digest,
          left(p_provider, 60), left(p_model, 120),
          statement_timestamp() + make_interval(secs => greatest(60, least(coalesce(p_ttl_seconds, 3600), 86400))));
  return jsonb_build_object('nonce', p_nonce, 'extraction_digest', v_digest);
end;
$$;
revoke all on function public.sarraf_record_ocr_attestation(text,text,text,jsonb,text,text,int)
  from public, anon, authenticated;

-- Redeem one, against the figures actually being submitted. Everything that can be wrong is
-- named, because "invalid" tells an operator nothing about what to do next.
create or replace function public.sarraf_redeem_ocr_attestation(
  p_nonce text, p_actor_id text, p_image_sha256 text, p_extraction jsonb, p_receipt_id text
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_att public.ocr_attestations%rowtype; v_digest text;
begin
  select * into v_att from public.ocr_attestations where nonce = p_nonce for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'this reading was not issued by the receipt reader';
  end if;
  if v_att.redeemed_at is not null then
    raise exception using errcode = '42501',
      message = 'this reading has already been used for another receipt';
  end if;
  if v_att.expires_at < statement_timestamp() then
    raise exception using errcode = '42501',
      message = 'this reading has expired — read the image again';
  end if;
  if v_att.issued_to is distinct from p_actor_id then
    raise exception using errcode = '42501',
      message = 'this reading belongs to someone else';
  end if;
  if v_att.image_sha256 is distinct from lower(btrim(p_image_sha256)) then
    raise exception using errcode = '42501',
      message = 'this reading is of a different image';
  end if;

  v_digest := public.sarraf_extraction_digest(p_extraction);
  if v_att.extraction_digest is distinct from v_digest then
    raise exception using errcode = '42501',
      message = 'the figures do not match what the reader read from this image';
  end if;

  update public.ocr_attestations
     set redeemed_at = statement_timestamp(), redeemed_receipt_id = p_receipt_id
   where nonce = p_nonce;
end;
$$;
revoke all on function public.sarraf_redeem_ocr_attestation(text,text,text,jsonb,text) from public, anon;
grant execute on function public.sarraf_redeem_ocr_attestation(text,text,text,jsonb,text) to authenticated;

-- Whether an unattested receipt may be ingested at all.
--
-- Off to begin with, deliberately: switching it on before every client in the field is sending
-- attestations would stop the business from taking receipts, which is a worse failure than the
-- one it prevents. A *mismatched* attestation is refused whether this is on or off — that is
-- tampering, and there is no reading of it that is acceptable.
alter table public.receipt_control_policy
  add column if not exists require_attestation boolean not null default false;

comment on column public.receipt_control_policy.require_attestation is
  'When true, a receipt with no reader attestation is refused. A mismatched attestation is always refused.';

-- Checked as the row is written, so it applies to every path into public.receipts rather than to
-- the one command that happens to be the current way in.
create or replace function public.sarraf_verify_receipt_attestation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_att jsonb := new.raw->'attestation';
  v_require boolean;
  v_actor text;
begin
  -- Only rows that will count towards money. A rejected or duplicate row is evidence of what
  -- was attempted; its figures are often absent and it enters no total.
  if coalesce(new.status, '') <> 'ok' or not coalesce(new.counted, true) then
    return new;
  end if;

  select require_attestation into v_require from public.receipt_control_policy where singleton;

  if v_att is null or jsonb_typeof(v_att) <> 'object' or nullif(btrim(v_att->>'nonce'), '') is null then
    if coalesce(v_require, false) then
      raise exception using errcode = '42501',
        message = 'this receipt carries no reading from the receipt reader';
    end if;
    return new;
  end if;

  select id into v_actor from public.app_users where auth_id = auth.uid() and not deleted;

  perform public.sarraf_redeem_ocr_attestation(
    v_att->>'nonce',
    coalesce(new.uploaded_by, v_actor),
    v_att->>'imageSha256',
    jsonb_build_object(
      'amount', new.amount, 'fee', new.fee, 'net_amount', new.net_amount,
      'currency', new.currency, 'ref_no', new.ref_no,
      'merchant_order_no', new.merchant_order_no,
      'tx_date', new.tx_date, 'receiver', new.receiver, 'sender', new.sender),
    new.id);
  return new;
end;
$$;
drop trigger if exists receipts_verify_attestation on public.receipts;
create trigger receipts_verify_attestation
  before insert on public.receipts
  for each row execute function public.sarraf_verify_receipt_attestation();

commit;
