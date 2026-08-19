-- What the manager's console reads and does.
--
-- The manager maintains the installation and sells it. They are not a party to any business's
-- trades, so this is the one place that looks across businesses — and everything in it is about
-- businesses, accounts and the health of the system rather than transactions, receipts or rates.
--
-- Every function refuses anybody who is not a manager, in the database, so a screen is not what
-- stands between a business owner and the list of their competitors.
begin;

-- ── the businesses ──────────────────────────────────────────────────────────
create or replace function public.sarraf_manager_tenants()
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare v_result jsonb;
begin
  if not public.sarraf_sees_all_tenants() then
    raise exception using errcode = '42501', message = 'only a manager may list the businesses';
  end if;

  select jsonb_build_object(
    'tenants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'active', t.active, 'note', t.note,
        'created_at', t.created_at,
        'accounts', (select count(*) from public.app_users u
                      where u.tenant_id = t.id and not u.deleted),
        'admins', (select count(*) from public.app_users u
                    where u.tenant_id = t.id and not u.deleted and u.role = 'admin'),
        -- What the business has actually done. Counts only: the manager has no business seeing
        -- another party's figures, and a count is enough to know whether a tenant is in use.
        'transactions', (select count(*) from public.txs x
                          where x.tenant_id = t.id and not x.deleted),
        'receipts', (select count(*) from public.receipts r where r.tenant_id = t.id),
        'last_activity', greatest(
          (select max(x.date) from public.txs x where x.tenant_id = t.id),
          (select max(r.created_at) from public.receipts r where r.tenant_id = t.id)))
        order by t.created_at)
      from public.tenants t), '[]'::jsonb),
    'total_accounts', (select count(*) from public.app_users where not deleted),
    'managers', (select count(*) from public.app_users
                  where role = 'admin' and admin_level = 'manager' and not deleted)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.sarraf_manager_tenants() from public, anon;
grant execute on function public.sarraf_manager_tenants() to authenticated;

-- ── creating one ────────────────────────────────────────────────────────────
--
-- The id is typed once and lives forever in every row the business owns, so it is checked here
-- rather than trusted: lower case, digits and dashes, nothing that would need quoting or read
-- differently in one place than another.
create or replace function public.sarraf_manager_create_tenant(
  p_id text, p_name text, p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.app_users%rowtype; v_id text := btrim(coalesce(p_id, ''));
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not public.sarraf_sees_all_tenants() then
    raise exception using errcode = '42501', message = 'only a manager may create a business';
  end if;
  -- Not lower-cased for the caller: an id that silently changes is a surprise every time
  -- somebody types it, and this one appears in every row the business will ever own.
  if v_id !~ '^[a-z0-9][a-z0-9-]{2,}$' then
    raise exception using errcode = '22023',
      message = 'a business id is lower-case letters, digits and dashes, at least three characters';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) < 2 then
    raise exception using errcode = '22023', message = 'a business needs a name';
  end if;
  if exists (select 1 from public.tenants where id = v_id) then
    raise exception using errcode = '23505', message = 'a business with that id already exists';
  end if;

  insert into public.tenants(id, name, note, created_by)
  values (v_id, btrim(p_name), nullif(btrim(coalesce(p_note, '')), ''), v_actor.id);

  -- The settings a business keeps for itself, copied from any existing business so a new one
  -- starts with the thresholds in use rather than with nothing.
  insert into public.control_settings
  select (jsonb_populate_record(null::public.control_settings,
            to_jsonb(c) || jsonb_build_object('tenant_id', v_id))).*
    from public.control_settings c limit 1;

  insert into public.receipt_control_policy
  select (jsonb_populate_record(null::public.receipt_control_policy,
            to_jsonb(r) || jsonb_build_object('tenant_id', v_id))).*
    from public.receipt_control_policy r limit 1;

  insert into public.audit(id, date, user_id, action, detail)
  values (gen_random_uuid()::text, statement_timestamp(), v_actor.id,
          'دروستکردنی سەرخێڵ', v_id || ' — ' || btrim(p_name));

  return jsonb_build_object('id', v_id, 'name', btrim(p_name), 'active', true);
end;
$$;

revoke all on function public.sarraf_manager_create_tenant(text, text, text) from public, anon;
grant execute on function public.sarraf_manager_create_tenant(text, text, text) to authenticated;

-- ── suspending one ──────────────────────────────────────────────────────────
--
-- Suspended, never deleted. A business that has stopped paying or stopped trading is not a
-- business whose books should be destroyed, and reversing a suspension is a switch where
-- reversing a deletion is a restore from backup.
create or replace function public.sarraf_manager_set_tenant_active(
  p_id text, p_active boolean, p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.app_users%rowtype; v_tenant public.tenants%rowtype;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not public.sarraf_sees_all_tenants() then
    raise exception using errcode = '42501', message = 'only a manager may suspend a business';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 4 then
    raise exception using errcode = '22023', message = 'a reason is required';
  end if;

  select * into v_tenant from public.tenants where id = p_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'no such business';
  end if;

  update public.tenants set active = coalesce(p_active, false) where id = p_id;

  insert into public.audit(id, date, user_id, action, detail)
  values (gen_random_uuid()::text, statement_timestamp(), v_actor.id,
          case when coalesce(p_active, false) then 'چالاککردنەوەی سەرخێڵ' else 'ڕاگرتنی سەرخێڵ' end,
          p_id || ' — ' || left(btrim(p_reason), 500));

  return jsonb_build_object('id', p_id, 'active', coalesce(p_active, false));
end;
$$;

revoke all on function public.sarraf_manager_set_tenant_active(text, boolean, text) from public, anon;
grant execute on function public.sarraf_manager_set_tenant_active(text, boolean, text) to authenticated;

-- ── every account, across every business ────────────────────────────────────
--
-- The one screen entitled to look across. The sign-in address is included because the manager is
-- the person who has to answer "which login is this?" when somebody cannot get in — and it is
-- the only thing here that is not already on a business's own screens.
create or replace function public.sarraf_manager_accounts()
returns table(
  id text, name text, role text, admin_level text,
  tenant_id text, tenant_name text, phone text, email text,
  deleted boolean, created_at timestamptz)
language plpgsql
security definer
stable
set search_path = pg_catalog, public, auth
as $$
begin
  if not public.sarraf_sees_all_tenants() then
    raise exception using errcode = '42501', message = 'only a manager may list every account';
  end if;

  return query
  select u.id, u.name, u.role, u.admin_level,
         u.tenant_id, t.name,
         u.phone,
         (select a.email::text from auth.users a where a.id = u.auth_id),
         u.deleted, u.created_at
  from public.app_users u
  left join public.tenants t on t.id = u.tenant_id
  order by
    case when u.admin_level = 'manager' then 0 else 1 end,
    t.name nulls first,
    case u.role when 'admin' then 0 when 'office' then 1 when 'partner' then 2
                when 'investor' then 3 else 4 end,
    u.name;
end;
$$;

revoke all on function public.sarraf_manager_accounts() from public, anon;
grant execute on function public.sarraf_manager_accounts() to authenticated;

commit;
