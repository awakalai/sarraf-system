-- Fix: src/App.jsx calls supabase.rpc("check_receipt_dupe", ...) during receipt
-- review to warn the uploader that an image/reference was already recorded in an
-- earlier batch. That function was never created, so the call always fails
-- PGRST202 and is silently swallowed by the caller's try/catch — every
-- already-recorded receipt was shown as a brand-new "verified" receipt instead
-- of being flagged as a duplicate before submission.
begin;

create or replace function public.check_receipt_dupe(p_hash text, p_ref text)
returns table(id text, d timestamptz, who text, ref text)
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_hash text := nullif(btrim(p_hash), '');
  v_ref text := nullif(upper(regexp_replace(coalesce(p_ref,''), '[^0-9A-Za-z]', '', 'g')), '');
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then raise exception using errcode='42501', message='not authorized'; end if;
  if v_hash is not null and v_hash !~ '^[a-f0-9]{64}$' then v_hash := null; end if;
  if v_hash is null and v_ref is null then return; end if;

  return query
  with candidates as (
    select i.id, i.created_at as d, i.submitted_by, i.customer_id, i.partner_id, i.ref_no
    from public.receipt_intake_items i
    where i.intake_status = 'accepted'
      and (
        (v_hash is not null and i.image_hash = v_hash)
        or (v_ref is not null and upper(regexp_replace(coalesce(i.ref_no,''), '[^0-9A-Za-z]', '', 'g')) = v_ref)
      )
    union all
    select r.id, r.created_at as d, r.uploaded_by as submitted_by, r.customer_id, r.partner_id, r.ref_no
    from public.receipts r
    where r.status = 'ok' and coalesce(r.counted, true)
      and (
        (v_hash is not null and r.image_hash = v_hash)
        or (v_ref is not null and upper(regexp_replace(coalesce(r.ref_no,''), '[^0-9A-Za-z]', '', 'g')) = v_ref)
      )
  )
  select c.id, c.d, coalesce(u.name, c.submitted_by), c.ref_no
  from candidates c
  left join public.app_users u on u.id = c.submitted_by
  where v_actor.role in ('admin','office')
    or (v_actor.role = 'customer' and c.customer_id = v_actor.id)
    or (v_actor.role = 'partner' and c.partner_id = v_actor.id)
  order by c.d desc
  limit 1;
end;
$$;

revoke all on function public.check_receipt_dupe(text, text) from public, anon;
grant execute on function public.check_receipt_dupe(text, text) to authenticated;

commit;
