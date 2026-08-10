-- Phase B: portal reads are derived from auth.uid() membership, never a browser-supplied tenant.
alter table public.receipt_batches enable row level security;
alter table public.receipts enable row level security;

drop policy if exists receipt_batches_portal_read_b on public.receipt_batches;
create policy receipt_batches_portal_read_b on public.receipt_batches
for select to authenticated
using (
  public.is_admin()
  or public.my_role() = 'office'
  or (public.my_role() = 'customer' and customer_id = public.my_app_id())
  or (public.my_role() = 'partner' and partner_id = public.my_app_id())
);

drop policy if exists receipts_portal_read_b on public.receipts;
create policy receipts_portal_read_b on public.receipts
for select to authenticated
using (
  public.is_admin()
  or public.my_role() = 'office'
  or exists (
    select 1 from public.receipt_batches b
    where b.id = receipts.batch_id
      and (
        (public.my_role() = 'customer' and b.customer_id = public.my_app_id())
        or (public.my_role() = 'partner' and b.partner_id = public.my_app_id())
      )
  )
);

-- Partners may read only transactions whose persisted partner relationship names them.
drop policy if exists tx_partner_read_b on public.txs;
create policy tx_partner_read_b on public.txs
for select to authenticated
using (public.my_role() = 'partner' and partner_id = public.my_app_id());

comment on policy receipt_batches_portal_read_b on public.receipt_batches is
  'Phase B tenant isolation: staff or the authenticated customer/partner relationship only.';
comment on policy receipts_portal_read_b on public.receipts is
  'Phase B tenant isolation inherited from the authoritative receipt batch relationship.';
