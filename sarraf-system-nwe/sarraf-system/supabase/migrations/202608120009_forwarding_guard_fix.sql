-- Fix: the empty-selection guard in sarraf_forward_receipts never fired.
--
-- The check was written as:
--
--   jsonb_array_length(p_document_ids) between 1 and 0
--
-- which asks for a length that is both >= 1 and <= 0 — no value satisfies it, so the guard was
-- always false. A command with an empty selection passed validation, forwarded nothing, and
-- still recorded itself in accounting_commands as a completed operation. That command key is
-- then burnt: a retry with the same key replays the empty result instead of forwarding, and the
-- operator is told the work succeeded when nothing was sent.
--
-- Only the guard changes. The rest of the function is reproduced unchanged because a function
-- body cannot be patched in place.
begin;

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
  -- An empty or non-array selection is refused before a command key can be spent on it.
  if p_document_ids is null or jsonb_typeof(p_document_ids) <> 'array'
     or jsonb_array_length(p_document_ids) < 1 then
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

commit;
