-- A rate is a price, not a definition. Two businesses do not quote the same one.
--
-- currencies.rate is one number per currency for the whole installation. What USD and CNY *are*
-- is shared and should be; what a yuan is worth today is each exchange's own judgement, and
-- letting one business set the number the other values its inventory by is the plainest possible
-- leak between them — not of a row somebody could notice, but of the figure every total on their
-- screen is computed from.
--
-- tenant_rates holds a rate per business per currency. currencies.rate stays where it is and
-- becomes the fallback: a business that has not set its own yet reads the installation's, which
-- is what keeps today's single business working unchanged from the moment this runs.
--
-- Every reader goes through sarraf_usd_value, so that is the only function that has to know. It
-- keeps its signature, so the twenty-five call sites are untouched and none of them can be the
-- one that was forgotten.
begin;

create table if not exists public.tenant_rates (
  tenant_id text not null references public.tenants(id) on delete cascade,
  cur_id text not null references public.currencies(id),
  -- One ratio, as Phase 2 established: 1 USD = rate × currency.
  rate numeric(20,8) not null check (rate > 0),
  updated_at timestamptz not null default statement_timestamp(),
  updated_by text references public.app_users(id),
  primary key (tenant_id, cur_id)
);

comment on table public.tenant_rates is
  'What one business says a currency is worth. Falls back to currencies.rate where unset.';

alter table public.tenant_rates enable row level security;
revoke all on public.tenant_rates from public, anon, authenticated;
grant select on public.tenant_rates to authenticated;

drop policy if exists tenant_rates_tenant on public.tenant_rates;
create policy tenant_rates_tenant on public.tenant_rates for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

-- ── the one reader ──────────────────────────────────────────────────────────
--
-- Same name, same arguments, same contract: null when the currency cannot be valued, because a
-- caller must be told that rather than handed a number nobody entered.
create or replace function public.sarraf_usd_value(p_amount numeric, p_cur_id text)
returns numeric
language plpgsql stable
security definer
set search_path = pg_catalog, public
as $$
declare v_rate numeric; v_tenant text;
begin
  if p_amount is null then return null; end if;
  if lower(p_cur_id) = 'usd' then return round(p_amount, 10); end if;

  v_tenant := public.sarraf_tenant();
  if v_tenant is not null then
    select r.rate into v_rate from public.tenant_rates r
     where r.tenant_id = v_tenant and r.cur_id = p_cur_id;
  end if;

  -- The installation's rate, for a business that has not set its own and for the manager, who
  -- belongs to no business and so has no rate of their own to read.
  if v_rate is null then
    select c.rate into v_rate from public.currencies c where c.id = p_cur_id;
  end if;

  if v_rate is null or v_rate <= 0 then return null; end if;
  return round(p_amount / v_rate, 10);
end;
$$;

grant execute on function public.sarraf_usd_value(numeric, text) to authenticated;

-- ── setting a business's own rate ───────────────────────────────────────────
--
-- Ordinary administrators of a business set that business's rates. Nobody sets another's, and
-- the policy above would refuse it even if a caller tried, so this command only has to check
-- that the caller is entitled to set a rate at all.
create or replace function public.sarraf_set_tenant_rate(
  p_cur_id text, p_rate numeric, p_command_key text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.app_users%rowtype; v_tenant text;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode = '42501', message = 'only an administrator may set a rate';
  end if;

  v_tenant := v_actor.tenant_id;
  if v_tenant is null then
    raise exception using errcode = '22023',
      message = 'a manager has no business of their own to set a rate for';
  end if;
  if p_rate is null or p_rate <= 0 then
    raise exception using errcode = '22023', message = 'a ratio must be greater than zero';
  end if;
  if not exists (select 1 from public.currencies where id = p_cur_id) then
    raise exception using errcode = '22023', message = 'unknown currency';
  end if;

  insert into public.tenant_rates(tenant_id, cur_id, rate, updated_by)
  values (v_tenant, p_cur_id, p_rate, v_actor.id)
  on conflict (tenant_id, cur_id) do update
    set rate = excluded.rate, updated_at = statement_timestamp(), updated_by = excluded.updated_by;

  return jsonb_build_object('tenant_id', v_tenant, 'cur_id', p_cur_id, 'rate', p_rate);
end;
$$;

revoke all on function public.sarraf_set_tenant_rate(text, numeric, text) from public, anon;
grant execute on function public.sarraf_set_tenant_rate(text, numeric, text) to authenticated;

-- ── a notification belongs to the person it is for ──────────────────────────
--
-- notes rows are written by triggers, and a trigger firing inside a SECURITY DEFINER command has
-- no caller of its own to read a tenant from. The default therefore leaves them ownerless, and
-- an ownerless notification is one nobody can ever see.
--
-- The recipient is right there in the row. Taking the tenant from them is both correct and the
-- only answer that does not depend on who happened to be signed in when the trigger ran.
create or replace function public.sarraf_note_tenant()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.tenant_id is null and new.user_id is not null then
    select u.tenant_id into new.tenant_id from public.app_users u where u.id = new.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists notes_tenant on public.notes;
create trigger notes_tenant before insert on public.notes
  for each row execute function public.sarraf_note_tenant();

commit;
