-- Re-apply the SECURITY DEFINER boundary after all merged feature migrations.
--
-- PostgreSQL grants function execution to PUBLIC by default. Feature migrations created a few
-- new trigger functions after the earlier ACL hardening migration; triggers do not need callers
-- to execute their functions directly. Revoke the implicit grant from every definer function
-- while preserving any explicit authenticated/service_role grants made for intentional RPCs.

begin;

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
  loop
    execute format('revoke execute on function %s from public, anon', fn.signature);
  end loop;
end;
$$;

commit;
