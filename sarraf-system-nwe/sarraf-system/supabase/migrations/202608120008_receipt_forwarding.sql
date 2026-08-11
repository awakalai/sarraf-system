-- Receipt forwarding and custody (§8).
--
-- Phase 4 created the tables and the rule that only an accepted or finalized document may be
-- forwarded. Nothing could actually forward one. These are the commands that complete the
-- lifecycle: accepted → finalized → forwarded → delivered → seen.
--
-- The two flows send the evidence in opposite directions, which is why the recipient is
-- derived from the flow rather than supplied by the caller:
--
--   customer_sells_to_zeman   the customer's own receipts move into the custody of the
--                             partner who will hold the currency.
--   customer_buys_from_zeman  the assigned partner's payment evidence is published to the
--                             customer who bought.
--
-- §8.10 forbids long-lived public URLs, so nothing here mints one: forwarding records who may
-- see a document, and the reader still fetches a short-lived signed URL at view time.
begin;

-- Forward a set of accepted receipts to the party the flow says should receive them.
create or replace function public.sarraf_forward_receipts(
  p_document_ids jsonb, p_to_actor_id text, p_transaction_id text,
  p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_to public.app_users%rowtype;
  v_doc public.receipt_documents%rowtype; d text;
  v_forwarded int := 0; v_skipped jsonb := '[]'::jsonb; v_result jsonb;
  v_to_kind public.party_kind;
begin
  select * into v_actor from public.app_users where auth.uid() = auth_id and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='only an administrator may forward receipts';
  end if;
  if jsonb_typeof(p_document_ids) <> 'array' or jsonb_array_length(p_document_ids) between 1 and 0 then
    raise exception using errcode='22023', message='no receipts selected';
  end if;
  if jsonb_array_length(p_document_ids) > 100 then
    raise exception using errcode='22023', message='too many receipts in one command';
  end if;
  if char_length(btrim(coalesce(p_reason,''))) < 8 then
    raise exception using errcode='22023', message='an 8-character reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || p_command_key, 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  select * into v_to from public.app_users where id = p_to_actor_id and not deleted;
  if not found then raise exception using errcode='22023', message='unknown recipient'; end if;
  if v_to.role not in ('customer','partner') then
    raise exception using errcode='22023', message='receipts are forwarded to a customer or a partner';
  end if;
  v_to_kind := v_to.role::public.party_kind;

  for d in select jsonb_array_elements_text(p_document_ids) loop
    select * into v_doc from public.receipt_documents where id = d for update;
    if not found then
      v_skipped := v_skipped || jsonb_build_object('id', d, 'reason', 'not_found');
      continue;
    end if;
    -- §8.5: only accepted or finalized receipts may leave. Pending, duplicate, rejected and
    -- tampered evidence must never reach a portal, so they are skipped and named rather than
    -- failing the whole command.
    if v_doc.state not in ('accepted','finalized') then
      v_skipped := v_skipped || jsonb_build_object('id', d, 'reason', v_doc.state);
      continue;
    end if;
    -- The recipient must be the one this flow actually sends to.
    if v_doc.flow = 'customer_sells_to_zeman' and v_to.role <> 'partner' then
      v_skipped := v_skipped || jsonb_build_object('id', d, 'reason', 'recipient_must_be_partner');
      continue;
    end if;
    if v_doc.flow = 'customer_buys_from_zeman' and v_to.role <> 'customer' then
      v_skipped := v_skipped || jsonb_build_object('id', d, 'reason', 'recipient_must_be_customer');
      continue;
    end if;

    if v_doc.state = 'accepted' then
      update public.receipt_documents set state = 'finalized' where id = d;
    end if;

    insert into public.receipt_forwardings(
      id, document_id, batch_id, transaction_id, from_actor_type, from_actor_id,
      to_actor_type, to_actor_id, delivery_channel, delivery_status, forwarded_by, command_key)
    values ('fwd-' || md5(d || ':' || p_to_actor_id), d, v_doc.batch_id,
            coalesce(nullif(p_transaction_id,''), v_doc.transaction_id),
            'zeman', null, v_to_kind, p_to_actor_id, 'in_app', 'sent', v_actor.id, p_command_key)
    on conflict (document_id, to_actor_id) do update
      set delivery_status = 'sent', version = public.receipt_forwardings.version + 1,
          forwarded_at = statement_timestamp();

    update public.receipt_documents set state = 'forwarded' where id = d;

    -- Custody moves with the evidence when a partner takes the currency.
    if v_to.role = 'partner' then
      insert into public.receipt_custody_ledger(
        document_id, from_partner_id, to_partner_id, transaction_id, reason, actor_id, command_key)
      values (d, v_doc.partner_id, p_to_actor_id,
              coalesce(nullif(p_transaction_id,''), v_doc.transaction_id),
              left(btrim(p_reason),700), v_actor.id, p_command_key);
      update public.receipt_documents set partner_id = p_to_actor_id where id = d;
    end if;

    v_forwarded := v_forwarded + 1;
  end loop;

  v_result := jsonb_build_object(
    'forwarded', v_forwarded, 'skipped', v_skipped,
    'to_actor_id', p_to_actor_id, 'to_role', v_to.role, 'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'forward_receipts', v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_forward_receipts(jsonb,text,text,text,text) from public, anon;
grant execute on function public.sarraf_forward_receipts(jsonb,text,text,text,text) to authenticated;

-- Delivery is recorded when the recipient's portal actually renders the document, and seen
-- only on an explicit acknowledgement. §7 forbids treating a fire-and-forget send as delivery.
create or replace function public.sarraf_receipt_mark_delivered(p_document_id text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_me text; v_row public.receipt_forwardings%rowtype;
begin
  v_me := public.my_app_id();
  if v_me is null then raise exception using errcode='42501', message='not authorized'; end if;
  select * into v_row from public.receipt_forwardings
   where document_id = p_document_id and to_actor_id = v_me for update;
  if not found then
    raise exception using errcode='42501', message='this receipt was not forwarded to you';
  end if;
  if v_row.delivery_status in ('queued','sent') then
    update public.receipt_forwardings
       set delivery_status = 'delivered', delivered_at = statement_timestamp()
     where document_id = p_document_id and to_actor_id = v_me;
    update public.receipt_documents set state = 'delivered'
     where id = p_document_id and state = 'forwarded';
  end if;
  return jsonb_build_object('document_id', p_document_id, 'delivery_status', 'delivered');
end;
$$;
revoke all on function public.sarraf_receipt_mark_delivered(text) from public, anon;
grant execute on function public.sarraf_receipt_mark_delivered(text) to authenticated;

create or replace function public.sarraf_receipt_mark_seen(p_document_id text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_me text;
begin
  v_me := public.my_app_id();
  if v_me is null then raise exception using errcode='42501', message='not authorized'; end if;
  if not exists (select 1 from public.receipt_forwardings
                  where document_id = p_document_id and to_actor_id = v_me) then
    raise exception using errcode='42501', message='this receipt was not forwarded to you';
  end if;
  update public.receipt_forwardings
     set delivery_status = 'seen', seen_at = coalesce(seen_at, statement_timestamp()),
         delivered_at = coalesce(delivered_at, statement_timestamp())
   where document_id = p_document_id and to_actor_id = v_me;
  update public.receipt_documents set state = 'seen'
   where id = p_document_id and state in ('forwarded','delivered');
  return jsonb_build_object('document_id', p_document_id, 'delivery_status', 'seen');
end;
$$;
revoke all on function public.sarraf_receipt_mark_seen(text) from public, anon;
grant execute on function public.sarraf_receipt_mark_seen(text) to authenticated;

-- What a recipient may see: their own forwarded documents and the figures, never the internal
-- review trail, the raw OCR payload, or anyone else's receipts.
create or replace function public.sarraf_my_forwarded_receipts(p_limit integer default 100)
returns table(
  document_id text, delivery_status public.delivery_status, forwarded_at timestamptz,
  seen_at timestamptz, storage_path text, currency text,
  gross_amount numeric, fee_amount numeric, net_amount numeric,
  ref_no text, tx_date date, transaction_id text)
language sql security definer stable
set search_path = pg_catalog, public
as $$
  select f.document_id, f.delivery_status, f.forwarded_at, f.seen_at,
         d.storage_path, e.currency, e.gross_amount, e.fee_amount, e.net_amount,
         e.ref_no, e.tx_date, f.transaction_id
  from public.receipt_forwardings f
  join public.receipt_documents d on d.id = f.document_id
  left join lateral (
    select * from public.receipt_extractions x
     where x.document_id = d.id order by x.version desc limit 1
  ) e on true
  where f.to_actor_id = public.my_app_id()
  order by f.forwarded_at desc
  limit least(greatest(coalesce(p_limit,100),1),300);
$$;
revoke all on function public.sarraf_my_forwarded_receipts(integer) from public, anon;
grant execute on function public.sarraf_my_forwarded_receipts(integer) to authenticated;

-- §8.12: sent, delivered and seen are different things and must reconcile separately.
create or replace function public.sarraf_forwarding_reconciliation()
returns jsonb
language sql security definer stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'forwarded', count(*),
    'sent',      count(*) filter (where delivery_status = 'sent'),
    'delivered', count(*) filter (where delivery_status in ('delivered','seen')),
    'seen',      count(*) filter (where delivery_status = 'seen'),
    'failed',    count(*) filter (where delivery_status in ('failed_retryable','failed_terminal')),
    'checked_at', statement_timestamp())
  from public.receipt_forwardings;
$$;
revoke all on function public.sarraf_forwarding_reconciliation() from public, anon;
grant execute on function public.sarraf_forwarding_reconciliation() to authenticated;

commit;
