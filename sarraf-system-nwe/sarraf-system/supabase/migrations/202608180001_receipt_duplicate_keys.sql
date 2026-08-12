-- Four keys for a duplicate, not two.
--
-- The check had two: the image, and the transaction reference. That catches the same photo sent
-- twice and the same reference typed twice. It misses the two cases that actually happen:
--
--   3. The merchant order number. Alipay and WeChat both carry one, and it survives when the
--      transaction reference does not — a screenshot cropped differently, or read by a different
--      provider, can lose the reference and keep the order number. The reader already extracts
--      it and the matcher already scores on it; nothing was ever checking it for repeats.
--
--   4. The compound key: same currency, same amount, same day, same recipient. On its own each
--      of those repeats innocently. All four together is one payment presented twice with the
--      identifiers stripped or unread. This one is a *suspicion*, not a refusal — it is exactly
--      the shape of a genuine second payment to the same supplier on a busy day, so it goes to a
--      person rather than being rejected by a rule.
--
-- The distinction matters: a hard duplicate is refused, a suspect one is held for review. Making
-- the fourth key a refusal would reject real money.
begin;

-- The reader has always extracted it; it was only ever kept in the raw payload, where nothing
-- could index or compare it.
alter table public.receipts add column if not exists merchant_order_no text;

comment on column public.receipts.merchant_order_no is
  'The merchant/order number the payment service prints. Duplicate key 3.';

update public.receipts
   set merchant_order_no = left(nullif(btrim(raw->>'merchantOrderNo'), ''), 160)
 where merchant_order_no is null
   and nullif(btrim(raw->>'merchantOrderNo'), '') is not null;

-- The ingestion command inserts a fixed list of columns and predates this one, so the value is
-- lifted out of the raw payload as the row is written rather than by rewriting that command.
create or replace function public.sarraf_fill_merchant_order_no()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.merchant_order_no is null then
    new.merchant_order_no := left(nullif(btrim(new.raw->>'merchantOrderNo'), ''), 160);
  end if;
  return new;
end;
$$;
drop trigger if exists receipts_fill_merchant_order on public.receipts;
create trigger receipts_fill_merchant_order
  before insert on public.receipts
  for each row execute function public.sarraf_fill_merchant_order_no();

-- Identifiers are compared in one normalised shape, the same one src/App.jsx uses, so that
-- "AB-123 456" and "ab123456" are the same identifier on both sides.
create or replace function public.sarraf_norm_ref(p_value text)
returns text
language sql immutable
set search_path = pg_catalog
as $$
  select nullif(upper(regexp_replace(coalesce(p_value, ''), '[\s\-_.]', '', 'g')), '');
$$;

create index if not exists receipts_merchant_order_idx
  on public.receipts (public.sarraf_norm_ref(merchant_order_no))
  where merchant_order_no is not null;

create index if not exists receipts_compound_idx
  on public.receipts (currency, amount, tx_date)
  where status = 'ok' and counted;

-- The reader's own name for the payee, normalised the same way for both sides of a comparison.
create or replace function public.sarraf_norm_name(p_value text)
returns text
language sql immutable
set search_path = pg_catalog
as $$
  select nullif(lower(regexp_replace(coalesce(p_value, ''), '\s+', '', 'g')), '');
$$;

-- Changing the shape of the answer means dropping first; both statements are in one transaction.
drop function if exists public.check_receipt_dupe(text, text);

create function public.check_receipt_dupe(
  p_hash text,
  p_ref text,
  p_merchant_ref text default null,
  p_currency text default null,
  p_amount numeric default null,
  p_tx_date date default null,
  p_payee text default null
)
returns table(id text, d timestamptz, who text, ref text, kind text, matched_key text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_staff boolean := false;
  v_hash text := nullif(btrim(p_hash), '');
  v_ref text := public.sarraf_norm_ref(p_ref);
  v_merchant text := public.sarraf_norm_ref(p_merchant_ref);
  v_cur text := nullif(upper(btrim(coalesce(p_currency, ''))), '');
  v_payee text := public.sarraf_norm_name(p_payee);
begin
  if v_hash is null and v_ref is null and v_merchant is null
     and not (v_cur is not null and p_amount is not null and p_tx_date is not null and v_payee is not null) then
    return;
  end if;

  select coalesce(a.role in ('admin','office'), false) into v_staff
  from public.app_users a
  where a.auth_id = auth.uid() and not a.deleted;

  -- The existence check stays global on purpose: the same image, reference or order number sent
  -- by a different customer must still be caught. Only the uploader's identity is withheld from
  -- a caller who is not staff.
  return query
  with candidates as (
    select r.id, r.created_at, r.uploaded_by, r.ref_no,
      case
        when v_hash is not null and r.image_hash = v_hash then 'image'
        when v_ref is not null and public.sarraf_norm_ref(r.ref_no) = v_ref then 'reference'
        when v_merchant is not null and public.sarraf_norm_ref(r.merchant_order_no) = v_merchant then 'merchant_order'
        else 'compound'
      end as matched_key
    from public.receipts r
    where r.status = 'ok'
      and coalesce(r.counted, true)
      and (
        (v_hash is not null and r.image_hash = v_hash)
        or (v_ref is not null and public.sarraf_norm_ref(r.ref_no) = v_ref)
        or (v_merchant is not null and public.sarraf_norm_ref(r.merchant_order_no) = v_merchant)
        or (v_cur is not null and p_amount is not null and p_tx_date is not null and v_payee is not null
            and upper(r.currency) = v_cur
            and r.amount = p_amount
            and r.tx_date = p_tx_date
            and public.sarraf_norm_name(coalesce(r.receiver, r.sender)) = v_payee)
      )
  )
  select c.id,
         c.created_at,
         case when v_staff then coalesce(u.name, c.uploaded_by) else null end,
         c.ref_no,
         -- Three identifiers are proof; four coincidences are a question for a person.
         case when c.matched_key = 'compound' then 'suspect' else 'duplicate' end,
         c.matched_key
  from candidates c
  left join public.app_users u on u.id = c.uploaded_by
  -- A hard duplicate outranks a suspicion, so a caller that only looks at the first row is
  -- told the stronger fact.
  order by (c.matched_key = 'compound'), c.created_at
  limit 1;
end;
$$;

revoke all on function public.check_receipt_dupe(text, text, text, text, numeric, date, text) from public, anon;
grant execute on function public.check_receipt_dupe(text, text, text, text, numeric, date, text) to authenticated;

commit;
