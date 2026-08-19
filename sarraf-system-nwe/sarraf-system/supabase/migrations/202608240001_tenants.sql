-- One application, several businesses, and no way for either to see the other.
--
-- The owner maintains this system and sells it. Today one exchange runs on it; tomorrow another
-- buyer runs their own on the same installation, with their own staff and their own customers.
-- Neither may see a single row of the other's, and neither should ever have to trust that they
-- cannot — the database must make it impossible rather than the screens make it unlikely.
--
-- A tenant is a business. Every row that belongs to a business carries its tenant, and row-level
-- security compares that to the tenant of whoever is asking. The manager belongs to no tenant
-- and sees all of them, because the manager is the person the businesses bought the software
-- from rather than a party to any of their trades.
--
-- This file introduces the tenant and attaches it to people. The business tables follow in
-- 202608240002, separately, because a column added to sixty tables and a policy written for each
-- are two different kinds of change and reviewing them together hides both.
begin;

create table if not exists public.tenants (
  id text primary key,
  name text not null,
  -- The business's own reference for itself: a licence number, a shop name, whatever they use.
  reference text,
  active boolean not null default true,
  created_at timestamptz not null default statement_timestamp(),
  created_by text references public.app_users(id),
  note text
);

comment on table public.tenants is
  'One business running on this installation. Every row of business data belongs to exactly one.';

-- ── which business a person belongs to ──────────────────────────────────────
--
-- Null means the manager: somebody who belongs to no business and can see every one. Every other
-- account must name a tenant, and the guard below refuses one that does not.
alter table public.app_users add column if not exists tenant_id text references public.tenants(id);

create index if not exists idx_app_users_tenant on public.app_users(tenant_id);

comment on column public.app_users.tenant_id is
  'The business this account belongs to. Null only for a manager, who belongs to none and sees all.';

-- ── the caller's tenant ─────────────────────────────────────────────────────
--
-- SECURITY DEFINER and STABLE: every policy in the next migration calls it once per statement,
-- and it must read app_users without the caller needing rights on that table.
create or replace function public.sarraf_tenant()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select tenant_id from public.app_users where auth_id = auth.uid() and not deleted;
$$;

-- A manager sees across businesses. Nobody else ever does, whatever their rank inside one:
-- an owner is the top of their own business and no part of anybody else's.
create or replace function public.sarraf_sees_all_tenants()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce((
    select u.role = 'admin' and u.admin_level = 'manager'
    from public.app_users u where u.auth_id = auth.uid() and not deleted), false);
$$;

-- The one expression every policy uses. Written once so that a policy cannot get it subtly
-- wrong — the usual mistake being to forget that a null tenant on the row must not match a null
-- tenant on the caller, because two unknowns are not the same business.
create or replace function public.sarraf_tenant_visible(p_tenant text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.sarraf_sees_all_tenants()
      or (p_tenant is not null and p_tenant = public.sarraf_tenant());
$$;

grant execute on function public.sarraf_tenant() to authenticated;
grant execute on function public.sarraf_sees_all_tenants() to authenticated;
grant execute on function public.sarraf_tenant_visible(text) to authenticated;

-- ── every account except a manager belongs to a business ────────────────────
create or replace function public.sarraf_guard_tenant_membership()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_level text := new.admin_level;
begin
  if v_level = 'manager' then
    if new.tenant_id is not null then
      raise exception using errcode = '23514',
        message = 'a manager belongs to no single business';
    end if;
    return new;
  end if;

  if new.tenant_id is null then
    raise exception using errcode = '23502',
      message = 'every account except a manager must belong to a business';
  end if;

  -- Nobody moves an account between businesses. Its transactions, receipts and debts stay where
  -- they were made, and an account that walked away from them would be a person with a history
  -- that is no longer theirs.
  if tg_op = 'UPDATE' and old.tenant_id is not null
     and new.tenant_id is distinct from old.tenant_id then
    raise exception using errcode = '42501',
      message = 'an account cannot be moved to another business';
  end if;

  return new;
end;
$$;

-- Deliberately not installed yet. The existing rows have no tenant, and a guard that refuses
-- them would lock everyone out before 202608240003 has given them one. The trigger is created
-- there, once the data satisfies it.

-- ── the tenants table protects itself ───────────────────────────────────────
alter table public.tenants enable row level security;
revoke all on public.tenants from public, anon, authenticated;
grant select on public.tenants to authenticated;

drop policy if exists tenants_manager_all on public.tenants;
create policy tenants_manager_all on public.tenants for all to authenticated
  using (public.sarraf_sees_all_tenants())
  with check (public.sarraf_sees_all_tenants());

-- A business may read its own row and no other. It cannot change it: the name a business trades
-- under is part of what it bought, not something it edits.
drop policy if exists tenants_own_read on public.tenants;
create policy tenants_own_read on public.tenants for select to authenticated
  using (id = public.sarraf_tenant());

commit;
