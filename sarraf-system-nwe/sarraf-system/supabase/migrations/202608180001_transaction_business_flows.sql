-- Authoritative business flows for the real ZEMAN exchange workflow.
--
-- A / partner_custody: a normal trade whose currency is held by one assigned partner.
-- B / owner_cashbox:   the existing paired direct trade; no partner and no investor share.
-- C / standard:        the existing ordinary trade, unchanged.
--
-- The migration is additive.  It removes no table, column or row, and derives the new label
-- from the signals the application has always stored so old transactions remain compatible.
begin;

-- The production UI already reads/writes these columns.  Version them here so a clean database
-- and production no longer depend on manually-created transaction fields.
alter table public.txs add column if not exists direct boolean not null default false;
alter table public.txs add column if not exists pair_id text;
alter table public.txs add column if not exists direct_role text;
alter table public.txs add column if not exists own_money boolean not null default false;
alter table public.txs add column if not exists buy_rate numeric(38,10);
alter table public.txs add column if not exists buy_total numeric(38,10);
alter table public.txs add column if not exists business_flow text;

update public.txs
set direct = coalesce(direct,false),
    own_money = coalesce(direct,false),
    business_flow = case
      when coalesce(direct,false) then 'owner_cashbox'
      when partner_id is not null then 'partner_custody'
      else 'standard'
    end
where business_flow is null
   or own_money is distinct from coalesce(direct,false);

-- Keep the transaction's human-readable counterparty snapshot available to an authorized
-- partner/office without granting those roles the customer's full app_users row (phone,
-- address and internal note). Existing non-null historical snapshots are never overwritten.
update public.txs t set cp_name=u.name
  from public.app_users u
 where t.cp_id=u.id and t.cp_name is null and nullif(btrim(u.name),'') is not null;

alter table public.txs alter column direct set default false;
alter table public.txs alter column direct set not null;
alter table public.txs alter column own_money set default false;
alter table public.txs alter column own_money set not null;
alter table public.txs alter column business_flow set default 'standard';
alter table public.txs alter column business_flow set not null;
alter table public.txs drop constraint if exists txs_business_flow_ck;
alter table public.txs add constraint txs_business_flow_ck check (
  (business_flow='partner_custody' and not direct and not own_money and partner_id is not null)
  or (business_flow='owner_cashbox' and direct and own_money and partner_id is null)
  or (business_flow='standard' and not direct and not own_money and partner_id is null)
);
alter table public.txs drop constraint if exists txs_direct_role_ck;
alter table public.txs add constraint txs_direct_role_ck check (
  direct_role is null or direct_role in ('buy','sell')
);
create index if not exists txs_business_flow_idx
  on public.txs(business_flow,date desc) where not deleted;
create index if not exists txs_partner_custody_idx
  on public.txs(partner_id,cur_id,date desc)
  where business_flow='partner_custody' and not deleted;
create index if not exists txs_direct_pair_idx
  on public.txs(pair_id) where business_flow='owner_cashbox' and not deleted;

-- The client may describe the trade, but it may not choose a flow label that contradicts the
-- actual custody signals.  This is the authoritative boundary for every writer/RPC.
create or replace function public.enforce_transaction_business_flow()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_derived text;
begin
  new.direct := coalesce(new.direct,false);
  new.own_money := coalesce(new.own_money,false);
  v_derived := case
    when new.direct then 'owner_cashbox'
    when new.partner_id is not null then 'partner_custody'
    else 'standard'
  end;

  if new.business_flow is not null and new.business_flow <> v_derived then
    raise exception using errcode='23514',
      message='transaction business flow contradicts its custody fields';
  end if;
  new.business_flow := v_derived;

  if v_derived='partner_custody' then
    if new.own_money or new.pair_id is not null or new.direct_role is not null then
      raise exception using errcode='23514',
        message='a partner-custody transaction cannot carry direct-trade fields';
    end if;
    if not exists(select 1 from public.app_users
                  where id=new.partner_id and role='partner' and not deleted) then
      raise exception using errcode='22023', message='transaction custody partner is invalid';
    end if;
  elsif v_derived='owner_cashbox' then
    if not new.own_money or new.partner_id is not null
       or nullif(btrim(coalesce(new.pair_id,'')),'') is null
       or new.direct_role not in ('buy','sell')
       or new.direct_role is distinct from new.type then
      raise exception using errcode='23514',
        message='an owner-cashbox transaction requires one valid paired buy/sell role and no partner';
    end if;
  elsif new.own_money or new.pair_id is not null or new.direct_role is not null then
    raise exception using errcode='23514',
      message='a standard transaction cannot carry direct-trade fields';
  end if;
  return new;
