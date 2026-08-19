-- The same receipt, recorded twice, with nothing saying so.
--
-- Two paths write a receipt into this database and neither knows about the other:
--
--   the document path  — receipt_documents + receipt_extractions, written when an image is
--                        uploaded and read
--   the batch path     — receipts + receipt_batches, written when the uploader presses send
--
-- Both are live, and no column ties one to the other. A photographed receipt therefore exists
-- twice, and nothing in the schema can state that the two rows are the same piece of paper. The
-- duplicate check reads one side; the totals read the other; a new rule has to be written twice
-- and the two drift apart the first time somebody forgets.
--
-- This adds the missing link and nothing else. No row is moved, no path is retired, no screen
-- changes. The column is nullable because most receipts have no document — they were typed, not
-- photographed — and a receipt without one is not incomplete.
--
-- Retiring one of the two paths is a larger decision with a real cost, and it belongs to the
-- owner rather than to a migration. CLEANUP.md sets out the options. What follows is what can
-- be done safely first: making the relationship expressible, so that whichever path is kept, the
-- other's rows can be found rather than guessed at.
begin;

alter table public.receipts
  add column if not exists document_id text references public.receipt_documents(id);

-- One document is the source of at most one receipt row. Two receipts claiming the same document
-- is precisely the double-count this column exists to make impossible.
create unique index if not exists receipts_document_unique
  on public.receipts (document_id)
  where document_id is not null;

comment on column public.receipts.document_id is
  'The uploaded image this row was read from, when there was one. Null for a receipt entered by hand.';

-- ── the two sides of a receipt, in one answer ───────────────────────────────
--
-- Given either id, say what is known from both. A reviewer holding a receipt row can reach the
-- original image and the reading it came from; a reviewer holding a document can reach the row
-- that counts towards a total.
--
-- Reading only. It states what the link says and invents nothing where the link is absent: a
-- receipt with no document reports `linked: false` rather than a guess at which document might
-- have been meant.
create or replace function public.sarraf_receipt_both_sides(
  p_receipt_id text default null, p_document_id text default null
) returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_receipt public.receipts%rowtype;
  v_document public.receipt_documents%rowtype;
  v_extraction public.receipt_extractions%rowtype;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then
    raise exception using errcode = '42501', message = 'receipt lookup is not authorized';
  end if;

  if p_receipt_id is not null then
    select * into v_receipt from public.receipts where id = p_receipt_id;
    if found and v_receipt.document_id is not null then
      select * into v_document from public.receipt_documents where id = v_receipt.document_id;
    end if;
  elsif p_document_id is not null then
    select * into v_document from public.receipt_documents where id = p_document_id;
    select * into v_receipt from public.receipts where document_id = p_document_id;
  else
    raise exception using errcode = '22023', message = 'a receipt or a document is required';
  end if;

  if v_receipt.id is null and v_document.id is null then
    raise exception using errcode = 'P0002', message = 'neither a receipt nor a document was found';
  end if;

  -- Ownership, not role. Whoever the evidence belongs to may read it back, and staff always may.
  if v_actor.role not in ('admin', 'office')
     and v_actor.id is distinct from v_receipt.uploaded_by
     and v_actor.id is distinct from v_receipt.customer_id
     and v_actor.id is distinct from v_receipt.partner_id
     and v_actor.id is distinct from v_document.uploader_id
     and v_actor.id is distinct from v_document.customer_id
     and v_actor.id is distinct from v_document.partner_id then
    raise exception using errcode = '42501', message = 'this receipt is not yours';
  end if;

  if v_document.id is not null then
    select * into v_extraction from public.receipt_extractions
     where document_id = v_document.id order by version desc limit 1;
  end if;

  return jsonb_build_object(
    'linked', v_receipt.id is not null and v_document.id is not null,
    'receipt', case when v_receipt.id is null then null else jsonb_build_object(
      'id', v_receipt.id, 'batch_id', v_receipt.batch_id, 'currency', v_receipt.currency,
      'amount', v_receipt.amount, 'fee', v_receipt.fee, 'net_amount', v_receipt.net_amount,
      'receiver', public.sarraf_payee_name(v_receipt.receiver, v_receipt.raw, v_receipt.sender),
      'tx_date', v_receipt.tx_date, 'platform', v_receipt.platform,
      'ref_no', v_receipt.ref_no, 'status', v_receipt.status, 'counted', v_receipt.counted) end,
    'document', case when v_document.id is null then null else jsonb_build_object(
      'id', v_document.id, 'state', v_document.state, 'flow', v_document.flow,
      'storage_path', v_document.storage_path, 'image_sha256', v_document.image_sha256) end,
    'extraction', case when v_extraction.id is null then null else jsonb_build_object(
      'version', v_extraction.version, 'payee', v_extraction.payee,
      'tx_date', v_extraction.tx_date, 'platform', v_extraction.platform,
      'has_fee', v_extraction.has_fee, 'currency', v_extraction.currency,
      'gross_amount', v_extraction.gross_amount, 'fee_amount', v_extraction.fee_amount,
      'net_amount', v_extraction.net_amount) end);
end;
$$;

revoke all on function public.sarraf_receipt_both_sides(text, text) from public, anon;
grant execute on function public.sarraf_receipt_both_sides(text, text) to authenticated;

-- ── how many are still unlinked ─────────────────────────────────────────────
--
-- The number that says whether the duplication is shrinking. It is expected to be large today:
-- nothing has ever filled the column in. It is here so the answer is a figure rather than an
-- impression, before and after whatever is decided about the two paths.
create or replace function public.sarraf_receipt_link_gap()
returns jsonb
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'receipts', (select count(*) from public.receipts),
    'receipts_linked', (select count(*) from public.receipts where document_id is not null),
    'documents', (select count(*) from public.receipt_documents),
    'documents_linked', (select count(distinct document_id) from public.receipts
                          where document_id is not null),
    'documents_orphaned', (select count(*) from public.receipt_documents d
                            where not exists (select 1 from public.receipts r
                                               where r.document_id = d.id)));
$$;

grant execute on function public.sarraf_receipt_link_gap() to authenticated;

commit;
