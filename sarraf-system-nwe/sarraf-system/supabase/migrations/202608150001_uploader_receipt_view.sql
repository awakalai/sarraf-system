-- What a customer-seller may send, and what every user may see of their own.
--
-- Three requirements from the owner, all about the same screen:
--
--   "the customer-seller may only send their own sale receipts, not purchase"
--   "the details they need to see are only: how many receipts went to which recipient and how
--    much, the recipient's name, that many receipts and that much yuan, and at the end the
--    grand total with fee and without fee"
--   "the customer-seller and every other user must see the history and details of their own
--    receipts — so that tomorrow, when I say go and do it, they can see their own archive of
--    what they sent"
--
-- The first is a rule and belongs in the database, not only in a screen a browser can be
-- talked out of. The second and third are one query: the portal summary already existed but
-- withheld individual rows and served only customers and partners.
begin;

-- ── a customer-seller sells ──────────────────────────────────────────────────
--
-- A customer earns money abroad and sells it to the house; their evidence is always money that
-- arrived for them. A purchase receipt from a customer is either a mistake or an attempt to
-- book a movement the wrong way round, and both are refused at the point of insert.
--
-- The rule reads the *actor*, not the batch. An administrator recording a purchase on behalf of
-- a customer is doing the house's own bookkeeping and keeps both directions; it is the customer
-- acting for themselves who is confined to sales. This is the same rule receipt_documents
-- already enforces on the newer intake path (customer_buys_from_zeman is refused for a
-- customer); the batch path had no equivalent, which is the path the portal actually uses.
create or replace function public.sarraf_assert_upload_direction()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_role text;
begin
  select role into v_role from public.app_users where auth_id = auth.uid() and not deleted;

  -- No signed-in actor means a server-side or migration write; those are not customer uploads.
  if v_role is distinct from 'customer' then return new; end if;

  if lower(coalesce(new.direction, '')) in ('out', 'buy') then
    raise exception using errcode = '42501',
      message = 'a customer may send only their own sale receipts, never a purchase';
  end if;
  return new;
end;
$$;

drop trigger if exists receipt_batches_direction_guard on public.receipt_batches;
create trigger receipt_batches_direction_guard
  before insert or update of direction on public.receipt_batches
  for each row execute function public.sarraf_assert_upload_direction();

drop trigger if exists receipts_direction_guard on public.receipts;
create trigger receipts_direction_guard
  before insert or update of direction on public.receipts
  for each row execute function public.sarraf_assert_upload_direction();