end;
$$;
drop trigger if exists txs_business_flow_guard on public.txs;
create trigger txs_business_flow_guard
  before insert or update on public.txs
  for each row execute function public.enforce_transaction_business_flow();

-- Type B is one economic intent represented by exactly two rows.  The check is deferred so the
-- buy and sell may be inserted one after the other inside the same database transaction.
create or replace function public.assert_owner_cashbox_pair()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_pair text; v_pairs text[];
  v_count int; v_buy int; v_sell int; v_valid boolean;
  v_cur_min text; v_cur_max text; v_against_min text; v_against_max text;
  v_amount_min numeric; v_amount_max numeric;
begin
  if tg_op='INSERT' then v_pairs:=array[new.pair_id];
  elsif tg_op='DELETE' then v_pairs:=array[old.pair_id];
  else v_pairs:=array[new.pair_id,old.pair_id];
  end if;

  for v_pair in
    select distinct pair_value
    from unnest(v_pairs) as pairs(pair_value)
    where pair_value is not null
  loop
    select count(*),
           count(*) filter(where type='buy' and direct_role='buy'),
           count(*) filter(where type='sell' and direct_role='sell'),
           coalesce(bool_and(business_flow='owner_cashbox' and direct and own_money
                             and partner_id is null),true),
           min(cur_id),max(cur_id),min(against_id),max(against_id),min(amount),max(amount)
      into v_count,v_buy,v_sell,v_valid,
           v_cur_min,v_cur_max,v_against_min,v_against_max,v_amount_min,v_amount_max
    from public.txs where pair_id=v_pair and not deleted;

    -- Reversal/void may retire both sides, but may never leave half a direct trade alive.
    if v_count<>0 and (v_count<>2 or v_buy<>1 or v_sell<>1 or not v_valid
       or v_cur_min is distinct from v_cur_max
       or v_against_min is distinct from v_against_max
       or v_amount_min is distinct from v_amount_max) then
      raise exception using errcode='23514',
        message=format('owner-cashbox pair %s must contain one matching buy and one matching sell',v_pair);
    end if;
  end loop;
  return null;
end;
$$;
drop trigger if exists txs_owner_cashbox_pair on public.txs;
create constraint trigger txs_owner_cashbox_pair
  after insert or update or delete on public.txs
  deferrable initially deferred
  for each row execute function public.assert_owner_cashbox_pair();

-- A flow/custody change is an economic change once a journal exists.  It requires reversal and
-- replacement, exactly like amount, currency or partner changes.
create or replace function public.protect_transaction_financial_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if exists (select 1 from public.journal_entries
              where source_type='transaction' and source_id=old.id)
     and (new.type is distinct from old.type
       or new.cp_id is distinct from old.cp_id
       or new.cur_id is distinct from old.cur_id
       or new.amount is distinct from old.amount
       or new.rate is distinct from old.rate
       or new.against_id is distinct from old.against_id
       or new.total is distinct from old.total
       or new.partner_id is distinct from old.partner_id
       or new.business_flow is distinct from old.business_flow
       or new.direct is distinct from old.direct
       or new.pair_id is distinct from old.pair_id
       or new.direct_role is distinct from old.direct_role
       or new.own_money is distinct from old.own_money
       or new.date is distinct from old.date) then
    raise exception using errcode='42501',
      message='posted transaction economics are immutable; reverse and replace the transaction';
  end if;
  return new;
end;
$$;

