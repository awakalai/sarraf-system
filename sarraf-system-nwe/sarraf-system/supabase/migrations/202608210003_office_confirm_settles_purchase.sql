-- Confirming an office payment could not complete the purchase it paid for.
--
-- `transaction cannot complete without a posted settlement entry`.
--
-- The completion guard on public.txs looks for a posted journal entry that names the
-- transaction and carries source_type 'transaction_settlement'. The office confirmation posted
-- one named 'office_payment_confirmed' with no transaction against it at all, so the guard found
-- nothing and refused the status change. The office's money moved and the purchase it paid for
-- stayed pending — which is the one thing the whole assignment exists to end.
--
-- Where the assignment stands in for a purchase, confirming it *is* that purchase being paid:
-- the payable falls and cash leaves. The entry now says so, and a transaction_payment_event
-- records it, because a reader that finds a transaction complete with no event against it cannot
-- say what paid it.
--
-- A standalone assignment with no transaction behind it still settles the office's own account
-- as before. There is no transaction for a guard to protect, and nothing about that case changes.
begin;

create or replace function public.sarraf_office_payment_confirm(
  p_assignment_id text, p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_a public.office_payment_assignments%rowtype;
  v_entry text; v_voucher public.vouchers%rowtype; v_result jsonb; v_amount numeric;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='only an administrator may confirm an office payment';
  end if;
  if char_length(btrim(coalesce(p_reason,''))) < 3 then
    raise exception using errcode='22023', message='a reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || coalesce(p_command_key,''), 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  select * into v_a from public.office_payment_assignments where id = p_assignment_id for update;
  if not found then raise exception using errcode='P0002', message='assignment not found'; end if;
  if v_a.status = 'confirmed' then
    return jsonb_build_object('assignment_id', v_a.id, 'status', 'confirmed', 'replayed', true);
  end if;

  -- Only a payment the office has actually reported can be confirmed. Confirming an assignment
  -- nobody has paid would put money on the books that never left anywhere.
  if v_a.status <> 'paid_reported' then
    raise exception using errcode='22023',
      message=format('the office has not reported a payment yet (the assignment is %s)', v_a.status);
  end if;
  v_amount := coalesce(nullif(v_a.amount_paid, 0), v_a.amount);
  if v_amount is null or v_amount <= 0 then
    raise exception using errcode='22023', message='there is no reported amount to confirm';
  end if;

  -- The person who reports and the person who confirms are different by construction: an office
  -- cannot reach this command at all. The check stands anyway, in case an administrator is ever
  -- also the assigned office.
  if v_actor.id = v_a.office_id then
    raise exception using errcode='42501', message='an office cannot confirm its own payment';
  end if;

  v_entry := 'je-office-confirm-' || md5(v_actor.id || ':' || coalesce(p_command_key,'') || ':' || v_a.id);

  -- Where the assignment stands in for a purchase, confirming it *is* that purchase being paid:
  -- the payable goes down and cash goes out. The entry must say so — it carries the transaction
  -- and the source type the completion guard looks for — or the guard refuses to let the
  -- transaction complete and the office's payment settles nothing.
  --
  -- A standalone assignment, with no transaction behind it, settles the office's own account
  -- instead, and there is no transaction for a guard to protect.
  if v_a.transaction_id is not null then
    perform public.sarraf_post_simple_entry(
      v_entry, current_date, 'transaction_settlement', v_actor.id,
      'acc-2300', 'acc-1000', v_a.currency, v_amount,
      public.sarraf_required_ratio(v_a.currency),
      format('پشتڕاستکردنەوەی پارەدانی نووسینگە — %s %s', v_amount, v_a.currency),
      coalesce(p_command_key,'') || ':confirm', 'office', v_a.office_id,
      v_a.transaction_id, current_date);
  else
    perform public.sarraf_post_simple_entry(
      v_entry, current_date, 'office_payment_confirmed', v_actor.id,
      'acc-1300', 'acc-2200', v_a.currency, v_amount,
      public.sarraf_required_ratio(v_a.currency),
      format('پشتڕاستکردنەوەی پارەدانی نووسینگە — %s %s', v_amount, v_a.currency),
      coalesce(p_command_key,'') || ':confirm', 'office', v_a.office_id);
  end if;

  v_voucher := public.sarraf_issue_voucher(
    'office_payment', 'office'::public.party_kind, v_a.office_id,
    'zeman'::public.party_kind, null, v_a.currency, v_amount,
    btrim(p_reason), v_actor.id, null, v_entry, null, v_a.transaction_id, p_command_key,
    jsonb_build_object('assignment_id', v_a.id, 'reported', v_a.amount_paid, 'assigned', v_a.amount));

  update public.office_payment_assignments
     set status = 'confirmed', confirmed_by = v_actor.id, confirmed_at = statement_timestamp(),
         version = version + 1
   where id = v_a.id;

  -- The transaction the assignment was standing in for is paid now. The payment event is
  -- written first: it is the record that this settlement happened, and a reader that finds the
  -- transaction complete with no event against it cannot say what paid it.
  if v_a.transaction_id is not null then
    insert into public.transaction_payment_events(
      transaction_id, event_kind, amount, currency, journal_entry_id,
      office_assignment_id, actor_id, reason, command_key)
    values (v_a.transaction_id, 'settled', v_amount, v_a.currency, v_entry,
            v_a.id, v_actor.id, left(btrim(p_reason), 700), p_command_key)
    on conflict (actor_id, command_key) do nothing;

    update public.txs set status = 'completed', paid_at = coalesce(paid_at, statement_timestamp())
     where id = v_a.transaction_id and not deleted and status = 'pending';
  end if;

  v_result := jsonb_build_object(
    'assignment_id', v_a.id, 'office_id', v_a.office_id, 'currency', v_a.currency,
    'confirmed_amount', v_amount, 'status', 'confirmed',
    'voucher', v_voucher.reference, 'journal_entry_id', v_entry,
    'transaction_id', v_a.transaction_id, 'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'office_payment_confirm', v_result);
  return v_result;
end;
$$;

revoke all on function public.sarraf_office_payment_confirm(text,text,text) from public, anon;
grant execute on function public.sarraf_office_payment_confirm(text,text,text) to authenticated;

commit;
