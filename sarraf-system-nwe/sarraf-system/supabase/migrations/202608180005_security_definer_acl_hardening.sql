-- SECURITY DEFINER routines run with their owner's privileges. PostgreSQL grants EXECUTE to
-- PUBLIC by default, which would make any routine that an earlier migration forgot to harden
-- reachable by the anonymous Data API role. Keep the exposed command surface explicit.

begin;

do $acl$
declare
  fn record;
begin
  for fn in
    select
      n.nspname as schema_name,
      p.proname as function_name,
      pg_get_function_identity_arguments(p.oid) as identity_arguments
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
  loop
    execute format(
      'revoke execute on function %I.%I(%s) from public, anon',
      fn.schema_name,
      fn.function_name,
      fn.identity_arguments
    );
  end loop;
end
$acl$;

-- These four routines are deliberately SECURITY DEFINER because RLS policies need a small,
-- non-recursive identity lookup. They reveal only the current caller's application id/role.
grant execute on function public.my_app_id() to authenticated;
grant execute on function public.my_role() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.sarraf_current_role() to authenticated;

-- Future functions must be granted deliberately by the migration that exposes them.
alter default privileges in schema public
  revoke execute on functions from public;

commit;
