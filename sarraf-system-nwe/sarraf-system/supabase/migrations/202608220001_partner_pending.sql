-- Money reported to a partner's account, and not yet confirmed.
--
-- The previous migration gave partner_accounts a `pending` column and left it there: nothing
-- could put money into it and nothing could take money out. A column no command can reach is
-- not a feature, it is a promise on a schema diagram, and §13.D.1 asks for the state itself.
--
-- The shape mirrors the customer cashbox, which learned this in Phase 7. Reported money is
-- visible immediately — the partner said they sent it and wants to see that it registered — and
-- spendable by nobody until someone has checked it arrived.
--
-- Confirming hands the money to sarraf_partner_credit rather than adding it to the balance
-- directly, so §13.D.4 still holds: a credit settles the partner's outstanding debt in the same
-- currency first, and only the remainder becomes available balance. Writing that a second time
-- here is how the two would drift apart.
begin;

create or replace function public.sarraf_partner_pending_credit(
  p_partner_id text, p_currency text, p_amount numeric, p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_account public.partner_accounts%rowtype;
  v_cur text := upper(btrim(p_currency)); v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role not in ('admin', 'office') then
    raise exception using errcode='42501', message='reporting a partner credit is not authorized';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception using errcode='22023', message='amount must be greater than zero';
  end if;
  if char_length(btrim(coalesce(p_reason,''))) < 3 then
    raise exception using errcode='22023', message='a reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || coalesce(p_command_key,''), 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  select * into v_account from public.partner_accounts
   where partner_id = p_partner_id and currency = v_cur for update;
  if not found then
    insert into public.partner_accounts(id, partner_id, currency)
    values ('pa-' || md5(p_partner_id || ':' || v_cur), p_partner_id, v_cur)
    returning * into v_account;
  end if;

  update public.partner_accounts set pending = pending + p_amount where id = v_account.id;

  -- Nothing is posted. Unconfirmed money is not the house's money yet, and posting it would put
  -- an asset on the books for a payment that may never have happened.
  v_result := jsonb_build_object(
    'partner_id', p_partner_id, 'currency', v_cur, 'reported', p_amount,
    'pending', (select pending from public.partner_accounts where id = v_account.id),
    'posted', false, 'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'partner_pending_credit', v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_partner_pending_credit(text,text,numeric,text,text) from public, anon;
grant execute on function public.sarraf_partner_pending_credit(text,text,numeric,text,text) to authenticated;

create or replace function public.sarraf_partner_pending_resolve(
  p_partner_id text, p_currency text, p_amount numeric, p_confirm boolean,
  p_rate numeric, p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_account public.partner_accounts%rowtype;
  v_cur text := upper(btrim(p_currency)); v_credited jsonb; v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='only an administrator may confirm a partner credit';
  end if;
  if char_length(btrim(coalesce(p_reason,''))) < 3 then
    raise exception using errcode='22023', message='a reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || coalesce(p_command_key,''), 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  select * into v_account from public.partner_accounts
   where partner_id = p_partner_id and currency = v_cur for update;
  if not found then
    raise exception using errcode='22023', message='the partner has no account in this currency';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > v_account.pending then
    raise exception using errcode='23514',
      message=format('%s %s is pending; %s cannot be resolved',
                     v_account.pending, v_cur, coalesce(p_amount, 0));
  end if;

  update public.partner_accounts set pending = pending - p_amount where id = v_account.id;

  if coalesce(p_confirm, false) then
    -- Through the ordinary credit, so the debt-first waterfall of §13.D.4 applies to confirmed
    -- money exactly as it applies to money credited directly.
    v_credited := public.sarraf_partner_credit(
      p_partner_id, v_cur, p_amount,
      coalesce(p_rate, public.sarraf_required_ratio(v_cur)),
      left(btrim(p_reason), 700), coalesce(p_command_key, '') || ':confirm');
  end if;

  v_result := jsonb_build_object(
    'partner_id', p_partner_id, 'currency', v_cur, 'amount', p_amount,
    'confirmed', coalesce(p_confirm, false),
    'pending', (select pending from public.partner_accounts where id = v_account.id),
    'available', (select available from public.partner_accounts where id = v_account.id),
    'credit', v_credited, 'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'partner_pending_resolve', v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_partner_pending_resolve(text,text,numeric,boolean,numeric,text,text) from public, anon;
grant execute on function public.sarraf_partner_pending_resolve(text,text,numeric,boolean,numeric,text,text) to authenticated;

commit;
