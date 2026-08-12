-- Confirming that an office actually paid.
--
-- Found by walking §14's eighth business flow from end to end: "unpaid purchase → office
-- selector required → only the selected office sees the assignment → payment evidence → admin
-- confirm → debt/journal/status settle."
--
-- Every step but the last existed. The assignment could be created, acknowledged, initiated and
-- reported as paid; office_assignment_status even has a `confirmed` value. Nothing ever set it.
-- An office could report a payment and no one could accept the report, so the assignment stayed
-- open for ever and the money the office had laid out was never recognised as owed back to it.
--
-- The direction matters and is easy to get backwards. The office pays a supplier out of its own
-- funds on the house's behalf. What the house was going to pay it no longer has to pay, and what
-- it now owes the office it does. So the receivable the office was holding is cleared and the
-- payable to the office rises — no cash of the house's moves, because none did.
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
  perform public.sarraf_post_simple_entry(
    v_entry, current_date, 'office_payment_confirmed', v_actor.id,
    'acc-1300', 'acc-2200', v_a.currency, v_amount,
    public.sarraf_required_ratio(v_a.currency),
    format('پشتڕاستکردنەوەی پارەدانی نووسینگە — %s %s', v_amount, v_a.currency),
    coalesce(p_command_key,'') || ':confirm', 'office', v_a.office_id);

  v_voucher := public.sarraf_issue_voucher(
    'office_payment', 'office'::public.party_kind, v_a.office_id,
    'zeman'::public.party_kind, null, v_a.currency, v_amount,
    btrim(p_reason), v_actor.id, null, v_entry, null, v_a.transaction_id, p_command_key,
    jsonb_build_object('assignment_id', v_a.id, 'reported', v_a.amount_paid, 'assigned', v_a.amount));

  update public.office_payment_assignments
     set status = 'confirmed', confirmed_by = v_actor.id, confirmed_at = statement_timestamp(),
         version = version + 1
   where id = v_a.id;

  -- The transaction the assignment was standing in for is paid now.
  if v_a.transaction_id is not null then
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

-- The voucher belongs to the settlement that carries it, so the history can name it without
-- anyone reaching back into an append-only table to fill it in afterwards.
alter table public.debt_settlements add column if not exists voucher_id text references public.vouchers(id);

-- A netting is not a payment, and the history should not say it was.
--
-- The offset command writes a settlement row for each side, and the settlement trigger records
-- every settlement as 'settled'. The offset then recorded its own 'offset' events on top, so a
-- netted debt's history read "opened, settled, offset, settled" — the same event twice, once
-- under each name. The trigger now takes the name from what the settlement actually was.
create or replace function public.record_debt_settled()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  insert into public.debt_events(debt_id, kind, amount, outstanding_before, outstanding_after,
    currency, actor_id, reason, voucher_id, journal_entry_id, settlement_id, command_key)
  select new.debt_id,
         case when new.source_kind = 'offset' then 'offset'::public.debt_event_kind
              else 'settled'::public.debt_event_kind end,
         new.amount_applied, new.outstanding_before, new.outstanding_after,
         d.currency, new.actor_id, new.reason, new.voucher_id, new.journal_entry_id, new.id,
         new.command_key
  from public.debts d where d.id = new.debt_id;
  return new;
end;
$$;

