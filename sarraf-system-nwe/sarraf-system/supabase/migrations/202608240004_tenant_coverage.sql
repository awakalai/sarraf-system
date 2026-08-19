-- Proving no table was left shared.
--
-- A table missed by 202608240002 is a table two businesses read from each other without either
-- knowing. It is the single worst outcome of this whole change, and it is silent — nothing
-- fails, nothing is logged, the wrong rows simply appear on somebody's screen one day.
--
-- So the coverage is a thing that can be asked rather than assumed. The function below names
-- every table in public that holds no tenant, or holds one and does not enforce it, and the
-- short list of tables for which that is correct is written down here with the reason.
begin;

create or replace function public.sarraf_tenant_coverage()
returns table(table_name text, problem text)
language sql
stable
set search_path = pg_catalog, public
as $$
  with shared(t, why) as (values
    -- The list of businesses itself. Its own policies decide who sees which row.
    ('tenants', 'the register of businesses'),
    -- Carries tenant_id as a membership rather than as data, and is filtered by it.
    ('app_users', 'people, filtered by their own tenant_id'),
    -- Definitions, not data: what USD and CNY are. Rates are per business and live elsewhere.
    ('currencies', 'currency definitions shared by every business'),
    -- The account codes every set of books is kept in. Shared so a report means the same thing
    -- whoever runs it.
    ('chart_of_accounts', 'the shared chart of accounts')
  ), live as (
    select c.table_name::text as t
    from information_schema.tables c
    where c.table_schema = 'public' and c.table_type = 'BASE TABLE'
  ), has_column as (
    select l.t, exists (
      select 1 from information_schema.columns k
       where k.table_schema = 'public' and k.table_name = l.t and k.column_name = 'tenant_id'
    ) as tenanted,
    (select relrowsecurity from pg_class where oid = ('public.' || quote_ident(l.t))::regclass) as rls,
    (select count(*) from pg_policies p
      where p.schemaname = 'public' and p.tablename = l.t) as policies
    from live l
  )
  select h.t, 'holds no tenant_id'
  from has_column h
  where not h.tenanted and not exists (select 1 from shared s where s.t = h.t)
  union all
  select h.t, 'has a tenant_id but row-level security is off'
  from has_column h
  where h.tenanted and not coalesce(h.rls, false)
  union all
  select h.t, 'has a tenant_id and row-level security but no policy'
  from has_column h
  where h.tenanted and coalesce(h.rls, false) and h.policies = 0
  order by 2, 1;
$$;

grant execute on function public.sarraf_tenant_coverage() to authenticated;

-- ── rows that belong to nobody ──────────────────────────────────────────────
--
-- A tenant_id left null is invisible to every business and visible to the manager alone. That is
-- the safe direction to fail in, but it is still a row nobody can act on, so it is counted
-- rather than left to be discovered.
create or replace function public.sarraf_tenant_orphans()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  r record;
  v_out jsonb := '{}'::jsonb;
  v_count bigint;
begin
  if not public.sarraf_sees_all_tenants() then
    raise exception using errcode = '42501', message = 'only a manager may audit tenancy';
  end if;

  for r in
    select k.table_name::text as t
    from information_schema.columns k
    where k.table_schema = 'public' and k.column_name = 'tenant_id'
      and k.table_name <> 'app_users'
    order by 1
  loop
    execute format('select count(*) from public.%I where tenant_id is null', r.t) into v_count;
    if v_count > 0 then
      v_out := v_out || jsonb_build_object(r.t, v_count);
    end if;
  end loop;

  return jsonb_build_object('orphans', v_out, 'checked_at', statement_timestamp());
end;
$$;

revoke all on function public.sarraf_tenant_orphans() from public, anon;
grant execute on function public.sarraf_tenant_orphans() to authenticated;

commit;
