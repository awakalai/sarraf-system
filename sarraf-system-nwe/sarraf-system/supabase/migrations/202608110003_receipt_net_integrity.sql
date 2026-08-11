-- Receipt net-amount integrity.
--
-- sarraf_ingest_receipt_batch accepts net_amount from the client verbatim:
--
--   v_net := case when coalesce(r->>'net_amount','') ~ '^\d+(\.\d+)?$'
--                 then (r->>'net_amount')::numeric ... end;
--
-- Nothing checked that the value reconciled with amount and fee, and
-- sarraf_convert_receipt_batch_to_transaction turns sum(net_amount) directly into the
-- amount of a real transaction. A receipt whose net had drifted from amount - fee
-- therefore moved money that matched no receipt image.
--
-- Every layout the reader supports satisfies net = amount - fee: where an explicit order
-- amount exists (WeChat) the gross already equals order + fee, so the order amount and
-- amount - fee are the same number. A cent of tolerance absorbs per-currency rounding.
--
-- Added NOT VALID so historical rows are never rejected retroactively; the constraints
-- apply to all new writes. Run the VALIDATE statements at the end only after reviewing
-- any legacy rows the audit query reports.
begin;

alter table public.receipt_intake_items
  drop constraint if exists receipt_intake_net_reconciles;
alter table public.receipt_intake_items
  add constraint receipt_intake_net_reconciles check (
    intake_status <> 'accepted'
    or (
      net_amount is not null
      and net_amount >= 0
      and net_amount <= amount
      and abs(net_amount - (amount - coalesce(fee, 0))) <= 0.01
    )
  ) not valid;

alter table public.receipts
  drop constraint if exists receipts_net_reconciles;
alter table public.receipts
  add constraint receipts_net_reconciles check (
    status <> 'ok'
    or not coalesce(counted, true)
    or net_amount is null
    or (
      net_amount >= 0
      and net_amount <= amount
      and abs(net_amount - (amount - coalesce(fee, 0))) <= 0.01
    )
  ) not valid;

commit;

-- Audit: counted rows already stored with a net that does not reconcile. Each one
-- overstates or understates a batch total and should be corrected before validating.
--
--   select id, batch_id, amount, fee, net_amount,
--          net_amount - (amount - coalesce(fee,0)) as drift
--   from public.receipts
--   where status = 'ok' and coalesce(counted, true) and net_amount is not null
--     and abs(net_amount - (amount - coalesce(fee,0))) > 0.01
--   order by abs(net_amount - (amount - coalesce(fee,0))) desc;
--
-- Once that query returns no rows:
--   alter table public.receipt_intake_items validate constraint receipt_intake_net_reconciles;
--   alter table public.receipts validate constraint receipts_net_reconciles;