-- With the trigger naming it, the offset command must not record it a second time.
create or replace function public.sarraf_offset_debts(
  p_left_debt_id text, p_right_debt_id text, p_amount numeric,
  p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb;
  v_left public.debts%rowtype; v_right public.debts%rowtype;
  v_amount numeric; v_entry text; v_voucher public.vouchers%rowtype; v_result jsonb;
  v_party public.party_kind; v_party_id text; v_accounts record;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='only an administrator may offset debts';
  end if;
  if char_length(btrim(coalesce(p_reason,''))) < 8 then
    raise exception using errcode='22023', message='an 8-character reason is required';
  end if;
  if p_left_debt_id is not distinct from p_right_debt_id then
    raise exception using errcode='22023', message='a debt cannot be offset against itself';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || coalesce(p_command_key,''), 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  if p_left_debt_id < p_right_debt_id then
    select * into v_left from public.debts where id = p_left_debt_id for update;
    select * into v_right from public.debts where id = p_right_debt_id for update;
  else
    select * into v_right from public.debts where id = p_right_debt_id for update;
    select * into v_left from public.debts where id = p_left_debt_id for update;
  end if;
  if v_left.id is null or v_right.id is null then
    raise exception using errcode='P0002', message='both debts must exist';
  end if;

  if v_left.currency <> v_right.currency then
    raise exception using errcode='22023',
      message=format('%s cannot be offset against %s — an offset is not a currency conversion',
                     v_left.currency, v_right.currency);
  end if;

  if not (v_left.debtor_type = v_right.creditor_type
      and v_left.debtor_id is not distinct from v_right.creditor_id
      and v_left.creditor_type = v_right.debtor_type
      and v_left.creditor_id is not distinct from v_right.debtor_id) then
    raise exception using errcode='22023',
      message='an offset requires two debts between the same two parties, facing opposite ways';
  end if;

  if v_left.status in ('settled','written_off','void') or v_right.status in ('settled','written_off','void') then
    raise exception using errcode='23514', message='a closed debt cannot be offset';
  end if;

  v_amount := least(v_left.outstanding_principal, v_right.outstanding_principal,
                    coalesce(nullif(p_amount, 0), least(v_left.outstanding_principal, v_right.outstanding_principal)));
  if v_amount is null or v_amount <= 0 then
    raise exception using errcode='22023', message='there is nothing to offset';
  end if;

  if v_left.debtor_type = 'zeman' then
    v_party := v_left.creditor_type; v_party_id := v_left.creditor_id;
  elsif v_left.creditor_type = 'zeman' then
    v_party := v_left.debtor_type; v_party_id := v_left.debtor_id;
  else
    raise exception using errcode='22023',
      message='an offset must be between ZEMAN and one other party';
  end if;

  select * into v_accounts from public.sarraf_debt_accounts(v_party);
  if not found then
    raise exception using errcode='22023',
      message=format('there is no debt account pair for a %s', v_party);
  end if;

  v_entry := 'je-offset-' || md5(v_actor.id || ':' || coalesce(p_command_key,'') || ':' || v_left.id || ':' || v_right.id);
  perform public.sarraf_post_simple_entry(
    v_entry, current_date, 'debt_offset', v_actor.id,
    v_accounts.payable, v_accounts.receivable,
    v_left.currency, v_amount, public.sarraf_required_ratio(v_left.currency),
    format('دانانەوەی دوولایەنە — %s %s', v_amount, v_left.currency),
    coalesce(p_command_key,'') || ':offset', v_party::text, v_party_id);

  v_voucher := public.sarraf_issue_voucher(
    'debt_offset', v_party, v_party_id, 'zeman'::public.party_kind, null,
    v_left.currency, v_amount, btrim(p_reason), v_actor.id,
    v_left.id, v_entry, null, null, p_command_key,
    jsonb_build_object('left_debt', v_left.id, 'right_debt', v_right.id));

  -- Each side is settled by the netting; the trigger records both, named 'offset' because that
  -- is what source_kind says they were.
  insert into public.debt_settlements(debt_id, amount_applied, outstanding_before, outstanding_after,
    source_kind, journal_entry_id, voucher_id, actor_id, command_key, reason)
  values (v_left.id, v_amount, v_left.outstanding_principal, v_left.outstanding_principal - v_amount,
          'offset', v_entry, v_voucher.id, v_actor.id, coalesce(p_command_key,'') || ':left', btrim(p_reason)),
         (v_right.id, v_amount, v_right.outstanding_principal, v_right.outstanding_principal - v_amount,
          'offset', v_entry, v_voucher.id, v_actor.id, coalesce(p_command_key,'') || ':right', btrim(p_reason));

  v_result := jsonb_build_object(
    'left_debt', v_left.id, 'right_debt', v_right.id, 'currency', v_left.currency,
    'offset_amount', v_amount,
    'left_outstanding_after', v_left.outstanding_principal - v_amount,
    'right_outstanding_after', v_right.outstanding_principal - v_amount,
    'voucher', v_voucher.reference, 'journal_entry_id', v_entry, 'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'offset_debts', v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_offset_debts(text,text,numeric,text,text) from public, anon;
grant execute on function public.sarraf_offset_debts(text,text,numeric,text,text) to authenticated;

commit;
