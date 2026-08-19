-- Three levels of administrator, and the two bugs that stopped any of them being created.
--
-- The owner asked for a rank above the business owner:
--
--   ماناجەر   the person who built and maintains the system. Sees everything, resets any
--             password, and answers to nobody inside the application.
--   سەرخێڵ    the business owner who bought it and runs the exchange.
--   ئەدمین    the owner's staff, who do the day's work.
--
-- Only the middle two existed, as admin_level 'owner' and 'operator'. Two faults meant neither
-- could actually be created:
--
--   api/admin-user.js writes admin_level 'admin' for every new administrator, and the column is
--   checked against ('owner','operator'). Every attempt was refused by the database.
--
--   Creating an administrator requires an existing owner. With no owner in the table there was
--   no one who could make the first one — which is what the owner met as "an admin has to
--   approve it".
--
-- The new rank is a level rather than a role. role stays 'admin', so every one of the several
-- hundred `role = 'admin'` checks in this schema keeps working unchanged and a manager inherits
-- everything an administrator can do. Adding a fourth role would have meant auditing all of them
-- to find the ones that must now say 'admin or manager', and the first one missed would be a
-- silent hole.
begin;

-- ── the rank ────────────────────────────────────────────────────────────────
alter table public.app_users drop constraint if exists app_users_admin_level_check;
alter table public.app_users
  add constraint app_users_admin_level_check
  check (admin_level is null or admin_level in ('manager', 'owner', 'operator'));

-- Administrators created before this migration have no level, which reads as the least. They are
-- promoted deliberately, by a manager, and not by a migration guessing.
update public.app_users
   set admin_level = 'operator'
 where role = 'admin' and admin_level is null;

-- Rows written by the API with the rejected value never landed, but a database that received one
-- some other way should not keep it.
update public.app_users
   set admin_level = 'operator'
 where role = 'admin' and admin_level not in ('manager', 'owner', 'operator');

comment on column public.app_users.admin_level is
  'manager = system maintainer, owner = business owner, operator = the owner''s staff. Null for non-administrators.';

-- ── who the caller is ───────────────────────────────────────────────────────
create or replace function public.sarraf_admin_level()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select admin_level from public.app_users
   where auth_id = auth.uid() and not deleted and role = 'admin';
$$;

create or replace function public.sarraf_is_manager()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.sarraf_admin_level() = 'manager', false);
$$;

-- A manager outranks an owner, so anything an owner may do a manager may do. Written once here
-- rather than as `level in ('owner','manager')` at every call site, where the first place that
-- forgets the second value locks the manager out of their own system.
create or replace function public.sarraf_is_owner()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.sarraf_admin_level() in ('owner', 'manager'), false);
$$;

grant execute on function public.sarraf_admin_level() to authenticated;
grant execute on function public.sarraf_is_manager() to authenticated;
grant execute on function public.sarraf_is_owner() to authenticated;

-- ── who may make whom ───────────────────────────────────────────────────────
--
-- The rule in one place, enforced by the database, so a change of rank cannot be made by calling
-- the table directly instead of the API.
--
-- A null auth.uid() is a migration or a service-role write, not a person, and is allowed. That is
-- the same convention the upload-direction guard already uses, and it is what lets the first
-- manager be created from the SQL editor — where holding the database credentials is the proof
-- of ownership, and the only proof available before any manager exists.
create or replace function public.sarraf_guard_admin_level()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_level text := public.sarraf_admin_level();
  v_managers integer;
begin
  if auth.uid() is null then return new; end if;

  if tg_op = 'INSERT' then
    if new.admin_level = 'manager' and coalesce(v_level, '') <> 'manager' then
      raise exception using errcode = '42501',
        message = 'only a manager may create another manager';
    end if;
    if new.admin_level in ('owner', 'operator') and coalesce(v_level, '') not in ('manager', 'owner') then
      raise exception using errcode = '42501',
        message = 'only a manager or the business owner may create an administrator';
    end if;
    return new;
  end if;

  if new.admin_level is distinct from old.admin_level then
    -- Touching a manager's rank, in either direction, is a manager's business alone.
    if coalesce(v_level, '') <> 'manager'
       and (old.admin_level = 'manager' or new.admin_level = 'manager') then
      raise exception using errcode = '42501',
        message = 'only a manager may change a manager''s rank';
    end if;
    if coalesce(v_level, '') not in ('manager', 'owner') then
      raise exception using errcode = '42501',
        message = 'only a manager or the business owner may change an administrator''s rank';
    end if;
  end if;

  -- The last manager may not be demoted or deleted. A system with nobody able to reach it is not
  -- more secure, it is unusable, and recovering from it means going back to the database by hand.
  if (old.admin_level = 'manager' and new.admin_level is distinct from 'manager')
     or (old.admin_level = 'manager' and new.deleted and not old.deleted) then
    select count(*) into v_managers from public.app_users
     where role = 'admin' and admin_level = 'manager' and not deleted and id <> old.id;
    if v_managers = 0 then
      raise exception using errcode = '23514',
        message = 'the last manager cannot be removed; appoint another first';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists app_users_admin_level_guard on public.app_users;
create trigger app_users_admin_level_guard
  before insert or update on public.app_users
  for each row execute function public.sarraf_guard_admin_level();

-- ── what a manager can see that nobody else can ─────────────────────────────
--
-- Everything, in one answer: who holds which rank, how many accounts of each kind exist, and
-- whether the system has the one manager it needs to stay reachable.
create or replace function public.sarraf_manager_overview()
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare v_result jsonb;
begin
  if not public.sarraf_is_manager() then
    raise exception using errcode = '42501', message = 'the manager overview is not authorized';
  end if;

  select jsonb_build_object(
    'administrators', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', u.id, 'name', u.name, 'level', u.admin_level,
        'phone', u.phone, 'deleted', u.deleted, 'created_at', u.created_at)
        order by case u.admin_level when 'manager' then 0 when 'owner' then 1 else 2 end, u.name)
      from public.app_users u where u.role = 'admin'), '[]'::jsonb),
    'by_role', coalesce((
      select jsonb_object_agg(r.role, r.n)
      from (select role, count(*) filter (where not deleted) n
            from public.app_users group by role) r), '{}'::jsonb),
    'manager_count', (select count(*) from public.app_users
                       where role = 'admin' and admin_level = 'manager' and not deleted),
    'owner_count', (select count(*) from public.app_users
                     where role = 'admin' and admin_level = 'owner' and not deleted),
    'recent_changes', coalesce((
      select jsonb_agg(jsonb_build_object('at', a.date, 'action', a.action, 'detail', a.detail)
                       order by a.date desc)
      from (select * from public.audit order by date desc limit 50) a), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.sarraf_manager_overview() from public, anon;
grant execute on function public.sarraf_manager_overview() to authenticated;

commit;