-- Every eligible new transaction receives its receipt assignment automatically.  Type A buys
-- therefore accept seller evidence and route it to the exact partner; no browser follow-up call
-- is required.  Existing Type C buy behaviour is preserved, while a standard sell still does
-- not invent a partner.
create or replace function public.create_transaction_receipt_assignment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_flow public.receipt_flow; v_currency text; v_actor text;
begin
  if new.deleted or new.cp_id is null then return null; end if;
  if not exists(select 1 from public.app_users
                where id=new.cp_id and role='customer' and not deleted) then
    return null;
  end if;
  if new.type='sell' and new.business_flow<>'partner_custody' then return null; end if;

  v_flow := case when new.type='buy'
    then 'customer_sells_to_zeman'::public.receipt_flow
    else 'customer_buys_from_zeman'::public.receipt_flow end;
  select upper(code) into v_currency from public.currencies where id=new.cur_id;
  select id into v_actor from public.app_users where auth_id=auth.uid() and not deleted limit 1;
  if v_currency is null then return null; end if;

  insert into public.receipt_transaction_assignments(
    transaction_id,flow,customer_id,partner_id,expected_currency,
    assigned_by,assignment_reason)
  values(new.id,v_flow,new.cp_id,new.partner_id,v_currency,v_actor,
    case when new.business_flow='partner_custody'
      then 'Automatically assigned from the transaction partner-custody flow'
      else 'Automatically assigned from the transaction business context' end)
  on conflict(transaction_id) do nothing;
  return null;
end;
$$;
drop trigger if exists txs_create_receipt_assignment on public.txs;
create trigger txs_create_receipt_assignment
  after insert on public.txs
  for each row execute function public.create_transaction_receipt_assignment();

-- The older batch pipeline is the intentional upload-before-transaction path used by Type A.
-- Keep its accepted facts structured as well, so conversion does not depend on display-only
-- columns in the legacy receipts table or on unindexed JSON keys.
alter table public.receipt_intake_items add column if not exists payee text;
alter table public.receipt_intake_items add column if not exists platform text;
alter table public.receipt_intake_items add column if not exists platform_evidence text;
alter table public.receipt_intake_items add column if not exists has_fee boolean;
alter table public.receipt_intake_items add column if not exists tx_date date;
alter table public.receipt_intake_items add column if not exists transaction_status text;

create or replace function public.normalize_receipt_intake_business_fields()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_platform text; v_date text; v_fee_text text;
begin
  new.payee := left(coalesce(nullif(btrim(new.payee),''),nullif(btrim(new.raw->>'payee'),''),
                    nullif(btrim(new.raw->>'receiver'),''),nullif(btrim(new.raw->>'recipientNote'),'')),160);
  v_platform := lower(btrim(coalesce(new.platform,new.raw->>'platform',new.raw->>'bank','')));
  new.platform := case
    when v_platform ~ '(wechat|weixin|微信)' then 'wechat'
    when v_platform ~ '(alipay|ali[ -]?pay|支付宝)' then 'alipay'
    when v_platform='' then 'unknown'
    else 'other'
  end;
  new.platform_evidence := left(coalesce(new.platform_evidence,new.raw->>'platformEvidence'),300);
  v_date := coalesce(new.tx_date::text,new.raw->>'txDate',new.raw->>'tx_date');
  if coalesce(v_date,'')~'^\d{4}-\d{2}-\d{2}$' then new.tx_date:=v_date::date; end if;
  new.transaction_status := left(coalesce(new.transaction_status,
    new.raw->>'transactionStatus',new.raw->>'transaction_status'),80);
  v_fee_text := coalesce(new.raw->>'feeAmount',new.raw->>'fee',new.raw->>'fee_amount');
  new.has_fee := case
    when coalesce(new.fee,0)>0 then true
    when coalesce(new.raw->>'feeTreatment',new.raw->>'fee_treatment')='no_fee' then false
    when coalesce(new.raw->>'feeTreatment',new.raw->>'fee_treatment') in
      ('added_on_top','deducted_from_principal','included_in_total') then true
    when case when coalesce(v_fee_text,'')~'^\d+(\.\d+)?$'
              then v_fee_text::numeric=0 else false end then false
    else new.has_fee
  end;
  return new;
end;
$$;
drop trigger if exists receipt_intake_business_fields on public.receipt_intake_items;
create trigger receipt_intake_business_fields
  before insert or update of raw,payee,platform,platform_evidence,fee,has_fee,tx_date,transaction_status
  on public.receipt_intake_items
  for each row execute function public.normalize_receipt_intake_business_fields();

