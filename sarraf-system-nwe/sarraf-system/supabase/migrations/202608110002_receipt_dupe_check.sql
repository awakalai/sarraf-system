-- src/App.jsx calls supabase.rpc("check_receipt_dupe", ...) during receipt review to
-- warn the uploader that an image/reference was already recorded earlier. The function
-- existed in production but had only ever been created by hand in the SQL editor, so it
-- was absent from version control and carried two defects:
--
--   1. It filtered no status at all, matching every row in public.receipts — including
--      rows that were rejected or never counted. Re-sending the image of a previously
--      rejected receipt was therefore refused as a duplicate even though the original
--      never entered the accounting set.
--   2. It returned a single column (d). The caller also reads id/who/ref, so the
--      "already submitted" message could never name the sender or the reference.
--
-- The existence check stays global on purpose: the same image or reference submitted by
-- a different customer must still be caught, so this must NOT be scoped to the caller's
-- own rows. Only the uploader's identity is withheld from non-staff callers.
--
-- Changing the return type requires dropping first; drop + create run in one transaction.
begin;

drop function if exists public.check_receipt_dupe(text, text);

create function public.check_receipt_dupe(p_hash text, p_ref text)
returns table(id text, d timestamptz, who text, ref text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_staff boolean := false;
  v_hash  text := nullif(btrim(p_hash), '');
  -- Mirrors normRef() in src/App.jsx so both sides compare identical shapes.
  v_ref   text := nullif(upper(regexp_replace(coalesce(p_ref,''), '[\s\-_.]', '', 'g')), '');
begin
  if v_hash is null and v_ref is null then return; end if;

  select coalesce(a.role in ('admin','office'), false) into v_staff
  from public.app_users a
  where a.auth_id = auth.uid() and not a.deleted;

  return query
  select r.id,
         r.created_at,
         case when v_staff then coalesce(u.name, r.uploaded_by) else null end,
         r.ref_no
  from public.receipts r
  left join public.app_users u on u.id = r.uploaded_by
  where r.status = 'ok'
    and coalesce(r.counted, true)
    and (
      (v_hash is not null and r.image_hash = v_hash)
      or (v_ref is not null
          and upper(regexp_replace(coalesce(r.ref_no,''), '[\s\-_.]', '', 'g')) = v_ref)
    )
  order by r.created_at
  limit 1;
end;
$$;

revoke all on function public.check_receipt_dupe(text, text) from public, anon;
grant execute on function public.check_receipt_dupe(text, text) to authenticated;

commit;