-- ── the name on the receipt ──────────────────────────────────────────────────
--
-- Payment services put the recipient in different places: a personal transfer has a receiver, a
-- merchant payment has a merchant name, a QR payment sometimes carries only a note. Reading one
-- field and calling everything else unknown is why receipts that plainly showed a name were
-- reported as having gone to nobody. This is the same order of preference the interface uses,
-- so the two never disagree about who was paid.
create or replace function public.sarraf_payee_name(p_receiver text, p_raw jsonb, p_sender text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select coalesce(
    nullif(btrim(p_receiver), ''),
    nullif(btrim(p_raw->>'payee'), ''),
    nullif(btrim(p_raw->>'receiver'), ''),
    nullif(btrim(p_raw->>'merchantName'), ''),
    nullif(btrim(p_raw->>'merchant_name'), ''),
    nullif(btrim(p_raw->>'recipientNote'), ''),
    nullif(btrim(p_sender), ''));
$$;

-- ── what the uploader may see ────────────────────────────────────────────────
--
-- Scoped by ownership rather than by role: whatever a person sent, they may read back. That is
-- their own archive and no wider — the clauses below key on the actor's own id in every case,
-- so widening the roles admitted does not widen what any one of them can read.
--
-- No valuation appears anywhere in the result. What a receipt is worth in dollars is a
-- bookkeeping decision the house has not made at upload time, and stating one on this screen is
-- a figure the uploader would rightly hold the house to.
drop function if exists public.sarraf_portal_receipt_summary(integer);

create function public.sarraf_portal_receipt_summary(p_days integer default 365)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_result jsonb;
  v_days int := greatest(1, least(coalesce(p_days, 365), 3650));
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then
    raise exception using errcode = '42501', message = 'portal receipt summary is not authorized';
  end if;

  with visible as (
    select b.*
    from public.receipt_batches b
    where b.created_at >= statement_timestamp() - (v_days || ' days')::interval
      and (b.customer_id = v_actor.id
        or b.partner_id = v_actor.id
        or b.uploaded_by = v_actor.id)
  ), totals as (
    select currency,
           sum(total_gross) total_gross, sum(total_fee) total_fee, sum(total_net) total_net,
           sum(greatest(coalesce(n, 0) - coalesce(rejected_n, 0), 0)) accepted_count,
           sum(coalesce(rejected_n, 0)) rejected_count
    from visible group by currency order by sum(total_net) desc
  ), recent as (
    select id, currency, total_net, receipt_stage, created_at, n, rejected_n
    from visible order by created_at desc limit 50
  ), mine as (
    -- The uploader's own receipts. A row counts towards the figures only when it was accepted;
    -- a rejected or duplicate row is still shown, so the uploader can see what happened to it,
    -- but it is never added to a total.
    select r.*,
           public.sarraf_payee_name(r.receiver, r.raw, r.sender) as payee,
           coalesce(r.counted, true)
             and coalesce(r.status, '') not in ('dup', 'error')
             and r.currency is not null as accepted
    from public.receipts r
    where r.created_at >= statement_timestamp() - (v_days || ' days')::interval
      and (r.customer_id = v_actor.id
        or r.partner_id = v_actor.id
        or r.uploaded_by = v_actor.id
        or r.batch_id in (select id from visible))
  ), accepted_rows as (
    select payee, currency,
           coalesce(amount, 0) as with_fee,
           coalesce(net_amount, coalesce(amount, 0) - coalesce(fee, 0)) as without_fee,
           coalesce(fee, 0) as fee
    from mine where accepted
  ), per_recipient_currency as (
    select payee, currency, count(*) as n,
           jsonb_build_object(
             'count', count(*),
             'with_fee', sum(with_fee),
             'without_fee', sum(without_fee),
             'fee', sum(fee)) as amounts
    from accepted_rows group by payee, currency
  ), by_recipient as (
    select payee,
           payee is not null as named,
           sum(n) as count,
           jsonb_object_agg(currency, amounts) as by_currency
    from per_recipient_currency group by payee
  ), grand as (
    select currency,
           count(*) as count,
           sum(with_fee) as with_fee,
           sum(without_fee) as without_fee,
           sum(fee) as fee
    from accepted_rows group by currency
  ), history as (
    select id, batch_id, tx_date, tx_time, created_at, currency, amount, fee, net_amount,
           public.sarraf_payee_name(receiver, raw, sender) as payee,
           sender, ref_no, platform, bank, status, counted, reject_code, direction
    from mine order by coalesce(tx_date, created_at::date) desc, created_at desc limit 300
  )
  select jsonb_build_object(
    'totals', coalesce((select jsonb_agg(to_jsonb(t)) from totals t), '[]'::jsonb),
    'batches', coalesce((select jsonb_agg(to_jsonb(r)) from recent r), '[]'::jsonb),
    -- The named recipients first, busiest first; the receipts that named nobody come last,
    -- because that group is a gap to close rather than a recipient.
    'by_recipient', coalesce((select jsonb_agg(to_jsonb(x) order by x.named desc, x.count desc, x.payee)
                              from by_recipient x), '[]'::jsonb),
    'grand_total', coalesce((select jsonb_agg(to_jsonb(g) order by g.currency) from grand g), '[]'::jsonb),
    'receipts', coalesce((select jsonb_agg(to_jsonb(h)) from history h), '[]'::jsonb),
    'unread_count', (select count(*) from mine where not accepted),
    'batch_count', (select count(*) from visible),
    'accepted_count', (select coalesce(sum(greatest(coalesce(n, 0) - coalesce(rejected_n, 0), 0)), 0) from visible),
    'rejected_count', (select coalesce(sum(coalesce(rejected_n, 0)), 0) from visible)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.sarraf_portal_receipt_summary(integer) from public, anon;
grant execute on function public.sarraf_portal_receipt_summary(integer) to authenticated;
revoke all on function public.sarraf_payee_name(text, jsonb, text) from public, anon;
grant execute on function public.sarraf_payee_name(text, jsonb, text) to authenticated;

commit;