-- Preserve all historic rows and fill only currently-empty structured facts from their retained
-- receipt record/raw evidence.  Nothing is guessed when the old row has no evidence.
update public.receipt_intake_items i
set payee=coalesce(i.payee,nullif(btrim(r.receiver),''),nullif(btrim(i.raw->>'payee'),'')),
    platform=coalesce(i.platform,case
      when coalesce(r.platform,i.raw->>'platform','')~*'(wechat|weixin|微信)' then 'wechat'
      when coalesce(r.platform,i.raw->>'platform','')~*'(alipay|ali[ -]?pay|支付宝)' then 'alipay'
      when nullif(btrim(coalesce(r.platform,i.raw->>'platform','')),'') is not null then 'other'
      else null end),
    platform_evidence=coalesce(i.platform_evidence,nullif(i.raw->>'platformEvidence','')),
    has_fee=coalesce(i.has_fee,case
      when coalesce(r.fee,i.fee,0)>0 then true
      when coalesce(i.raw->>'feeTreatment',i.raw->>'fee_treatment')='no_fee' then false
      else null end),
    tx_date=coalesce(i.tx_date,r.tx_date,case
      when coalesce(i.raw->>'txDate','')~'^\d{4}-\d{2}-\d{2}$' then (i.raw->>'txDate')::date end),
    transaction_status=coalesce(i.transaction_status,nullif(i.raw->>'transactionStatus',''))
from public.receipts r
where r.id=i.id
  and (i.payee is null or i.platform is null or i.platform_evidence is null
       or i.has_fee is null or i.tx_date is null or i.transaction_status is null);

create index if not exists receipt_intake_platform_date_idx
  on public.receipt_intake_items(platform,tx_date desc);

-- A batch conversion may create Type A or Type C, never one half of Type B.  For Type A the
-- accepted receipt and the resulting transaction must name the exact same custody partner and
-- must carry every structured fact the owner requested before accounting is posted.
create or replace function public.enforce_receipt_batch_transaction_flow()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_tx public.txs%rowtype; v_actor text;
begin
  if new.transaction_id is null or new.transaction_id is not distinct from old.transaction_id then
    return new;
  end if;
  select * into v_tx from public.txs where id=new.transaction_id and not deleted;
  if not found then raise exception using errcode='23503', message='receipt transaction does not exist'; end if;
  if v_tx.business_flow='owner_cashbox' then
    raise exception using errcode='23514', message='a receipt batch cannot create one half of an owner-cashbox trade';
  elsif v_tx.business_flow='partner_custody' then
    if new.partner_id is distinct from v_tx.partner_id then
      raise exception using errcode='23514', message='receipt custody partner does not match the Type A transaction';
    end if;
    if exists(select 1 from public.receipt_custody c
              where c.item_id=new.id and c.partner_id is distinct from v_tx.partner_id) then
      raise exception using errcode='23514', message='recorded receipt custody contradicts the Type A transaction';
    end if;
    if nullif(btrim(coalesce(new.payee,'')),'') is null or new.tx_date is null
       or new.platform not in ('wechat','alipay') or new.has_fee is null then
      raise exception using errcode='23514',
        message='Type A receipt requires recipient, date, WeChat/Alipay platform, and fee status';
    end if;
  elsif new.partner_id is not null or exists(
    select 1 from public.receipt_custody c where c.item_id=new.id and c.partner_id is not null) then
    raise exception using errcode='23514', message='a Type C receipt cannot retain partner custody';
  end if;

  if v_tx.business_flow='partner_custody' then
    select id into v_actor from public.app_users where auth_id=auth.uid() and not deleted limit 1;
    insert into public.receipt_custody(item_id,batch_id,partner_id,assigned_by,assignment_reason)
    values(new.id,new.batch_id,v_tx.partner_id,coalesce(v_actor,v_tx.partner_id),
      'Confirmed by the receipt-backed Type A transaction')
    on conflict(item_id) do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists receipt_intake_transaction_flow on public.receipt_intake_items;
create trigger receipt_intake_transaction_flow
  before update of transaction_id on public.receipt_intake_items
  for each row execute function public.enforce_receipt_batch_transaction_flow();

-- Structured receipt facts required by the real workflow.  OCR already returns these values;
-- previously platform and fee/no-fee status survived only inside raw JSON.
alter table public.receipt_extractions add column if not exists platform text;
alter table public.receipt_extractions add column if not exists platform_evidence text;
alter table public.receipt_extractions add column if not exists has_fee boolean;
alter table public.receipt_extractions add column if not exists transaction_status text;

