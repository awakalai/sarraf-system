-- Views exposed through PostgREST must enforce the caller's privileges and RLS.

begin;

alter view public.v_unpriced_currencies set (security_invoker = true);
revoke all on public.v_unpriced_currencies from public, anon;
grant select on public.v_unpriced_currencies to authenticated;

commit;
