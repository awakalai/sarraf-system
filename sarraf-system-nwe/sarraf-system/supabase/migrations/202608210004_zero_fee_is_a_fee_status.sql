-- A receipt with no fee has a fee status. It is "no fee".
--
-- normalize_receipt_business_fields derives has_fee, and where the reader found a fee of zero
-- and named no fee treatment it derives null — unknown. The validation rule then refuses the
-- document: "recipient, date, WeChat/Alipay platform, and fee status are required before
-- validation".
--
-- So an ordinary fee-free transfer — which is most of them — could never be validated. It went
-- to manual review every time, and the reviewer was being asked to supply a fact the receipt had
-- already stated plainly: the fee was zero.
--
-- Unknown must stay available, because a reader that could not find the fee at all is a real
-- state and pretending it read zero would be worse than asking. The two are distinguished by
-- whether fee_amount is null: a null is "I did not read it", a zero is "I read it and it was
-- nothing". Nulling that difference is what made every fee-free receipt look unread.
begin;

create or replace function public.normalize_receipt_business_fields()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_platform text;
begin
  v_platform := lower(btrim(coalesce(new.platform, new.raw->>'platform', '')));
  new.platform := case
    when v_platform ~ '(wechat|weixin|微信)' then 'wechat'
    when v_platform ~ '(alipay|ali[ -]?pay|支付宝)' then 'alipay'
    when v_platform = '' then 'unknown'
    else 'other'
  end;
  new.platform_evidence := left(coalesce(new.platform_evidence, new.raw->>'platformEvidence'), 300);
  new.transaction_status := left(coalesce(new.transaction_status, new.raw->>'transactionStatus'), 80);
  new.has_fee := case
    when coalesce(new.fee_amount, 0) > 0 then true
    when new.fee_treatment = 'no_fee' then false
    when new.fee_treatment in ('added_on_top', 'deducted_from_principal', 'included_in_total') then true
    -- A fee that was read and found to be zero. Not a gap in the reading, and not a question
    -- for a reviewer.
    when new.fee_amount = 0 then false
    else null
  end;
  return new;
end;
$$;

-- Rows already stored under the old rule carry null where they should carry false. Corrected in
-- place: nothing else about them changes, and leaving them would mean the same receipts stay
-- unvalidatable for as long as they exist.
update public.receipt_extractions
   set has_fee = false
 where has_fee is null and fee_amount = 0;

commit;