create or replace function public.normalize_receipt_business_fields()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_platform text;
begin
  v_platform := lower(btrim(coalesce(new.platform,new.raw->>'platform','')));
  new.platform := case
    when v_platform ~ '(wechat|weixin|微信)' then 'wechat'
    when v_platform ~ '(alipay|ali[ -]?pay|支付宝)' then 'alipay'
    when v_platform='' then 'unknown'
    else 'other'
  end;
  new.platform_evidence := left(coalesce(new.platform_evidence,new.raw->>'platformEvidence'),300);
  new.transaction_status := left(coalesce(new.transaction_status,new.raw->>'transactionStatus'),80);
  new.has_fee := case
    when coalesce(new.fee_amount,0)>0 then true
    when new.fee_treatment='no_fee' then false
    when new.fee_treatment in ('added_on_top','deducted_from_principal','included_in_total') then true
    else null
  end;
  return new;
end;
$$;
drop trigger if exists receipt_extractions_business_fields on public.receipt_extractions;
create trigger receipt_extractions_business_fields
  before insert or update of raw,platform,platform_evidence,fee_amount,fee_treatment,transaction_status
  on public.receipt_extractions
  for each row execute function public.normalize_receipt_business_fields();

-- Existing extraction rows remain byte-for-byte immutable.  New originals and every correction
-- receive the structured columns; historic values can still be read from their retained raw JSON.
create index if not exists receipt_extractions_platform_idx
  on public.receipt_extractions(platform,tx_date desc);

-- A receipt missing recipient/date/platform/fee status cannot be called validated.  Server OCR
-- routes it to manual review; a staff correction is refused until those exact facts are present.
create or replace function public.require_structured_receipt_before_validation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_x public.receipt_extractions%rowtype;
begin
  if new.state='validated' and new.state is distinct from old.state then
    select * into v_x from public.receipt_extractions
     where document_id=new.id order by version desc limit 1;
    if not found or v_x.tx_date is null or v_x.platform not in ('wechat','alipay')
       or v_x.has_fee is null
       or (nullif(btrim(coalesce(v_x.payee,'')),'') is null
           and nullif(btrim(coalesce(v_x.raw->>'recipientNote',v_x.raw->>'merchantName','')),'') is null) then
      -- An already-deployed older OCR function may still optimistically request `validated`.
      -- Route that server-owned transition to review; interactive staff commands remain strict.
      if nullif(current_setting('app.receipt_request_id',true),'') is not null then
        new.state:='needs_manual_review'; new.counted:=false;
        new.rule_code:='manual_review_required';
        new.rule_reason:='Recipient, date, platform, or fee status needs staff verification';
      else
        raise exception using errcode='23514',
          message='recipient, date, WeChat/Alipay platform, and fee status are required before validation';
      end if;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists receipt_documents_structured_fields on public.receipt_documents;
create trigger receipt_documents_structured_fields
  before update of state on public.receipt_documents
  for each row execute function public.require_structured_receipt_before_validation();

