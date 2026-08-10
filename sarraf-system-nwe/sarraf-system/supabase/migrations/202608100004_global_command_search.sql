-- Bounded, navigation-only global search. No financial or receipt mutation is performed.
create index if not exists tx_code_global_search on public.txs(code) where not deleted;
create index if not exists user_name_global_search on public.app_users(lower(name) text_pattern_ops) where not deleted;
create index if not exists receipt_ref_global_search on public.receipts(lower(ref_no) text_pattern_ops) where ref_no is not null;

create or replace function public.sarraf_operational_search(
  p_query text,
  p_limit integer default 20,
  p_cursor text default null
) returns table(type text, label text, context text, path text)
language plpgsql security definer stable
set search_path = pg_catalog, public
as $$
declare
  actor public.app_users%rowtype;
  query_prefix text := lower(btrim(p_query));
  result_limit integer := least(greatest(coalesce(p_limit, 20), 1), 20);
begin
  select * into actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then raise exception using errcode = '42501', message = 'not authorized'; end if;
  if length(query_prefix) < 2 then return; end if;

  return query
  with visible as (
    select 'Customer'::text, u.name, 'Authorized customer'::text, '#/people'::text, '1:' || u.id sort_key
      from public.app_users u where u.role = 'customer' and not u.deleted
       and (actor.role = 'admin' or u.id = actor.id) and lower(u.name) like query_prefix || '%'
    union all
    select 'Partner', u.name, 'Authorized partner', '#/people', '2:' || u.id
      from public.app_users u where u.role = 'partner' and not u.deleted
       and (actor.role = 'admin' or u.id = actor.id) and lower(u.name) like query_prefix || '%'
    union all
    select 'Transaction', 'Order ' || t.code, c.code, '#/txs', '3:' || t.id
      from public.txs t join public.currencies c on c.id = t.cur_id
     where not t.deleted and t.code::text like query_prefix || '%'
       and (actor.role = 'admin' or actor.role = 'office' and t.type = 'buy' or t.cp_id = actor.id or t.partner_id = actor.id)
    union all
    select 'Receipt', coalesce(r.ref_no, 'Receipt'), r.currency, '#/receipts', '4:' || r.id
      from public.receipts r join public.receipt_batches b on b.id = r.batch_id
     where lower(coalesce(r.ref_no, '')) like query_prefix || '%'
       and (actor.role in ('admin','office') or b.customer_id = actor.id or b.partner_id = actor.id)
    union all
    select 'Currency', c.code, c.name, '#/rates', '5:' || c.id from public.currencies c
     where lower(c.code) like query_prefix || '%' or lower(c.name) like query_prefix || '%'
  )
  select v.type, v.label, v.context, v.path from visible v order by v.sort_key limit result_limit;
end $$;

revoke all on function public.sarraf_operational_search(text, integer, text) from public, anon;
grant execute on function public.sarraf_operational_search(text, integer, text) to authenticated;