-- Canonical forwarding now supports both real directions.  In Type A, customer evidence is
-- delivered to the exact partner and custody is recorded.  The existing reverse direction
-- (partner evidence to customer) remains unchanged.
create or replace function public.sarraf_forward_receipts_v2(
  p_document_ids jsonb, p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor public.app_users%rowtype; v_doc public.receipt_documents%rowtype;
  v_a public.receipt_transaction_assignments%rowtype; v_to text; v_kind public.party_kind;
  v_from text; v_from_kind public.party_kind; v_forwarding text; d text; v_forwarded integer:=0;
  v_destinations jsonb:='[]'::jsonb; v_result jsonb; v_prev jsonb;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' or public.receipt_request_aal()<>'aal2' then
    raise exception using errcode='42501', message='admin MFA is required to forward receipts';
  end if;
  if p_document_ids is null or jsonb_typeof(p_document_ids)<>'array'
     or jsonb_array_length(p_document_ids)<1 or jsonb_array_length(p_document_ids)>100
     or char_length(btrim(coalesce(p_reason,'')))<8 then
    raise exception using errcode='22023', message='receipts and an 8-character reason are required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_prev from public.receipt_command_log
   where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_prev||jsonb_build_object('replayed',true); end if;
  perform set_config('app.receipt_actor_id',v_actor.id,true);
  perform set_config('app.receipt_reason',left(btrim(p_reason),700),true);
  perform set_config('app.receipt_command_key',p_command_key,true);

  for d in select distinct jsonb_array_elements_text(p_document_ids) order by 1 loop
    select * into v_doc from public.receipt_documents where id=d for update;
    if not found or v_doc.state<>'finalized' or v_doc.transaction_id is null then
      raise exception using errcode='23514', message=format('receipt %s is not finalized',d);
    end if;
    select * into v_a from public.receipt_transaction_assignments
     where transaction_id=v_doc.transaction_id;
    if not found or v_a.flow<>v_doc.flow
       or v_doc.partner_id is distinct from v_a.partner_id
       or v_doc.customer_id is distinct from v_a.customer_id then
      raise exception using errcode='42501', message='receipt no longer matches its transaction assignment';
    end if;

    if v_doc.flow='customer_sells_to_zeman' then
      v_to:=v_a.partner_id; v_kind:='partner';
      v_from:=v_a.customer_id; v_from_kind:='customer';
    elsif v_doc.flow='customer_buys_from_zeman' then
      v_to:=v_a.customer_id; v_kind:='customer';
      v_from:=v_a.partner_id; v_from_kind:='partner';
    else
      raise exception using errcode='23514', message='receipt flow is not forwardable';
    end if;
    if v_to is null then
      raise exception using errcode='23514', message='the exact receipt recipient has not been assigned';
    end if;

    v_forwarding:='fwd-'||md5(d||':'||v_to);
    insert into public.receipt_forwardings(
      id,document_id,batch_id,transaction_id,from_actor_type,from_actor_id,
      to_actor_type,to_actor_id,delivery_channel,delivery_status,forwarded_by,
      forwarded_at,delivered_at,command_key)
    values(v_forwarding,d,v_doc.batch_id,v_doc.transaction_id,v_from_kind,v_from,v_kind,v_to,
      'in_app','delivered',v_actor.id,statement_timestamp(),statement_timestamp(),p_command_key)
    on conflict(document_id,to_actor_id) do nothing;
    if not found then
      raise exception using errcode='23505', message='receipt was already forwarded to its assigned recipient';
    end if;

    if v_kind='partner' then
      insert into public.receipt_custody_ledger(
        document_id,from_partner_id,to_partner_id,transaction_id,reason,actor_id,command_key)
      values(d,null,v_to,v_doc.transaction_id,
        'Customer evidence delivered to the partner holding the purchased currency',
        v_actor.id,p_command_key);
    end if;
    update public.receipt_documents set state='forwarded' where id=d;
    update public.receipt_documents set state='delivered' where id=d;
    insert into public.receipt_notifications(id,forwarding_id,document_id,recipient_id,status)
    values('rn-'||md5(v_forwarding||':'||v_to),v_forwarding,d,v_to,'delivered')
    on conflict(forwarding_id,recipient_id) do nothing;
    v_forwarded:=v_forwarded+1;
    v_destinations:=v_destinations||jsonb_build_object(
      'document_id',d,'to_actor_id',v_to,'to_role',v_kind,'delivery_status','delivered');
  end loop;
  v_result:=jsonb_build_object('forwarded',v_forwarded,'destinations',v_destinations,'replayed',false);
  insert into public.receipt_command_log(actor_id,command_key,operation,result)
  values(v_actor.id,p_command_key,'forward_receipts_v2',v_result);
  return v_result;
end;
$$;

-- Forwarded recipients receive the structured facts, not only amounts hidden from their flow.
drop function if exists public.sarraf_my_forwarded_receipts_v2(integer);
create function public.sarraf_my_forwarded_receipts_v2(p_limit integer default 100)
returns table(
  document_id text, delivery_status public.delivery_status, forwarded_at timestamptz,
  seen_at timestamptz, storage_path text, currency text,
  gross_amount numeric, order_amount numeric, fee_amount numeric, net_amount numeric,
  ref_no text, merchant_order_no text, payee text, platform text, has_fee boolean,
  tx_date date, transaction_id text,
  rate_value numeric, rate_convention text, rate_date date, rate_version bigint,
  gross_usd numeric, fee_usd numeric, net_usd numeric)
language sql security definer stable set search_path = pg_catalog, public as $$
  select f.document_id,f.delivery_status,f.forwarded_at,f.seen_at,d.storage_path,
    x.currency,x.gross_amount,x.order_amount,x.fee_amount,x.net_amount,
    x.ref_no,x.merchant_order_no,x.payee,x.platform,x.has_fee,x.tx_date,f.transaction_id,
    d.rate_value,d.rate_convention,d.rate_date,d.rate_version,
    case when d.rate_value>0 then round(x.gross_amount/d.rate_value,2) end,
    case when d.rate_value>0 then round(x.fee_amount/d.rate_value,2) end,
    case when d.rate_value>0 then round(x.net_amount/d.rate_value,2) end
  from public.receipt_forwardings f
  join public.receipt_documents d on d.id=f.document_id
  left join lateral (
    select e.* from public.receipt_extractions e
     where e.document_id=d.id order by e.version desc limit 1
  ) x on true
  where f.to_actor_id=public.my_app_id()
  order by f.forwarded_at desc
  limit least(greatest(coalesce(p_limit,100),1),300);
$$;

-- Admin-only diagnostics.  security_invoker and the explicit role predicate prevent the view
-- from becoming another route around transaction RLS.
create or replace view public.v_transaction_business_flow_integrity
with (security_invoker=true) as
select t.id,t.code,t.type,t.business_flow,t.partner_id,t.direct,t.pair_id,t.direct_role,
  case
    when t.business_flow='partner_custody' and t.partner_id is null then 'partner_missing'
    when t.business_flow='owner_cashbox' and (not t.direct or t.partner_id is not null) then 'owner_flow_mismatch'
    when t.business_flow='standard' and (t.direct or t.partner_id is not null) then 'standard_flow_mismatch'
    when t.business_flow='owner_cashbox' and (
      select count(*) from public.txs p where p.pair_id=t.pair_id and not p.deleted)<>2 then 'direct_pair_incomplete'
    else null
  end as issue
from public.txs t
where public.is_admin() and not t.deleted;

-- This is the authoritative trade-only custody position for Type A.  It deliberately does not
-- mutate partner_accounts because manual deposits/withdrawals and purchased currency are
-- different facts; consumers can reconcile the two ledgers without double-counting either.
create or replace view public.v_partner_trade_custody
with (security_invoker=true) as
select t.partner_id,t.cur_id,c.code as currency,
  sum(case when t.type='buy' then t.amount else -t.amount end) as custody_amount,
  count(*) as transaction_count,max(t.date) as last_transaction_date
from public.txs t
join public.currencies c on c.id=t.cur_id
where t.business_flow='partner_custody'
  and t.partner_id is not null
  and not t.deleted
  and (public.is_admin() or t.partner_id=public.my_app_id())
group by t.partner_id,t.cur_id,c.code;

-- The existing batch screen can read one normalized detail source for both legacy ingestion and
-- the new business-flow label.  Under security_invoker the source-table RLS still decides which
-- partner/staff member may see each row.
create or replace view public.v_receipt_batch_structured_details
with (security_invoker=true) as
select i.id as receipt_id,i.batch_id,i.transaction_id,
  coalesce(t.business_flow,case when i.partner_id is not null then 'partner_custody' else 'standard' end) as business_flow,
  i.customer_id,i.partner_id,i.currency,i.amount,i.fee,i.net_amount,
  i.payee,i.tx_date,i.platform,i.platform_evidence,i.has_fee,i.transaction_status,
  i.ref_no,i.intake_status,i.counted,i.image_path,i.created_at
from public.receipt_intake_items i
left join public.txs t on t.id=i.transaction_id and not t.deleted
where public.is_admin() or public.my_role()='office' or i.partner_id=public.my_app_id();

revoke all on function public.sarraf_forward_receipts_v2(jsonb,text,text) from public,anon;
grant execute on function public.sarraf_forward_receipts_v2(jsonb,text,text) to authenticated;
revoke all on function public.sarraf_my_forwarded_receipts_v2(integer) from public,anon;
grant execute on function public.sarraf_my_forwarded_receipts_v2(integer) to authenticated;
revoke all on public.v_transaction_business_flow_integrity from public,anon;
grant select on public.v_transaction_business_flow_integrity to authenticated;
revoke all on public.v_partner_trade_custody from public,anon;
grant select on public.v_partner_trade_custody to authenticated;
revoke all on public.v_receipt_batch_structured_details from public,anon;
grant select on public.v_receipt_batch_structured_details to authenticated;

comment on column public.txs.business_flow is
  'partner_custody=A, owner_cashbox=B, standard=C; derived and enforced by the database.';
comment on column public.receipt_extractions.platform is
  'Normalized payment platform: wechat, alipay, other, or unknown.';
comment on column public.receipt_extractions.has_fee is
  'Explicit fee/no-fee fact; null means staff verification is still required.';

commit;
