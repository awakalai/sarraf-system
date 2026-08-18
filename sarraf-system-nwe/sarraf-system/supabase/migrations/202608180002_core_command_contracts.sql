-- ZEMAN canonical command layer.
--
-- All financial browser writes terminate here.  Client-provided ledger/profit/cost rows are
-- ignored and rebuilt from authenticated intent, historical rate snapshots and persisted
-- transaction/account state.  Commands are idempotent, maintenance-aware and audit-visible.

begin;

create or replace function public.sarraf_actor()
returns public.app_users
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;
begin
  select * into v_actor from public.app_users
   where auth_id=auth.uid() and not deleted order by id limit 1;
  if not found then
    raise exception using errcode='42501',message='not authorized';
  end if;
  return v_actor;
end;
$$;

create or replace function public.sarraf_request_aal()
returns text
language plpgsql stable set search_path=pg_catalog,public
as $$
declare v_claims text; v_aal text;
begin
  v_aal:=nullif(current_setting('request.jwt.claim.aal',true),'');
  if v_aal is not null then return v_aal; end if;
  v_claims:=nullif(current_setting('request.jwt.claims',true),'');
  if v_claims is not null then
    begin v_aal:=v_claims::jsonb->>'aal'; exception when others then v_aal:=null; end;
  end if;
  return v_aal;
end;
$$;

create or replace function public.sarraf_require_admin(p_owner boolean default false)
returns public.app_users
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;
begin
  v_actor:=public.sarraf_actor();
  if v_actor.role<>'admin' or (p_owner and coalesce(v_actor.admin_level,'')<>'owner') then
    raise exception using errcode='42501',message=case when p_owner
      then 'only the system owner may perform this command'
      else 'administrator authorization is required' end;
  end if;
  if (nullif(current_setting('request.jwt.claims',true),'') is not null
      or nullif(current_setting('request.jwt.claim.aal',true),'') is not null)
     and public.sarraf_request_aal() is distinct from 'aal2' then
    raise exception using errcode='42501',message='MFA/AAL2 is required';
  end if;
  return v_actor;
end;
$$;

create or replace function public.sarraf_assert_writes_open(p_operation text)
returns void
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_frozen boolean; v_reason text;
begin
  select maintenance_mode,maintenance_reason into v_frozen,v_reason
    from public.control_settings where singleton;
  if coalesce(v_frozen,false) and p_operation not in
    ('set_maintenance_mode','approve_request','reject_request','cancel_approval_request','owner_override_approval') then
    raise exception using errcode='55000',
      message='financial writes are frozen',detail=coalesce(v_reason,'Emergency Freeze');
  end if;
end;
$$;

create or replace function public.sarraf_is_period_closed(p_date timestamptz)
returns boolean
language plpgsql stable security definer set search_path=''
as $$
declare v_closed boolean;v_timezone text;v_business_date date;
begin
  if p_date is null then return false; end if;
  select coalesce(business_timezone,'Asia/Baghdad') into v_timezone
    from public.control_settings where singleton;
  v_business_date:=(p_date at time zone coalesce(v_timezone,'Asia/Baghdad'))::date;
  select exists(select 1 from public.day_closes c where c.close_date>=v_business_date)
    into v_closed;
  return coalesce(v_closed,false);
end;
$$;

create or replace function public.sarraf_assert_period_open(p_date timestamptz)
returns void
language plpgsql security definer set search_path=pg_catalog,public
as $$
begin
  -- Every dated financial writer takes the shared side. Day close takes the exclusive side,
  -- so a command cannot pass the check and then slip a row behind a concurrent close.
  perform pg_advisory_xact_lock_shared(hashtextextended('zeman:accounting-period',0));
  if public.sarraf_is_period_closed(p_date) then
    raise exception using errcode='55000',message='the accounting period is closed';
  end if;
end;
$$;

create or replace function public.sarraf_command_replay(
  p_actor uuid,p_command_key text,p_operation text
) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_row public.financial_commands%rowtype;
begin
  if nullif(btrim(coalesce(p_command_key,'')),'') is null
     or char_length(p_command_key) not between 8 and 220 then
    raise exception using errcode='22023',message='invalid command key';
  end if;
  select * into v_row from public.financial_commands where command_key=p_command_key;
  if not found then return null; end if;
  if v_row.actor_id is distinct from p_actor or v_row.operation is distinct from p_operation then
    raise exception using errcode='23505',message='command key was already used for another intent';
  end if;
  return v_row.result||jsonb_build_object('replayed',true);
end;
$$;

create or replace function public.sarraf_store_command(
  p_actor uuid,p_command_key text,p_operation text,p_result jsonb
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
begin
  insert into public.financial_commands(command_key,actor_id,operation,result)
  values(p_command_key,p_actor,p_operation,coalesce(p_result,'{}'::jsonb));
  return coalesce(p_result,'{}'::jsonb)||jsonb_build_object('replayed',false);
end;
$$;

create or replace function public.sarraf_rate_snapshot_at(p_cur_id text,p_at timestamptz)
returns table(buy_rate numeric,sell_rate numeric,rate_source text,rate_at timestamptz)
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_cur public.currencies%rowtype;
begin
  if lower(p_cur_id)='usd' then
    return query select 1::numeric,1::numeric,'usd'::text,coalesce(p_at,statement_timestamp());
    return;
  end if;
  select * into v_cur from public.currencies where id=p_cur_id;
  if not found then raise exception using errcode='22023',message='unknown currency'; end if;

  return query
  with chosen as (
    select h.buy_rate,h.sell_rate,h.created_at
      from public.rate_history h
     where h.cur_id=p_cur_id and h.created_at<=coalesce(p_at,statement_timestamp())
     order by h.created_at desc,h.id desc limit 1
  )
  select coalesce(nullif(o.buy_rate,0),
           case when p_at is null or (v_cur.rate_updated is not null and v_cur.rate_updated<=p_at)
             then coalesce(nullif(v_cur.buy_rate,0),nullif(v_cur.sell_rate,0)) end),
         coalesce(nullif(o.sell_rate,0),
           case when p_at is null or (v_cur.rate_updated is not null and v_cur.rate_updated<=p_at)
             then coalesce(nullif(v_cur.sell_rate,0),nullif(v_cur.buy_rate,0)) end),
         case when o.created_at is not null then 'rate_history'
              when p_at is null or (v_cur.rate_updated is not null and v_cur.rate_updated<=p_at)
                then 'current' else 'missing' end,
         coalesce(o.created_at,
           case when p_at is null or (v_cur.rate_updated is not null and v_cur.rate_updated<=p_at)
             then coalesce(v_cur.rate_updated,v_cur.created_at) end)
    from (select null::numeric buy_rate,null::numeric sell_rate,null::timestamptz created_at) seed
    left join chosen o on true;
end;
$$;

create or replace function public.sarraf_usd_value_at(
  p_amount numeric,p_cur_id text,p_mode text default 'mid',p_at timestamptz default null
) returns numeric
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_buy numeric; v_sell numeric; v_rate numeric;
begin
  if p_amount is null then return null; end if;
  if lower(p_cur_id)='usd' then return round(p_amount,10); end if;
  select r.buy_rate,r.sell_rate into v_buy,v_sell
    from public.sarraf_rate_snapshot_at(p_cur_id,p_at) r;
  v_rate:=case
    when p_mode='spend' then coalesce(v_sell,v_buy)
    when p_mode='receive' then coalesce(v_buy,v_sell)
    when v_buy>0 and v_sell>0 then (v_buy+v_sell)/2
    else coalesce(v_buy,v_sell) end;
  if not (v_rate>0) then return null; end if;
  return round(p_amount/v_rate,10);
end;
$$;

create or replace function public.sarraf_usd_to_currency_at(
  p_amount_usd numeric,p_cur_id text,p_mode text default 'sell',p_at timestamptz default null
) returns numeric
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_buy numeric; v_sell numeric; v_rate numeric;
begin
  if p_amount_usd is null then return null; end if;
  if lower(p_cur_id)='usd' then return round(p_amount_usd,10); end if;
  select r.buy_rate,r.sell_rate into v_buy,v_sell
    from public.sarraf_rate_snapshot_at(p_cur_id,p_at) r;
  v_rate:=case when p_mode='buy' then coalesce(v_buy,v_sell) else coalesce(v_sell,v_buy) end;
  if not (v_rate>0) then return null; end if;
  return round(p_amount_usd*v_rate,10);
end;
$$;

-- Replace the legacy day-close posting trigger with an as-of-date valuation. A rate saved on a
-- later day must never rewrite the value of an earlier shortage or overage.
create or replace function public.post_day_close_journal()
returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_lines jsonb;l jsonb;v_entry text;v_line integer:=0;v_diff numeric;v_cur text;
  v_code text;v_usd numeric;v_rate numeric;v_draft boolean:=false;v_unvalued text;
  v_date date;v_timezone text;v_as_of timestamptz;
begin
  v_lines:=coalesce(new.lines,'[]'::jsonb);
  if not public.day_close_has_difference(v_lines) then return null;end if;
  v_entry:='je-close-'||new.id;
  if exists(select 1 from public.journal_entries where id=v_entry) then return null;end if;
  select coalesce(business_timezone,'Asia/Baghdad') into v_timezone
    from public.control_settings where singleton;
  v_timezone:=coalesce(v_timezone,'Asia/Baghdad');v_date:=new.close_date;
  v_as_of:=((v_date+1)::timestamp at time zone v_timezone)-interval '1 microsecond';
  for l in select value from jsonb_array_elements(v_lines) loop
    v_diff:=coalesce(nullif(l->>'diff','')::numeric,0);if abs(v_diff)<=0.0000000001 then continue;end if;
    v_cur:=coalesce(nullif(l->>'cur',''),nullif(l->>'cur_id',''));
    if public.sarraf_usd_value_at(abs(v_diff),v_cur,'mid',v_as_of) is null then
      v_draft:=true;v_unvalued:=coalesce(v_unvalued||'، ','')||coalesce(l->>'code',v_cur,'?');end if;
  end loop;
  insert into public.journal_entries(id,status,business_date,posted_at,source_type,source_id,actor_id,description)
  values(v_entry,(case when v_draft then 'draft' else 'posted' end)::public.journal_status,v_date,
    case when v_draft then null else statement_timestamp() end,'day_close',new.id,new.closed_by,
    left(case when v_draft then format('USD rate missing at close for %s',v_unvalued)
      else coalesce(nullif(btrim(new.note),''),'day-close cash difference') end,500));
  if v_draft then return null;end if;
  for l in select value from jsonb_array_elements(v_lines) loop
    v_diff:=coalesce(nullif(l->>'diff','')::numeric,0);if abs(v_diff)<=0.0000000001 then continue;end if;
    v_cur:=coalesce(nullif(l->>'cur',''),nullif(l->>'cur_id',''));
    select code into v_code from public.currencies where id=v_cur;
    v_usd:=public.sarraf_usd_value_at(abs(v_diff),v_cur,'mid',v_as_of);
    v_rate:=case when v_usd>0 then abs(v_diff)/v_usd else 1 end;
    v_line:=v_line+1;
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,
      base_rate,rate_source,rate_date,memo)
    values(v_entry,v_line,'acc-1000',(case when v_diff>0 then 'debit' else 'credit' end)::public.entry_side,
      v_code,abs(v_diff),v_usd,v_rate,'rate_history',v_date,
      case when v_diff>0 then 'cash overage' else 'cash shortage' end);
    v_line:=v_line+1;
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,
      base_rate,rate_source,rate_date,memo)
    values(v_entry,v_line,'acc-5910',(case when v_diff>0 then 'credit' else 'debit' end)::public.entry_side,
      v_code,abs(v_diff),v_usd,v_rate,'rate_history',v_date,'cash over and short');
  end loop;
  return null;
end;
$$;

-- Frozen WAC at a point in time. Direct/owner-cashbox pairs never enter shared inventory.
create or replace function public.sarraf_inventory_snapshot_at(
  p_cur_id text,p_as_of timestamptz default null,p_exclude_tx_id text default null
) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare r public.txs%rowtype; v_qty numeric:=0; v_cost numeric:=0; v_known boolean:=true;
  v_buy_cost numeric; v_used numeric; v_oversold numeric:=0;
begin
  for r in select * from public.txs t
    where not t.deleted and not coalesce(t.direct,false) and t.cur_id=p_cur_id
      and (p_exclude_tx_id is null or t.id<>p_exclude_tx_id)
      and (p_as_of is null or t.date<=p_as_of)
    order by t.date,t.code nulls last,t.id
  loop
    if r.type='buy' then
      v_buy_cost:=coalesce(nullif(r.buy_total,0),nullif(r.cost_basis_usd,0),
        public.sarraf_usd_value_at(abs(r.total),r.against_id,'spend',r.date));
      v_qty:=v_qty+abs(r.amount);
      if v_buy_cost is null then v_known:=false; else v_cost:=v_cost+v_buy_cost; end if;
    else
      if abs(r.amount)>v_qty then v_oversold:=v_oversold+abs(r.amount)-greatest(v_qty,0); end if;
      v_used:=least(abs(r.amount),greatest(v_qty,0));
      if v_used>0 and v_known and v_qty>0 then v_cost:=v_cost-v_used*(v_cost/v_qty); end if;
      v_qty:=greatest(0,v_qty-v_used);
      if v_qty<=0.0000000001 then v_qty:=0;v_cost:=0;v_known:=true; end if;
    end if;
  end loop;
  return jsonb_build_object('cur_id',p_cur_id,'qty',round(v_qty,10),'cost_usd',round(v_cost,10),
    'cost_complete',v_known,'missing_cost_rows',case when v_known then 0 else 1 end,
    'oversold',round(v_oversold,10),
    'avg_usd_rate',case when v_known and v_qty>0 then round(v_cost/v_qty,10) end);
end;
$$;

create or replace function public.sarraf_approval_context()
returns boolean language sql stable set search_path=pg_catalog
as $$ select nullif(current_setting('sarraf.approval_id',true),'') is not null $$;

create or replace function public.sarraf_queue_approval(
  p_operation text,p_subject_key text,p_payload jsonb,p_amount_usd numeric,
  p_reason text,p_command_key text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype; v_id text; v_hours integer; v_existing public.approval_requests%rowtype;
begin
  v_actor:=public.sarraf_require_admin(false);
  select * into v_existing from public.approval_requests where request_key=p_command_key;
  if found then
    if v_existing.maker_auth_id is distinct from v_actor.auth_id
       or v_existing.operation is distinct from p_operation then
      raise exception using errcode='23505',
        message='approval command key was already used for another intent';
    end if;
    return jsonb_build_object('approval_required',true,'approval_id',v_existing.id,
      'status',v_existing.status,'replayed',true);
  end if;
  select approval_expiry_hours into v_hours from public.control_settings where singleton;
  v_id:='approval-'||md5(v_actor.auth_id::text||':'||p_command_key);
  insert into public.approval_requests(id,request_key,operation,subject_key,payload,amount_usd,
    reason,maker_auth_id,maker_app_id,maker_name,expires_at)
  values(v_id,p_command_key,p_operation,nullif(p_subject_key,''),coalesce(p_payload,'{}'::jsonb),
    p_amount_usd,left(p_reason,700),v_actor.auth_id,v_actor.id,v_actor.name,
    statement_timestamp()+make_interval(hours=>coalesce(v_hours,24)));
  insert into public.approval_events(approval_id,event,actor_auth_id,actor_app_id,actor_name,detail)
  values(v_id,'requested',v_actor.auth_id,v_actor.id,v_actor.name,left(p_reason,700));
  return jsonb_build_object('approval_required',true,'approval_id',v_id,'status','pending','replayed',false);
end;
$$;

create or replace function public.sarraf_requires_approval(p_operation text,p_amount_usd numeric,p_has_diff boolean default false)
returns boolean
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare c public.control_settings%rowtype;
begin
  if public.sarraf_approval_context() then return false; end if;
  select * into c from public.control_settings where singleton;
  return case p_operation
    when 'commit_transactions' then c.transaction_approval_usd is not null and p_amount_usd>=c.transaction_approval_usd
    when 'post_ledger' then c.cash_approval_usd is not null and p_amount_usd>=c.cash_approval_usd
    when 'account_move' then c.cash_approval_usd is not null and p_amount_usd>=c.cash_approval_usd
    when 'account_transfer' then c.transfer_approval_usd is not null and p_amount_usd>=c.transfer_approval_usd
    when 'edit_transaction' then c.require_edit_approval
    when 'void_transaction' then c.require_void_approval
    when 'close_day' then c.require_day_close_diff_approval and p_has_diff
    else false end;
end;
$$;

create or replace function public.sarraf_write_audit(p_actor text,p_action text,p_detail text)
returns void language plpgsql security definer set search_path=pg_catalog,public
as $$
begin
  insert into public.audit(id,date,user_id,action,detail)
  values('audit-'||md5(coalesce(p_actor,'')||':'||txid_current()::text||':'||clock_timestamp()::text),
    statement_timestamp(),p_actor,left(coalesce(p_action,'کردار'),200),left(p_detail,2000));
end;
$$;

-- Every command that can remove physical money uses the same location lock.  This closes the
-- classic read-balance/write-row race between two browser sessions without introducing a
-- mutable balance column that could drift away from the append-only ledger.
create or replace function public.sarraf_locked_cash_balance(p_cur_id text,p_partner_id text default null)
returns numeric
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_balance numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'zeman:cash-location:'||p_cur_id||':'||coalesce(p_partner_id,'main'),0));
  select coalesce(sum(amount),0) into v_balance from public.ledger
   where cur_id=p_cur_id and partner_id is not distinct from p_partner_id;
  return v_balance;
end;
$$;

-- Pending recognition and later cash settlement are separate facts.  The legacy settlement
-- commands already posted the journal/control-account event, but did not mirror the physical
-- cash movement into the operational ledger.  One append-only trigger now covers both direct
-- administrator settlement and confirmed office settlement, plus their exact reversals.
create or replace function public.sarraf_post_payment_ledger()
returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_tx public.txs%rowtype;v_cur_code text;v_delta numeric;v_balance numeric;
  v_original public.ledger%rowtype;
begin
  perform public.sarraf_require_admin(false);
  perform public.sarraf_assert_writes_open('transaction_settlement');
  perform public.sarraf_assert_period_open(new.created_at);
  select * into v_tx from public.txs where id=new.transaction_id and not deleted;
  if not found then raise exception using errcode='P0002',message='settlement transaction not found';end if;
  select code into v_cur_code from public.currencies where id=v_tx.against_id;
  if new.currency is distinct from v_cur_code or abs(new.amount-v_tx.total)>0.0000000001 then
    raise exception using errcode='23514',message='settlement event does not match its transaction';end if;

  if new.event_kind='settled' then
    v_delta:=case when v_tx.type='buy' then -abs(v_tx.total) else abs(v_tx.total) end;
    v_balance:=public.sarraf_locked_cash_balance(v_tx.against_id,null);
    if v_delta<0 and v_balance+v_delta< -0.0000000001 then
      raise exception using errcode='23514',message='main cashbox has insufficient balance for settlement';end if;
    insert into public.ledger(id,type,cur_id,amount,partner_id,tx_id,note,date,command_key,created_by)
    values('led-pay-'||md5(new.id::text),'settlement',v_tx.against_id,v_delta,null,v_tx.id,
      left('transaction settlement — '||new.reason,1000),new.created_at,new.command_key,new.actor_id);
  elsif new.event_kind='settlement_reversed' then
    select l.* into v_original
      from public.transaction_payment_events e
      join public.ledger l on l.id='led-pay-'||md5(e.id::text)
     where e.transaction_id=v_tx.id and e.event_kind='settled'
       and not exists(select 1 from public.ledger r where r.reversal_of=l.id)
     order by e.created_at desc,e.id desc limit 1;
    if not found then
      raise exception using errcode='P0002',message='active settlement cash movement not found';end if;
    v_balance:=public.sarraf_locked_cash_balance(v_original.cur_id,null);
    if -v_original.amount<0 and v_balance-v_original.amount< -0.0000000001 then
      raise exception using errcode='23514',
        message='main cashbox has insufficient balance to reverse settlement';end if;
    insert into public.ledger(id,type,owner,investor_id,cur_id,amount,partner_id,tx_id,note,date,
      reversal_of,command_key,created_by)
    values('led-pay-rev-'||md5(new.id::text),'reversal',v_original.owner,v_original.investor_id,
      v_original.cur_id,-v_original.amount,v_original.partner_id,v_original.tx_id,
      left('settlement reversal — '||new.reason,1000),new.created_at,v_original.id,new.command_key,new.actor_id);
  end if;
  return new;
end;
$$;
drop trigger if exists transaction_payment_operational_ledger on public.transaction_payment_events;
create trigger transaction_payment_operational_ledger
  after insert on public.transaction_payment_events
  for each row execute function public.sarraf_post_payment_ledger();

create or replace function public.sarraf_post_ledger_command(
  p_ledger jsonb,p_command_key text,p_action text,p_detail text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype; v_replay jsonb; v_result jsonb; x jsonb;
  v_max_usd numeric:=0; v_amount numeric; v_cur text; v_id text; v_date timestamptz;
  v_partner text; v_investor text; v_owner text; v_type text; v_rows jsonb:='[]'::jsonb;
  v_count integer;v_main_delta numeric;v_partner_delta numeric;v_balance numeric;
  v_investor_balance numeric;v_distinct_ids integer;v_cur_max text;
begin
  v_actor:=public.sarraf_require_admin(false);
  perform public.sarraf_assert_writes_open('post_ledger');
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text||':'||p_command_key,0));
  v_replay:=public.sarraf_command_replay(v_actor.auth_id,p_command_key,'post_ledger');
  if v_replay is not null then return v_replay; end if;
  if jsonb_typeof(p_ledger)<>'array' or jsonb_array_length(p_ledger) not between 1 and 50 then
    raise exception using errcode='22023',message='ledger command must contain 1 to 50 rows';
  end if;
  v_count:=jsonb_array_length(p_ledger);
  for x in select value from jsonb_array_elements(p_ledger) loop
    v_amount:=nullif(x->>'amount','')::numeric; v_cur:=nullif(btrim(x->>'cur_id'),'');
    if v_amount is null or v_amount=0 or not exists(select 1 from public.currencies where id=v_cur) then
      raise exception using errcode='22023',message='invalid ledger row';
    end if;
    v_date:=coalesce(nullif(x->>'date','')::timestamptz,statement_timestamp());
    perform public.sarraf_assert_period_open(v_date);
    v_max_usd:=greatest(v_max_usd,coalesce(abs(public.sarraf_usd_value_at(v_amount,v_cur,'mid',null)),0));
  end loop;

  -- This endpoint has only three valid intents: one capital movement, one expense/payout, or
  -- one balanced main↔partner transfer.  It is not a generic browser escape hatch into ledger.
  if v_count=1 then
    x:=p_ledger->0;v_type:=nullif(btrim(x->>'type'),'');v_amount:=(x->>'amount')::numeric;
    v_cur:=nullif(btrim(x->>'cur_id'),'');v_owner:=nullif(btrim(x->>'owner'),'');
    v_investor:=nullif(btrim(x->>'investor_id'),'');v_partner:=nullif(btrim(x->>'partner_id'),'');
    if nullif(btrim(x->>'tx_id'),'') is not null or v_partner is not null then
      raise exception using errcode='22023',message='manual ledger rows cannot name a transaction or custody partner';
    elsif v_type in ('deposit','withdraw') then
      if (v_type='deposit' and v_amount<=0) or (v_type='withdraw' and v_amount>=0)
         or v_owner not in ('self','investor')
         or (v_owner='self' and v_investor is not null)
         or (v_owner='investor' and (v_investor is null or not exists(
           select 1 from public.app_users where id=v_investor and role='investor' and not deleted))) then
        raise exception using errcode='22023',message='invalid capital movement';end if;
    elsif v_type='expense' then
      if v_amount>=0 or v_owner is not null or v_investor is not null then
        raise exception using errcode='22023',message='invalid expense movement';end if;
    elsif v_type='investor_payout' then
      if v_amount>=0 or v_owner is not null or v_investor is null or not exists(
        select 1 from public.app_users where id=v_investor and role='investor' and not deleted) then
        raise exception using errcode='22023',message='invalid investor payout';end if;
    else
      raise exception using errcode='22023',message='unsupported manual ledger movement';
    end if;

    v_balance:=public.sarraf_locked_cash_balance(v_cur,null);
    if v_amount<0 and v_balance+v_amount<0 then
      raise exception using errcode='23514',message='main cashbox has insufficient balance';end if;
    if v_type='withdraw' and v_owner='investor' then
      perform pg_advisory_xact_lock(hashtextextended('zeman:investor-capital:'||v_investor||':'||v_cur,0));
      select coalesce(sum(amount),0) into v_investor_balance from public.ledger
       where cur_id=v_cur and owner='investor' and investor_id=v_investor
         and type in ('deposit','withdraw');
      if v_investor_balance+v_amount<0 then
        raise exception using errcode='23514',message='investor capital cannot become negative';end if;
    end if;
  elsif v_count=2 then
    select min(nullif(btrim(e->>'cur_id'),'')),max(nullif(btrim(e->>'cur_id'),'')),
           max(nullif(btrim(e->>'partner_id'),'')),
           coalesce(sum((e->>'amount')::numeric) filter(where nullif(btrim(e->>'partner_id'),'') is null),0),
           coalesce(sum((e->>'amount')::numeric) filter(where nullif(btrim(e->>'partner_id'),'') is not null),0),
           count(distinct nullif(btrim(e->>'id'),''))
      into v_cur,v_cur_max,v_partner,v_main_delta,v_partner_delta,v_distinct_ids
      from jsonb_array_elements(p_ledger) e;
    if v_cur is distinct from v_cur_max or v_partner is null or v_distinct_ids<>2
       or abs(v_main_delta+v_partner_delta)>0.0000000001
       or v_main_delta=0 or v_partner_delta=0
       or exists(select 1 from jsonb_array_elements(p_ledger) e
          where e->>'type'<>'transfer'
             or nullif(btrim(e->>'owner'),'') is not null
             or nullif(btrim(e->>'investor_id'),'') is not null
             or nullif(btrim(e->>'tx_id'),'') is not null)
       or (select count(*) from jsonb_array_elements(p_ledger) e
            where nullif(btrim(e->>'partner_id'),'') is null)<>1
       or not exists(select 1 from public.app_users where id=v_partner and role='partner' and not deleted) then
      raise exception using errcode='22023',message='partner transfer must be one exact balanced pair';end if;
    -- Main is always locked first, then the partner, in both transfer directions.
    v_balance:=public.sarraf_locked_cash_balance(v_cur,null);
    v_investor_balance:=public.sarraf_locked_cash_balance(v_cur,v_partner);
    if v_balance+v_main_delta<0 or v_investor_balance+v_partner_delta<0 then
      raise exception using errcode='23514',message='transfer source has insufficient balance';end if;
  else
    raise exception using errcode='22023',message='manual ledger command shape is not supported';
  end if;

  if public.sarraf_requires_approval('post_ledger',v_max_usd,false) then
    return public.sarraf_queue_approval('post_ledger',null,
      jsonb_build_object('p_ledger',p_ledger,'p_command_key',p_command_key,'p_action',p_action,'p_detail',p_detail),
      v_max_usd,p_detail,p_command_key);
  end if;

  for x in select value from jsonb_array_elements(p_ledger) loop
    v_id:=nullif(btrim(x->>'id'),''); v_type:=nullif(btrim(x->>'type'),'');
    v_cur:=nullif(btrim(x->>'cur_id'),''); v_amount:=(x->>'amount')::numeric;
    v_date:=coalesce(nullif(x->>'date','')::timestamptz,statement_timestamp());
    v_partner:=nullif(btrim(x->>'partner_id'),''); v_investor:=nullif(btrim(x->>'investor_id'),'');
    v_owner:=nullif(btrim(x->>'owner'),'');
    perform public.sarraf_assert_period_open(v_date);
    if v_id is null or v_type is null then raise exception using errcode='22023',message='ledger identity is required'; end if;
    if v_partner is not null and not exists(select 1 from public.app_users where id=v_partner and role='partner' and not deleted) then
      raise exception using errcode='22023',message='invalid partner ledger row'; end if;
    if v_investor is not null and not exists(select 1 from public.app_users where id=v_investor and role='investor' and not deleted) then
      raise exception using errcode='22023',message='invalid investor ledger row'; end if;
    insert into public.ledger(id,type,owner,investor_id,cur_id,amount,partner_id,tx_id,note,date,
      command_key,created_by,commission_rate_snapshot,commission_amount_snapshot)
    values(v_id,v_type,v_owner,v_investor,v_cur,v_amount,v_partner,nullif(x->>'tx_id',''),
      left(x->>'note',1000),v_date,p_command_key,v_actor.id,null,null);
    v_rows:=v_rows||to_jsonb(v_id);
  end loop;
  perform public.sarraf_write_audit(v_actor.id,p_action,p_detail);
  v_result:=jsonb_build_object('ok',true,'ledger_ids',v_rows);
  return public.sarraf_store_command(v_actor.auth_id,p_command_key,'post_ledger',v_result);
end;
$$;

create or replace function public.sarraf_commit_transactions(
  p_txs jsonb,p_ledger jsonb,p_batch_id text,p_command_key text,p_action text,p_detail text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype; v_replay jsonb; v_result jsonb; x jsonb;
  v_count integer; v_max_usd numeric:=0; v_id text; v_code integer; v_type text;
  v_cp text; v_cp_name text; v_cur text; v_against text; v_partner text; v_status text;
  v_amount numeric; v_rate numeric; v_total numeric; v_expected numeric; v_tol numeric; v_date timestamptz;
  v_direct boolean; v_pair text; v_role text; v_own boolean; v_flow text;
  v_buy_total numeric; v_buy_rate numeric; v_cost numeric; v_profit numeric; v_profit_cur text;
  v_inv jsonb; v_qty numeric; v_avg numeric; v_revenue_usd numeric; v_against_cost numeric;
  v_partner_rate numeric; v_partner_fee numeric; v_saved jsonb:='[]'::jsonb;
  v_direct_count integer;v_buy_count integer;v_sell_count integer;v_pair_count integer;
  v_cur_count integer;v_against_count integer;v_amount_count integer;v_own_count integer;
  v_partner_count integer;v_role_count integer;v_cash_balance numeric;b record;
begin
  v_actor:=public.sarraf_require_admin(false);
  perform public.sarraf_assert_writes_open('commit_transactions');
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text||':'||p_command_key,0));
  v_replay:=public.sarraf_command_replay(v_actor.auth_id,p_command_key,'commit_transactions');
  if v_replay is not null then return v_replay; end if;
  if jsonb_typeof(p_txs)<>'array' then raise exception using errcode='22023',message='transactions must be an array'; end if;
  v_count:=jsonb_array_length(p_txs);
  if v_count not between 1 and 2 then raise exception using errcode='22023',message='one transaction or one direct pair is required'; end if;

  -- Validate every economic intent and calculate approval exposure before writing anything.
  for x in select value from jsonb_array_elements(p_txs) loop
    v_amount:=nullif(x->>'amount','')::numeric; v_rate:=nullif(x->>'rate','')::numeric;
    v_cur:=nullif(btrim(x->>'cur_id'),''); v_against:=nullif(btrim(x->>'against_id'),'');
    v_total:=nullif(x->>'total','')::numeric; v_date:=coalesce(nullif(x->>'date','')::timestamptz,statement_timestamp());
    if not (v_amount>0 and v_rate>0 and v_total>0) or v_cur=v_against
       or not exists(select 1 from public.currencies where id=v_cur)
       or not exists(select 1 from public.currencies where id=v_against) then
      raise exception using errcode='22023',message='invalid transaction amount, rate or currency';
    end if;
    v_expected:=v_amount*v_rate;
    select greatest(0.00000001,power(10::numeric,-least(greatest(dec,0),10))/2) into v_tol
      from public.currencies where id=v_against;
    if abs(v_total-v_expected)>v_tol then
      raise exception using errcode='23514',message='transaction total does not match amount times rate';
    end if;
    perform public.sarraf_assert_period_open(v_date);
    v_max_usd:=greatest(v_max_usd,coalesce(abs(public.sarraf_usd_value_at(v_total,v_against,'mid',v_date)),0));
  end loop;

  select count(*) filter(where coalesce((e->>'direct')::boolean,false)),
         count(*) filter(where e->>'type'='buy'),count(*) filter(where e->>'type'='sell'),
         count(distinct nullif(btrim(e->>'pair_id'),'')),count(distinct e->>'cur_id'),
         count(distinct e->>'against_id'),count(distinct nullif(e->>'amount','')::numeric),
         count(*) filter(where coalesce((e->>'own_money')::boolean,false)),
         count(*) filter(where nullif(btrim(e->>'partner_id'),'') is not null),
         count(*) filter(where e->>'direct_role'=e->>'type')
    into v_direct_count,v_buy_count,v_sell_count,v_pair_count,v_cur_count,v_against_count,
         v_amount_count,v_own_count,v_partner_count,v_role_count
    from jsonb_array_elements(p_txs) e;
  if v_count=2 then
    if v_direct_count<>2 or v_buy_count<>1 or v_sell_count<>1 or v_pair_count<>1
       or v_cur_count<>1 or v_against_count<>1 or v_amount_count<>1
       or v_own_count<>2 or v_partner_count<>0 or v_role_count<>2 then
      raise exception using errcode='23514',
        message='two-row transaction command must be one exact owner-cashbox buy/sell pair';end if;
  elsif v_direct_count<>0 then
    raise exception using errcode='23514',message='owner-cashbox trade requires both matching sides';
  end if;

  -- WAC and cash-location checks run under stable locks. Two concurrent sales therefore cannot
  -- both consume the same inventory, and a partner can never sell another partner's custody.
  for v_cur in select distinct e->>'cur_id' from jsonb_array_elements(p_txs) e
    where not coalesce((e->>'direct')::boolean,false) order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended('zeman:inventory:'||v_cur,0));
  end loop;
  for b in
    with intents as (
      select e->>'type' tx_type,e->>'cur_id' cur_id,e->>'against_id' against_id,
             (e->>'amount')::numeric amount,(e->>'total')::numeric total,
             coalesce(nullif(e->>'status',''),'completed') tx_status,
             coalesce((e->>'direct')::boolean,false) direct,
             nullif(btrim(e->>'partner_id'),'') partner_id,
             coalesce((select u.rate from public.app_users u where u.id=e->>'partner_id'),0) partner_rate
        from jsonb_array_elements(p_txs) e
    ), deltas as (
      select cur_id,case when direct then null else partner_id end partner_id,
             sum(case when tx_type='buy'
               then amount-case when partner_id is not null then amount*partner_rate/100 else 0 end
               else -amount end) delta
        from intents group by cur_id,case when direct then null else partner_id end
      union all
      select against_id,null::text,
             sum(case when tx_type='buy' then -total else total end)
        from intents where tx_status='completed' group by against_id
    )
    select cur_id,partner_id,sum(delta) delta from deltas
     group by cur_id,partner_id order by cur_id,partner_id nulls first
  loop
    v_cash_balance:=public.sarraf_locked_cash_balance(b.cur_id,b.partner_id);
    if b.delta<0 and v_cash_balance+b.delta< -0.0000000001 then
      raise exception using errcode='23514',message='cash location has insufficient balance',
        detail=format('currency %s, custody %s, available %s, change %s',
          b.cur_id,coalesce(b.partner_id,'main'),v_cash_balance,b.delta);end if;
  end loop;
  if public.sarraf_requires_approval('commit_transactions',v_max_usd,false) then
    return public.sarraf_queue_approval('commit_transactions',coalesce(p_batch_id,''),
      jsonb_build_object('p_txs',p_txs,'p_ledger','[]'::jsonb,'p_batch_id',p_batch_id,
        'p_command_key',p_command_key,'p_action',p_action,'p_detail',p_detail),
      v_max_usd,p_detail,p_command_key);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('zeman:transaction-code',0));
  select coalesce(max(code),0) into v_code from public.txs;
  for x in select value from jsonb_array_elements(p_txs) loop
    v_id:=nullif(btrim(x->>'id'),''); v_type:=nullif(btrim(x->>'type'),'');
    v_cp:=nullif(btrim(x->>'cp_id'),''); v_cp_name:=nullif(btrim(x->>'cp_name'),'');
    v_cur:=nullif(btrim(x->>'cur_id'),''); v_against:=nullif(btrim(x->>'against_id'),'');
    v_amount:=(x->>'amount')::numeric; v_rate:=(x->>'rate')::numeric;
    v_total:=round((x->>'total')::numeric,10); v_partner:=nullif(btrim(x->>'partner_id'),'');
    v_status:=coalesce(nullif(x->>'status',''),'completed');
    v_date:=coalesce(nullif(x->>'date','')::timestamptz,statement_timestamp());
    v_direct:=coalesce((x->>'direct')::boolean,false); v_pair:=nullif(btrim(x->>'pair_id'),'');
    v_role:=nullif(btrim(x->>'direct_role'),''); v_own:=coalesce((x->>'own_money')::boolean,false);
    if v_id is null or v_type not in ('buy','sell') or v_status not in ('completed','pending') then
      raise exception using errcode='22023',message='invalid transaction identity or state'; end if;
    if v_cp is null and v_cp_name is null then raise exception using errcode='22023',message='counterparty is required'; end if;
    if v_cp is not null and not exists(select 1 from public.app_users where id=v_cp and role='customer' and not deleted) then
      raise exception using errcode='22023',message='registered counterparty is invalid'; end if;
    if v_cp is not null then select name into v_cp_name from public.app_users where id=v_cp;end if;
    if v_status='pending' and v_cp is null then raise exception using errcode='22023',message='pending transaction requires a registered customer'; end if;
    if v_partner is not null and not exists(select 1 from public.app_users where id=v_partner and role='partner' and not deleted) then
      raise exception using errcode='22023',message='transaction partner is invalid'; end if;
    if not v_direct and v_partner is null
       and exists(select 1 from public.currencies where id=v_cur and external) then
      raise exception using errcode='23514',message='external currency requires an explicit custody partner';end if;

    v_flow:=case when v_direct then 'owner_cashbox' when v_partner is not null then 'partner_custody' else 'standard' end;
    if v_direct and (v_count<>2 or not v_own or v_partner is not null or v_pair is null or v_role<>v_type) then
      raise exception using errcode='23514',message='direct trade must be one owner-funded buy/sell pair'; end if;
    if not v_direct and (v_pair is not null or v_role is not null or v_own) then
      raise exception using errcode='23514',message='standard trade cannot carry direct-pair fields'; end if;

    v_buy_total:=null;v_buy_rate:=null;v_cost:=null;v_profit:=null;v_profit_cur:=null;
    if not v_direct and v_type='buy' then
      v_buy_total:=public.sarraf_usd_value_at(v_total,v_against,'spend',v_date);
      if v_buy_total is null then raise exception using errcode='22023',message='a historical USD rate is required for the buy cost snapshot'; end if;
      v_buy_rate:=round(v_buy_total/v_amount,10);v_cost:=v_buy_total;
    elsif not v_direct and v_type='sell' then
      v_inv:=public.sarraf_inventory_snapshot_at(v_cur,v_date,null);
      v_qty:=coalesce((v_inv->>'qty')::numeric,0);v_avg:=nullif(v_inv->>'avg_usd_rate','')::numeric;
      if v_amount>v_qty+0.0000000001 then
        raise exception using errcode='23514',message='sale would create negative inventory',
          detail=format('available %s, requested %s',v_qty,v_amount); end if;
      if v_avg is null then raise exception using errcode='23514',message='inventory cost basis is incomplete'; end if;
      v_cost:=round(v_avg*v_amount,10);v_buy_total:=v_cost;v_buy_rate:=v_avg;
      v_against_cost:=public.sarraf_usd_to_currency_at(v_cost,v_against,'sell',v_date);
      if v_against_cost is null then raise exception using errcode='22023',message='historical sale currency rate is required'; end if;
      v_profit:=round(v_total-v_against_cost,10);v_profit_cur:=v_against;
    elsif v_direct and v_type='sell' then
      select (b->>'total')::numeric into v_buy_total
      from jsonb_array_elements(p_txs) b where b->>'type'='buy' and b->>'pair_id'=v_pair limit 1;
      if v_buy_total is null then raise exception using errcode='23514',message='direct pair is missing its buy side'; end if;
      v_buy_rate:=v_buy_total/v_amount;v_profit:=round(v_total-v_buy_total,10);v_profit_cur:=v_against;
    end if;

    v_code:=v_code+1;
    insert into public.txs(id,code,type,cp_id,cp_name,cur_id,amount,rate,against_id,total,
      partner_id,status,paid_at,profit,profit_cur_id,note,date,edited,deleted,direct,pair_id,
      direct_role,own_money,buy_rate,buy_total,cost_basis_usd,partner_rate_snapshot,
      partner_fee_snapshot,business_flow,version_no)
    values(v_id,v_code,v_type,v_cp,left(v_cp_name,160),v_cur,v_amount,v_rate,v_against,v_total,
      v_partner,v_status,null,v_profit,v_profit_cur,left(x->>'note',1000),v_date,false,false,
      v_direct,v_pair,v_role,v_own,v_buy_rate,v_buy_total,v_cost,
      case when v_partner is not null then (select rate from public.app_users where id=v_partner) end,
      case when v_partner is not null and v_type='buy'
        then round(v_amount*(select rate from public.app_users where id=v_partner)/100,10) end,
      v_flow,1);

    -- Server-owned physical/custody ledger.  The browser's p_ledger is intentionally ignored.
    insert into public.ledger(id,type,cur_id,amount,partner_id,tx_id,note,date,command_key,created_by)
    values('led-'||md5(v_id||':currency'),v_type,v_cur,
      case when v_type='buy' then v_amount else -v_amount end,v_partner,v_id,null,v_date,p_command_key,v_actor.id);
    if v_partner is not null and v_type='buy' then
      select rate into v_partner_rate from public.app_users where id=v_partner;
      v_partner_fee:=round(v_amount*coalesce(v_partner_rate,0)/100,10);
      if v_partner_fee>0 then
        insert into public.ledger(id,type,cur_id,amount,partner_id,tx_id,note,date,command_key,created_by,
          commission_rate_snapshot,commission_amount_snapshot)
        values('led-'||md5(v_id||':partner-fee'),'partner_fee',v_cur,-v_partner_fee,v_partner,v_id,
          format('partner commission %s%%',v_partner_rate),v_date,p_command_key,v_actor.id,v_partner_rate,v_partner_fee);
      end if;
    end if;
    if v_status='completed' then
      insert into public.ledger(id,type,cur_id,amount,tx_id,note,date,command_key,created_by)
      values('led-'||md5(v_id||':settlement'),case when v_direct then 'direct_'||v_type else v_type end,
        v_against,case when v_type='buy' then -v_total else v_total end,v_id,
        case when v_direct then 'owner cashbox' end,v_date,p_command_key,v_actor.id);
    end if;
    insert into public.tx_versions(tx_id,tx_code,version_no,action,after_data,command_key,
      actor_auth_id,actor_app_id)
    values(v_id,v_code,1,'created',(select to_jsonb(t) from public.txs t where t.id=v_id),
      p_command_key,v_actor.auth_id,v_actor.id);
    v_saved:=v_saved||(select to_jsonb(t) from public.txs t where t.id=v_id);
  end loop;

  if p_batch_id is not null and v_count=1 then
    update public.receipt_batches set tx_id=(v_saved->0->>'id') where id=p_batch_id and tx_id is null;
  end if;
  perform public.sarraf_write_audit(v_actor.id,p_action,p_detail);
  v_result:=jsonb_build_object('ok',true,'transactions',v_saved);
  return public.sarraf_store_command(v_actor.auth_id,p_command_key,'commit_transactions',v_result);
end;
$$;

create or replace function public.sarraf_edit_transaction(
  p_tx jsonb,p_ledger jsonb,p_command_key text,p_action text,p_detail text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype; v_old public.txs%rowtype; v_new public.txs%rowtype;
  v_replay jsonb; v_result jsonb; v_id text;
begin
  v_actor:=public.sarraf_require_admin(false);perform public.sarraf_assert_writes_open('edit_transaction');
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text||':'||p_command_key,0));
  v_replay:=public.sarraf_command_replay(v_actor.auth_id,p_command_key,'edit_transaction');
  if v_replay is not null then return v_replay; end if;
  v_id:=nullif(btrim(p_tx->>'id'),'');
  select * into v_old from public.txs where id=v_id for update;
  if not found or v_old.deleted then raise exception using errcode='P0002',message='active transaction not found'; end if;
  if public.sarraf_requires_approval('edit_transaction',null,false) then
    return public.sarraf_queue_approval('edit_transaction',v_id,
      jsonb_build_object('p_tx',p_tx,'p_ledger','[]'::jsonb,'p_command_key',p_command_key,
        'p_action',p_action,'p_detail',p_detail),null,p_detail,p_command_key);
  end if;
  -- Posted economics are immutable.  Edit is intentionally metadata-only; economic correction
  -- is a void/reversal followed by a new transaction.
  if nullif(p_tx->>'type','') is distinct from v_old.type
     or nullif(p_tx->>'cp_id','') is distinct from v_old.cp_id
     or nullif(p_tx->>'cp_name','') is distinct from v_old.cp_name
     or nullif(p_tx->>'cur_id','') is distinct from v_old.cur_id
     or nullif(p_tx->>'amount','')::numeric is distinct from v_old.amount
     or nullif(p_tx->>'rate','')::numeric is distinct from v_old.rate
     or nullif(p_tx->>'against_id','') is distinct from v_old.against_id
     or nullif(p_tx->>'total','')::numeric is distinct from v_old.total
     or nullif(p_tx->>'partner_id','') is distinct from v_old.partner_id
     or nullif(p_tx->>'date','')::timestamptz is distinct from v_old.date then
    raise exception using errcode='42501',
      message='posted economics cannot be edited; void/reverse and create a corrected transaction';
  end if;
  update public.txs set note=left(p_tx->>'note',1000),edited=true,version_no=version_no+1
   where id=v_id returning * into v_new;
  insert into public.tx_versions(tx_id,tx_code,version_no,action,before_data,after_data,
    command_key,actor_auth_id,actor_app_id)
  values(v_new.id,v_new.code,v_new.version_no,'metadata_edited',to_jsonb(v_old),to_jsonb(v_new),
    p_command_key,v_actor.auth_id,v_actor.id);
  perform public.sarraf_write_audit(v_actor.id,p_action,p_detail);
  v_result:=jsonb_build_object('ok',true,'transaction',to_jsonb(v_new));
  return public.sarraf_store_command(v_actor.auth_id,p_command_key,'edit_transaction',v_result);
end;
$$;

create or replace function public.sarraf_void_transaction(
  p_tx_id text,p_command_key text,p_action text,p_detail text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype; v_tx public.txs%rowtype; r public.txs%rowtype;b record;
  v_replay jsonb; v_result jsonb; v_ids text[]; l public.ledger%rowtype; v_rows jsonb:='[]'::jsonb;
  v_location_balance numeric;
begin
  v_actor:=public.sarraf_require_admin(false);perform public.sarraf_assert_writes_open('void_transaction');
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text||':'||p_command_key,0));
  v_replay:=public.sarraf_command_replay(v_actor.auth_id,p_command_key,'void_transaction');
  if v_replay is not null then return v_replay; end if;
  select * into v_tx from public.txs where id=p_tx_id for update;
  if not found then raise exception using errcode='P0002',message='transaction not found'; end if;
  if v_tx.deleted then return jsonb_build_object('ok',true,'replayed',true,'transactions',jsonb_build_array(to_jsonb(v_tx))); end if;
  if public.sarraf_requires_approval('void_transaction',null,false) then
    return public.sarraf_queue_approval('void_transaction',p_tx_id,
      jsonb_build_object('p_tx_id',p_tx_id,'p_command_key',p_command_key,'p_action',p_action,'p_detail',p_detail),
      null,p_detail,p_command_key);
  end if;
  v_ids:=case when v_tx.business_flow='owner_cashbox' then
    array(select id from public.txs where pair_id=v_tx.pair_id and not deleted order by type)
    else array[v_tx.id] end;
  if v_tx.business_flow='owner_cashbox' and coalesce(array_length(v_ids,1),0)<>2 then
    raise exception using errcode='23514',message='direct pair is incomplete and cannot be voided safely'; end if;

  for b in select distinct cur_id,partner_id from public.ledger where tx_id=any(v_ids)
    order by cur_id,partner_id nulls first
  loop
    perform public.sarraf_locked_cash_balance(b.cur_id,b.partner_id);
  end loop;

  foreach p_tx_id in array v_ids loop
    select * into r from public.txs where id=p_tx_id for update;
    -- The original recognition remains in its closed period. The reversal is a new event in
    -- the current open period, so correcting an old transaction never rewrites old books.
    perform public.sarraf_assert_period_open(statement_timestamp());
    if exists(select 1 from public.journal_entries where source_type='transaction' and source_id=r.id and status='posted') then
      perform public.sarraf_reverse_transaction_entry(r.id,
        left(coalesce(nullif(p_detail,''),'transaction void reversal'),700),p_command_key||':'||r.id);
    end if;
    for l in select * from public.ledger where tx_id=r.id and reversal_of is null order by date,id loop
      v_location_balance:=public.sarraf_locked_cash_balance(l.cur_id,l.partner_id);
      if -l.amount<0 and v_location_balance-l.amount< -0.0000000001 then
        raise exception using errcode='23514',
          message='cash location has insufficient balance for transaction reversal';end if;
      insert into public.ledger(id,type,owner,investor_id,cur_id,amount,partner_id,tx_id,note,date,
        reversal_of,command_key,created_by,approval_id,commission_rate_snapshot,commission_amount_snapshot)
      values('led-rev-'||md5(l.id||':'||p_command_key),'reversal',l.owner,l.investor_id,l.cur_id,-l.amount,
        l.partner_id,l.tx_id,left('reversal: '||coalesce(p_detail,''),1000),statement_timestamp(),l.id,
        p_command_key,v_actor.id,null,l.commission_rate_snapshot,l.commission_amount_snapshot);
    end loop;
    update public.txs set deleted=true,edited=true,version_no=version_no+1 where id=r.id;
    insert into public.tx_versions(tx_id,tx_code,version_no,action,before_data,after_data,
      command_key,actor_auth_id,actor_app_id)
    select t.id,t.code,t.version_no,'voided',to_jsonb(r),to_jsonb(t),p_command_key,v_actor.auth_id,v_actor.id
      from public.txs t where t.id=r.id;
    v_rows:=v_rows||(select to_jsonb(t) from public.txs t where t.id=r.id);
  end loop;
  perform public.sarraf_write_audit(v_actor.id,p_action,p_detail);
  v_result:=jsonb_build_object('ok',true,'transactions',v_rows);
  return public.sarraf_store_command(v_actor.auth_id,p_command_key,'void_transaction',v_result);
end;
$$;

create or replace function public.sarraf_save_rates(
  p_rows jsonb,p_history jsonb,p_command_key text,p_action text,p_detail text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_replay jsonb;v_result jsonb;x jsonb;v_id text;v_buy numeric;v_sell numeric;
begin
  v_actor:=public.sarraf_require_admin(false);perform public.sarraf_assert_writes_open('save_rates');
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text||':'||p_command_key,0));
  v_replay:=public.sarraf_command_replay(v_actor.auth_id,p_command_key,'save_rates');if v_replay is not null then return v_replay;end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>100 then raise exception using errcode='22023',message='invalid rates payload';end if;
  for x in select value from jsonb_array_elements(p_rows) loop
    v_id:=nullif(btrim(x->>'id'),'');v_buy:=nullif(x->>'buy_rate','')::numeric;v_sell:=nullif(x->>'sell_rate','')::numeric;
    if not exists(select 1 from public.currencies where id=v_id) or (v_buy is not null and v_buy<=0) or (v_sell is not null and v_sell<=0) then
      raise exception using errcode='22023',message='invalid currency rate';end if;
    update public.currencies set buy_rate=v_buy,sell_rate=v_sell,rate_updated=statement_timestamp() where id=v_id;
    insert into public.rate_history(id,cur_id,buy_rate,sell_rate,changed_by,command_key)
    values('rate-'||md5(v_id||':'||p_command_key),v_id,v_buy,v_sell,v_actor.id,p_command_key);
  end loop;
  perform public.sarraf_write_audit(v_actor.id,p_action,p_detail);
  v_result:=jsonb_build_object('ok',true,'updated',jsonb_array_length(p_rows));
  return public.sarraf_store_command(v_actor.auth_id,p_command_key,'save_rates',v_result);
end;
$$;

create or replace function public.sarraf_add_currency(p_row jsonb,p_command_key text)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_replay jsonb;v_result jsonb;v_id text;v_code text;v_name text;v_dec integer;
begin
  v_actor:=public.sarraf_require_admin(true);perform public.sarraf_assert_writes_open('add_currency');
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text||':'||p_command_key,0));
  v_replay:=public.sarraf_command_replay(v_actor.auth_id,p_command_key,'add_currency');if v_replay is not null then return v_replay;end if;
  v_id:=lower(btrim(p_row->>'id'));v_code:=upper(btrim(p_row->>'code'));v_name:=btrim(p_row->>'name');v_dec:=coalesce((p_row->>'dec')::integer,2);
  if v_id!~'^[a-z0-9_-]{2,16}$' or v_code!~'^[A-Z0-9]{2,8}$' or char_length(v_name) not between 2 and 100 or v_dec not between 0 and 6 then
    raise exception using errcode='22023',message='invalid currency definition';end if;
  insert into public.currencies(id,code,name,symbol,dec,external)
  values(v_id,v_code,v_name,left(p_row->>'symbol',16),v_dec,coalesce((p_row->>'external')::boolean,false));
  perform public.sarraf_write_audit(v_actor.id,'دراوی نوێ',v_code||' — '||v_name);
  v_result:=jsonb_build_object('ok',true,'currency',(select to_jsonb(c) from public.currencies c where id=v_id));
  return public.sarraf_store_command(v_actor.auth_id,p_command_key,'add_currency',v_result);
end;
$$;

create or replace function public.sarraf_account_move(
  p_account_row jsonb,p_ledger jsonb,p_command_key text,p_action text,p_detail text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_user public.app_users%rowtype;v_replay jsonb;v_result jsonb;
  v_id text;v_cur text;v_amount numeric;v_balance numeric;v_date timestamptz:=statement_timestamp();v_usd numeric;
begin
  v_actor:=public.sarraf_require_admin(false);perform public.sarraf_assert_writes_open('account_move');
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text||':'||p_command_key,0));
  v_replay:=public.sarraf_command_replay(v_actor.auth_id,p_command_key,'account_move');if v_replay is not null then return v_replay;end if;
  v_id:=nullif(btrim(p_account_row->>'id'),'');v_cur:=nullif(btrim(p_account_row->>'cur_id'),'');v_amount:=nullif(p_account_row->>'amount','')::numeric;
  select * into v_user from public.app_users where id=p_account_row->>'user_id' and not deleted for share;
  if not found or v_id is null or v_amount is null or v_amount=0 or not exists(select 1 from public.currencies where id=v_cur) then
    raise exception using errcode='22023',message='invalid account movement';end if;
  perform pg_advisory_xact_lock(hashtextextended('zeman:account:'||v_user.id||':'||v_cur,0));
  select coalesce(sum(amount),0) into v_balance from public.account_ledger where user_id=v_user.id and cur_id=v_cur and kind='cash';
  if v_amount<0 and v_balance+v_amount<0 then raise exception using errcode='23514',message='account balance cannot become negative';end if;
  if v_amount<0 and public.sarraf_locked_cash_balance(v_cur,null)+v_amount<0 then
    raise exception using errcode='23514',message='main cashbox has insufficient balance';end if;
  perform public.sarraf_assert_period_open(v_date);
  v_usd:=abs(public.sarraf_usd_value_at(v_amount,v_cur,'mid',v_date));
  if public.sarraf_requires_approval('account_move',v_usd,false) then
    return public.sarraf_queue_approval('account_move',v_user.id,
      jsonb_build_object('p_account_row',p_account_row,'p_ledger','[]'::jsonb,'p_command_key',p_command_key,'p_action',p_action,'p_detail',p_detail),
      v_usd,p_detail,p_command_key);end if;
  insert into public.account_ledger(id,user_id,kind,cur_id,amount,type,ref_id,note,command_key,created_by)
  values(v_id,v_user.id,'cash',v_cur,v_amount,case when v_amount>0 then 'deposit' else 'withdraw' end,
    nullif(p_account_row->>'ref_id',''),left(p_account_row->>'note',1000),p_command_key,v_actor.id);
  -- For investors the capital row is also the physical movement; adding a second acc_in/out
  -- row would double the safe. Other account deposits use one physical acc_in/out row.
  insert into public.ledger(id,type,owner,investor_id,cur_id,amount,note,date,command_key,created_by)
  values('led-'||md5(v_id||':physical'),
    case when v_user.role='investor' then case when v_amount>0 then 'deposit' else 'withdraw' end
         else case when v_amount>0 then 'acc_in' else 'acc_out' end end,
    case when v_user.role='investor' then 'investor' end,
    case when v_user.role='investor' then v_user.id end,v_cur,v_amount,left(p_detail,1000),v_date,p_command_key,v_actor.id);
  perform public.sarraf_write_audit(v_actor.id,p_action,p_detail);
  v_result:=jsonb_build_object('ok',true,'account_entry_id',v_id,'balance',v_balance+v_amount);
  return public.sarraf_store_command(v_actor.auth_id,p_command_key,'account_move',v_result);
end;
$$;

create or replace function public.sarraf_account_transfer(
  p_account_rows jsonb,p_transfer jsonb,p_ledger jsonb,p_command_key text,p_action text,p_detail text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_from public.app_users%rowtype;v_to public.app_users%rowtype;
  v_replay jsonb;v_result jsonb;v_id text;v_cur text;v_amount numeric;v_balance numeric;v_usd numeric;
begin
  v_actor:=public.sarraf_require_admin(false);perform public.sarraf_assert_writes_open('account_transfer');
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text||':'||p_command_key,0));
  v_replay:=public.sarraf_command_replay(v_actor.auth_id,p_command_key,'account_transfer');if v_replay is not null then return v_replay;end if;
  v_id:=nullif(btrim(p_transfer->>'id'),'');v_cur:=nullif(btrim(p_transfer->>'cur_id'),'');v_amount:=nullif(p_transfer->>'amount','')::numeric;
  select * into v_from from public.app_users where id=p_transfer->>'from_id' and not deleted for share;
  if not found then raise exception using errcode='22023',message='source account is invalid';end if;
  select * into v_to from public.app_users where id=p_transfer->>'to_id' and not deleted for share;
  if not found or v_from.id=v_to.id or v_id is null or not (v_amount>0) or not exists(select 1 from public.currencies where id=v_cur) then
    raise exception using errcode='22023',message='invalid account transfer';end if;
  -- Both account locks are taken in lexical order so opposite transfers cannot deadlock.
  perform pg_advisory_xact_lock(hashtextextended('zeman:account:'||least(v_from.id,v_to.id)||':'||v_cur,0));
  perform pg_advisory_xact_lock(hashtextextended('zeman:account:'||greatest(v_from.id,v_to.id)||':'||v_cur,0));
  select coalesce(sum(amount),0) into v_balance from public.account_ledger where user_id=v_from.id and cur_id=v_cur and kind='cash';
  if v_balance<v_amount then raise exception using errcode='23514',message='source account has insufficient balance';end if;
  perform public.sarraf_assert_period_open(statement_timestamp());
  v_usd:=abs(public.sarraf_usd_value_at(v_amount,v_cur,'mid',statement_timestamp()));
  if public.sarraf_requires_approval('account_transfer',v_usd,false) then
    return public.sarraf_queue_approval('account_transfer',v_id,
      jsonb_build_object('p_account_rows','[]'::jsonb,'p_transfer',p_transfer,'p_ledger','[]'::jsonb,
        'p_command_key',p_command_key,'p_action',p_action,'p_detail',p_detail),v_usd,p_detail,p_command_key);end if;
  insert into public.account_ledger(id,user_id,kind,cur_id,amount,type,ref_id,note,command_key,created_by)
  values('al-'||md5(v_id||':out'),v_from.id,'cash',v_cur,-v_amount,'transfer_out',v_id,
         left('to '||v_to.name||coalesce(' — '||nullif(p_transfer->>'note',''),''),1000),p_command_key,v_actor.id),
        ('al-'||md5(v_id||':in'),v_to.id,'cash',v_cur,v_amount,'transfer_in',v_id,
         left('from '||v_from.name||coalesce(' — '||nullif(p_transfer->>'note',''),''),1000),p_command_key,v_actor.id);
  insert into public.account_transfers(id,from_id,from_name,to_id,to_name,cur_id,amount,note,command_key,created_by)
  values(v_id,v_from.id,v_from.name,v_to.id,v_to.name,v_cur,v_amount,left(p_transfer->>'note',1000),p_command_key,v_actor.id);
  -- Reclassify ownership without changing physical cash.
  if v_from.role='investor' then
    insert into public.ledger(id,type,owner,investor_id,cur_id,amount,note,date,command_key,created_by)
    values('led-'||md5(v_id||':investor-out'),'withdraw','investor',v_from.id,v_cur,-v_amount,
      left(p_detail,1000),statement_timestamp(),p_command_key,v_actor.id);
  end if;
  if v_to.role='investor' then
    insert into public.ledger(id,type,owner,investor_id,cur_id,amount,note,date,command_key,created_by)
    values('led-'||md5(v_id||':investor-in'),'deposit','investor',v_to.id,v_cur,v_amount,
      left(p_detail,1000),statement_timestamp(),p_command_key,v_actor.id);
  end if;
  if (v_from.role='investor')<>(v_to.role='investor') then
    insert into public.ledger(id,type,owner,cur_id,amount,note,date,command_key,created_by)
    values('led-'||md5(v_id||':capital-reclass'),'capital_reclass',null,v_cur,
      case when v_from.role='investor' then v_amount else -v_amount end,
      left(p_detail,1000),statement_timestamp(),p_command_key,v_actor.id);
  end if;
  perform public.sarraf_write_audit(v_actor.id,p_action,p_detail);
  v_result:=jsonb_build_object('ok',true,'transfer_id',v_id,'source_balance',v_balance-v_amount);
  return public.sarraf_store_command(v_actor.auth_id,p_command_key,'account_transfer',v_result);
end;
$$;

create or replace function public.sarraf_close_day(
  p_close jsonb,p_ledger jsonb,p_command_key text,p_action text,p_detail text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_replay jsonb;v_result jsonb;v_id text;v_date date;
  v_lines jsonb;v_normalized jsonb:='[]'::jsonb;v_has_diff boolean;v_note text;x jsonb;
  v_diff numeric;v_cur text;v_code text;v_counted numeric;v_expected numeric;v_total_diff numeric:=0;
  v_exposure numeric:=0;v_diff_usd numeric;v_dec integer;v_timezone text;v_business_today date;
  v_cutoff timestamptz;v_seen text[]:=array[]::text[];v_adjust boolean;
begin
  v_actor:=public.sarraf_require_admin(false);perform public.sarraf_assert_writes_open('close_day');
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text||':'||p_command_key,0));
  v_replay:=public.sarraf_command_replay(v_actor.auth_id,p_command_key,'close_day');if v_replay is not null then return v_replay;end if;
  v_id:=nullif(btrim(p_close->>'id'),'');v_date:=nullif(p_close->>'close_date','')::date;
  v_lines:=coalesce(p_close->'lines','[]'::jsonb);v_note:=nullif(btrim(p_close->>'note'),'');
  v_adjust:=coalesce((p_close->>'adjust')::boolean,false);
  select coalesce(business_timezone,'Asia/Baghdad') into v_timezone
    from public.control_settings where singleton;
  v_timezone:=coalesce(v_timezone,'Asia/Baghdad');
  v_business_today:=(statement_timestamp() at time zone v_timezone)::date;
  if v_id is null or v_date is null or v_date>v_business_today or jsonb_typeof(v_lines)<>'array'
     or jsonb_array_length(v_lines) not between 1 and 100 then
    raise exception using errcode='22023',message='invalid day close';end if;
  perform pg_advisory_xact_lock(hashtextextended('zeman:accounting-period',0));
  perform pg_advisory_xact_lock(hashtextextended('zeman:day-close:'||v_date::text,0));
  if exists(select 1 from public.day_closes where close_date=v_date) then raise exception using errcode='23505',message='this business day is already closed';end if;
  -- Older writers do not participate in the advisory protocol. The table lock closes that
  -- compatibility race while the server derives the expected drawer balance.
  lock table public.ledger in share mode;
  v_cutoff:=((v_date+1)::timestamp at time zone v_timezone);
  for x in select value from jsonb_array_elements(v_lines) loop
    v_cur:=coalesce(nullif(btrim(x->>'cur'),''),nullif(btrim(x->>'cur_id'),''));
    if v_cur is null or v_cur=any(v_seen) then
      raise exception using errcode='22023',message='day-close currencies must be valid and unique';end if;
    select code,least(greatest(dec,0),10) into v_code,v_dec from public.currencies where id=v_cur;
    if not found then raise exception using errcode='22023',message='day-close currency is invalid';end if;
    v_counted:=nullif(x->>'counted','')::numeric;
    if v_counted is null or abs(v_counted)>1000000000000000 then
      raise exception using errcode='22023',message='day-close counted amount is invalid';end if;
    select round(coalesce(sum(amount),0),v_dec) into v_expected from public.ledger
     where cur_id=v_cur and partner_id is null and date<v_cutoff;
    if public.sarraf_approval_context()
       and nullif(x->>'expected','')::numeric is distinct from v_expected then
      raise exception using errcode='40001',
        message='day-close balance changed after approval request; submit a fresh count';end if;
    v_counted:=round(v_counted,v_dec);v_diff:=round(v_counted-v_expected,v_dec);
    v_seen:=array_append(v_seen,v_cur);
    v_normalized:=v_normalized||jsonb_build_array(jsonb_build_object('cur',v_cur,'code',v_code,
      'expected',v_expected,'counted',v_counted,'diff',v_diff));
    if abs(v_diff)>0.000000001 then
      v_diff_usd:=public.sarraf_usd_value_at(v_diff,v_cur,'mid',v_cutoff-interval '1 microsecond');
      if v_diff_usd is null then raise exception using errcode='22023',message='a historical USD rate is required for the day-close difference';end if;
      v_total_diff:=v_total_diff+v_diff_usd;v_exposure:=v_exposure+abs(v_diff_usd);
    end if;
  end loop;
  v_has_diff:=v_exposure>0.000000001;
  if v_has_diff and char_length(coalesce(v_note,''))<8 then raise exception using errcode='22023',message='an explained difference requires an 8-character note';end if;
  if public.sarraf_requires_approval('close_day',null,v_has_diff) then
    return public.sarraf_queue_approval('close_day',v_date::text,
      jsonb_build_object('p_close',p_close||jsonb_build_object('lines',v_normalized,
        'total_diff',round(v_total_diff,10),'has_diff',v_has_diff),
        'p_ledger','[]'::jsonb,'p_command_key',p_command_key,'p_action',p_action,'p_detail',p_detail),
      v_exposure,p_detail,p_command_key);end if;
  perform set_config('sarraf.day_close_adjustment',v_id,true);
  insert into public.day_closes(id,close_date,lines,total_diff,has_diff,note,adjust,closed_by,command_key)
  values(v_id,v_date,v_normalized,round(v_total_diff,10),v_has_diff,v_note,v_adjust,v_actor.id,p_command_key);
  if v_adjust then
    for x in select value from jsonb_array_elements(v_normalized) loop
      v_cur:=coalesce(nullif(x->>'cur',''),nullif(x->>'cur_id',''));v_diff:=coalesce(nullif(x->>'diff','')::numeric,0);
      if v_diff<>0 then
        insert into public.ledger(id,type,cur_id,amount,note,date,command_key,created_by)
        values('led-'||md5(v_id||':'||v_cur),'adjustment',v_cur,v_diff,left('day close: '||coalesce(v_note,''),1000),
          v_cutoff-interval '1 microsecond',p_command_key,v_actor.id);
      end if;
    end loop;
  end if;
  perform public.sarraf_write_audit(v_actor.id,p_action,p_detail);
  v_result:=jsonb_build_object('ok',true,'close_id',v_id,'close_date',v_date,'has_diff',v_has_diff,
    'total_diff_usd',round(v_total_diff,10),'approval_exposure_usd',round(v_exposure,10),'lines',v_normalized);
  return public.sarraf_store_command(v_actor.auth_id,p_command_key,'close_day',v_result);
end;
$$;

create or replace function public.sarraf_execute_approval(p_approval_id text)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare a public.approval_requests%rowtype;v_result jsonb;
begin
  select * into a from public.approval_requests where id=p_approval_id for update;
  if not found then raise exception using errcode='P0002',message='approval request not found';end if;
  perform set_config('sarraf.approval_id',a.id,true);
  case a.operation
    when 'commit_transactions' then v_result:=public.sarraf_commit_transactions(a.payload->'p_txs','[]'::jsonb,a.payload->>'p_batch_id',a.payload->>'p_command_key',a.payload->>'p_action',a.payload->>'p_detail');
    when 'edit_transaction' then v_result:=public.sarraf_edit_transaction(a.payload->'p_tx','[]'::jsonb,a.payload->>'p_command_key',a.payload->>'p_action',a.payload->>'p_detail');
    when 'void_transaction' then v_result:=public.sarraf_void_transaction(a.payload->>'p_tx_id',a.payload->>'p_command_key',a.payload->>'p_action',a.payload->>'p_detail');
    when 'post_ledger' then v_result:=public.sarraf_post_ledger_command(a.payload->'p_ledger',a.payload->>'p_command_key',a.payload->>'p_action',a.payload->>'p_detail');
    when 'account_move' then v_result:=public.sarraf_account_move(a.payload->'p_account_row','[]'::jsonb,a.payload->>'p_command_key',a.payload->>'p_action',a.payload->>'p_detail');
    when 'account_transfer' then v_result:=public.sarraf_account_transfer('[]'::jsonb,a.payload->'p_transfer','[]'::jsonb,a.payload->>'p_command_key',a.payload->>'p_action',a.payload->>'p_detail');
    when 'close_day' then v_result:=public.sarraf_close_day(a.payload->'p_close','[]'::jsonb,a.payload->>'p_command_key',a.payload->>'p_action',a.payload->>'p_detail');
    else raise exception using errcode='22023',message='approval operation is not executable';
  end case;
  -- The command belongs to the maker's idempotency namespace even though the checker is the
  -- authenticated executor. This lets the maker safely retry after a lost approval response.
  update public.financial_commands set actor_id=a.maker_auth_id
   where command_key=a.payload->>'p_command_key' and operation=a.operation;
  return v_result;
end;
$$;

create or replace function public.sarraf_approve_request(p_approval_id text,p_command_key text,p_note text)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;a public.approval_requests%rowtype;v_result jsonb;
begin
  v_actor:=public.sarraf_require_admin(false);perform public.sarraf_assert_writes_open('approve_request');
  select * into a from public.approval_requests where id=p_approval_id for update;
  if not found then raise exception using errcode='P0002',message='approval request not found';end if;
  if a.status='executed' then return coalesce(a.result,'{}'::jsonb)||jsonb_build_object('replayed',true);end if;
  if a.status<>'pending' then raise exception using errcode='22023',message='approval is no longer pending';end if;
  if a.expires_at<=statement_timestamp() then
    update public.approval_requests set status='expired',decided_at=statement_timestamp() where id=a.id;
    insert into public.approval_events(approval_id,event,actor_auth_id,actor_app_id,actor_name,detail)
    values(a.id,'expired',v_actor.auth_id,v_actor.id,v_actor.name,'approval expired before checker execution');
    return jsonb_build_object('ok',false,'approval_id',a.id,'status','expired','error','approval request expired');
  end if;
  if a.maker_auth_id=v_actor.auth_id then raise exception using errcode='42501',message='maker cannot approve their own request';end if;
  begin
    v_result:=public.sarraf_execute_approval(a.id);
    update public.approval_requests set status='executed',checker_auth_id=v_actor.auth_id,checker_app_id=v_actor.id,
      checker_name=v_actor.name,decision_note=left(p_note,700),result=v_result,decided_at=statement_timestamp(),executed_at=statement_timestamp() where id=a.id;
    insert into public.approval_events(approval_id,event,actor_auth_id,actor_app_id,actor_name,detail)
    values(a.id,'executed',v_actor.auth_id,v_actor.id,v_actor.name,left(p_note,700));
    return jsonb_build_object('ok',true,'approval_id',a.id,'result',v_result);
  exception when others then
    update public.approval_requests set status='failed',checker_auth_id=v_actor.auth_id,checker_app_id=v_actor.id,
      checker_name=v_actor.name,error_text=sqlerrm,decided_at=statement_timestamp() where id=a.id;
    insert into public.approval_events(approval_id,event,actor_auth_id,actor_app_id,actor_name,detail)
    values(a.id,'failed',v_actor.auth_id,v_actor.id,v_actor.name,left(sqlerrm,700));
    return jsonb_build_object('ok',false,'approval_id',a.id,'error',sqlerrm);
  end;
end;
$$;

create or replace function public.sarraf_reject_request(p_approval_id text,p_command_key text,p_note text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;a public.approval_requests%rowtype;
begin
  v_actor:=public.sarraf_require_admin(false);select * into a from public.approval_requests where id=p_approval_id for update;
  if not found then raise exception using errcode='P0002',message='approval request not found';end if;
  if a.status='rejected' then return jsonb_build_object('ok',true,'approval_id',a.id,'replayed',true);end if;
  if a.status<>'pending' or a.maker_auth_id=v_actor.auth_id or char_length(btrim(coalesce(p_note,'')))<3 then
    raise exception using errcode='42501',message='a separate checker and rejection reason are required';end if;
  update public.approval_requests set status='rejected',checker_auth_id=v_actor.auth_id,checker_app_id=v_actor.id,
    checker_name=v_actor.name,decision_note=left(p_note,700),decided_at=statement_timestamp() where id=a.id;
  insert into public.approval_events(approval_id,event,actor_auth_id,actor_app_id,actor_name,detail)
  values(a.id,'rejected',v_actor.auth_id,v_actor.id,v_actor.name,left(p_note,700));
  return jsonb_build_object('ok',true,'approval_id',a.id,'status','rejected');
end;
$$;

create or replace function public.sarraf_cancel_approval_request(p_approval_id text,p_command_key text,p_note text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;a public.approval_requests%rowtype;
begin
  v_actor:=public.sarraf_require_admin(false);select * into a from public.approval_requests where id=p_approval_id for update;
  if not found then raise exception using errcode='P0002',message='approval request not found';end if;
  if a.status='cancelled' then return jsonb_build_object('ok',true,'approval_id',a.id,'replayed',true);end if;
  if a.status<>'pending' or (a.maker_auth_id<>v_actor.auth_id and coalesce(v_actor.admin_level,'')<>'owner') then
    raise exception using errcode='42501',message='only the maker or owner may cancel a pending request';end if;
  update public.approval_requests set status='cancelled',decision_note=left(p_note,700),decided_at=statement_timestamp() where id=a.id;
  insert into public.approval_events(approval_id,event,actor_auth_id,actor_app_id,actor_name,detail)
  values(a.id,'cancelled',v_actor.auth_id,v_actor.id,v_actor.name,left(p_note,700));
  return jsonb_build_object('ok',true,'approval_id',a.id,'status','cancelled');
end;
$$;

create or replace function public.sarraf_owner_override_approval(p_approval_id text,p_command_key text,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;a public.approval_requests%rowtype;v_enabled boolean;v_result jsonb;
begin
  v_actor:=public.sarraf_require_admin(true);select owner_override_enabled into v_enabled from public.control_settings where singleton;
  if not coalesce(v_enabled,false) or char_length(btrim(coalesce(p_reason,'')))<12 then raise exception using errcode='42501',message='owner override is disabled or its reason is too short';end if;
  select * into a from public.approval_requests where id=p_approval_id for update;
  if not found or a.status<>'pending' then raise exception using errcode='22023',message='approval is not pending';end if;
  begin
    v_result:=public.sarraf_execute_approval(a.id);
    update public.approval_requests set status='executed',checker_auth_id=v_actor.auth_id,checker_app_id=v_actor.id,
      checker_name=v_actor.name,decision_note=left(p_reason,700),owner_override=true,result=v_result,
      decided_at=statement_timestamp(),executed_at=statement_timestamp() where id=a.id;
    insert into public.approval_events(approval_id,event,actor_auth_id,actor_app_id,actor_name,detail)
    values(a.id,'owner_override',v_actor.auth_id,v_actor.id,v_actor.name,left(p_reason,700));
    return jsonb_build_object('ok',true,'approval_id',a.id,'result',v_result,'owner_override',true);
  exception when others then
    update public.approval_requests set status='failed',checker_auth_id=v_actor.auth_id,
      checker_app_id=v_actor.id,checker_name=v_actor.name,decision_note=left(p_reason,700),
      owner_override=true,error_text=sqlerrm,decided_at=statement_timestamp() where id=a.id;
    insert into public.approval_events(approval_id,event,actor_auth_id,actor_app_id,actor_name,detail)
    values(a.id,'override_failed',v_actor.auth_id,v_actor.id,v_actor.name,left(sqlerrm,700));
    return jsonb_build_object('ok',false,'approval_id',a.id,'status','failed','error',sqlerrm);
  end;
end;
$$;

create or replace function public.sarraf_record_audit_event(p_action text,p_detail text,p_command_key text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_replay jsonb;v_result jsonb;
begin
  v_actor:=public.sarraf_require_admin(false);
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text||':'||p_command_key,0));
  v_replay:=public.sarraf_command_replay(v_actor.auth_id,p_command_key,'record_audit_event');
  if v_replay is not null then return v_replay;end if;
  if char_length(btrim(coalesce(p_action,''))) not between 2 and 200
     or char_length(coalesce(p_detail,''))>2000 then
    raise exception using errcode='22023',message='invalid audit event';end if;
  perform public.sarraf_write_audit(v_actor.id,btrim(p_action),p_detail);
  v_result:=jsonb_build_object('ok',true,'recorded',true);
  return public.sarraf_store_command(v_actor.auth_id,p_command_key,'record_audit_event',v_result);
end;
$$;

create or replace function public.sarraf_update_control_settings(p_settings jsonb,p_command_key text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_replay jsonb;v_result jsonb;v_t numeric;v_c numeric;v_x numeric;v_hours integer;v_tz text;
begin
  v_actor:=public.sarraf_require_admin(true);perform public.sarraf_assert_writes_open('update_control_settings');
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text||':'||p_command_key,0));
  v_replay:=public.sarraf_command_replay(v_actor.auth_id,p_command_key,'update_control_settings');if v_replay is not null then return v_replay;end if;
  v_t:=nullif(p_settings->>'transaction_approval_usd','')::numeric;v_c:=nullif(p_settings->>'cash_approval_usd','')::numeric;v_x:=nullif(p_settings->>'transfer_approval_usd','')::numeric;
  v_hours:=coalesce(nullif(p_settings->>'approval_expiry_hours','')::integer,24);v_tz:=coalesce(nullif(btrim(p_settings->>'business_timezone'),''),'Asia/Baghdad');
  if (v_t is not null and v_t<=0) or (v_c is not null and v_c<=0) or (v_x is not null and v_x<=0) or v_hours not between 1 and 168
     or not exists(select 1 from pg_timezone_names where name=v_tz) then raise exception using errcode='22023',message='invalid control settings';end if;
  update public.control_settings set transaction_approval_usd=v_t,cash_approval_usd=v_c,transfer_approval_usd=v_x,
    require_edit_approval=coalesce((p_settings->>'require_edit_approval')::boolean,require_edit_approval),
    require_void_approval=coalesce((p_settings->>'require_void_approval')::boolean,require_void_approval),
    require_unsettle_approval=coalesce((p_settings->>'require_unsettle_approval')::boolean,require_unsettle_approval),
    require_day_close_diff_approval=coalesce((p_settings->>'require_day_close_diff_approval')::boolean,require_day_close_diff_approval),
    owner_override_enabled=coalesce((p_settings->>'owner_override_enabled')::boolean,owner_override_enabled),
    approval_expiry_hours=v_hours,business_timezone=v_tz,version=version+1,updated_by=v_actor.id,updated_at=statement_timestamp()
  where singleton;
  perform public.sarraf_write_audit(v_actor.id,'گۆڕینی کۆنترۆڵی دارایی','Financial control settings updated');
  v_result:=jsonb_build_object('ok',true,'settings',(select to_jsonb(c)-'singleton' from public.control_settings c where singleton));
  return public.sarraf_store_command(v_actor.auth_id,p_command_key,'update_control_settings',v_result);
end;
$$;

-- Ledger/account/audit history is append-only. Corrections use reversal rows.
create or replace function public.sarraf_protect_append_only()
returns trigger language plpgsql set search_path=pg_catalog
as $$ begin raise exception using errcode='42501',message=tg_table_name||' is append-only';end $$;

drop trigger if exists ledger_append_only on public.ledger;
create trigger ledger_append_only before update or delete on public.ledger
  for each row execute function public.sarraf_protect_append_only();
drop trigger if exists account_ledger_append_only on public.account_ledger;
create trigger account_ledger_append_only before update or delete on public.account_ledger
  for each row execute function public.sarraf_protect_append_only();
drop trigger if exists account_transfers_append_only on public.account_transfers;
create trigger account_transfers_append_only before update or delete on public.account_transfers
  for each row execute function public.sarraf_protect_append_only();
drop trigger if exists audit_append_only on public.audit;
create trigger audit_append_only before update or delete on public.audit
  for each row execute function public.sarraf_protect_append_only();

-- A closed period is enforced at the storage boundary too, covering legacy SECURITY DEFINER
-- functions that predate the command layer. Metadata-only transaction notes remain editable;
-- every economic insert/change must use an open business date.
create or replace function public.sarraf_enforce_open_period_trigger()
returns trigger language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_when timestamptz;v_timezone text;
begin
  if nullif(current_setting('sarraf.day_close_adjustment',true),'') is not null then return new;end if;
  if tg_table_name='txs' then
    if tg_op='UPDATE' and new.type is not distinct from old.type
       and new.cp_id is not distinct from old.cp_id and new.cp_name is not distinct from old.cp_name
       and new.cur_id is not distinct from old.cur_id and new.amount is not distinct from old.amount
       and new.rate is not distinct from old.rate and new.against_id is not distinct from old.against_id
       and new.total is not distinct from old.total and new.partner_id is not distinct from old.partner_id
       and new.direct is not distinct from old.direct
       and new.pair_id is not distinct from old.pair_id and new.direct_role is not distinct from old.direct_role
       and new.own_money is not distinct from old.own_money
       and new.buy_rate is not distinct from old.buy_rate and new.buy_total is not distinct from old.buy_total
       and new.cost_basis_usd is not distinct from old.cost_basis_usd
       and new.profit is not distinct from old.profit and new.profit_cur_id is not distinct from old.profit_cur_id
       and new.partner_rate_snapshot is not distinct from old.partner_rate_snapshot
       and new.partner_fee_snapshot is not distinct from old.partner_fee_snapshot
       and new.business_flow is not distinct from old.business_flow and new.date is not distinct from old.date then
      return new;end if;
    v_when:=case when tg_op='UPDATE' then old.date else new.date end;
  elsif tg_table_name='ledger' then v_when:=new.date;
  elsif tg_table_name='account_ledger' then v_when:=new.created_at;
  elsif tg_table_name='journal_entries' then
    if tg_op='UPDATE' and old.status='posted' and new.status='reversed' and new.reversed_by is not null then
      return new;end if;
    select coalesce(business_timezone,'Asia/Baghdad') into v_timezone
      from public.control_settings where singleton;
    v_when:=(new.business_date::timestamp at time zone coalesce(v_timezone,'Asia/Baghdad'));
  else return new;end if;
  perform public.sarraf_assert_period_open(v_when);
  return new;
end;
$$;

drop trigger if exists txs_period_guard on public.txs;
create trigger txs_period_guard before insert or update on public.txs
  for each row execute function public.sarraf_enforce_open_period_trigger();
drop trigger if exists ledger_period_guard on public.ledger;
create trigger ledger_period_guard before insert on public.ledger
  for each row execute function public.sarraf_enforce_open_period_trigger();
drop trigger if exists account_ledger_period_guard on public.account_ledger;
create trigger account_ledger_period_guard before insert on public.account_ledger
  for each row execute function public.sarraf_enforce_open_period_trigger();
drop trigger if exists journal_entries_period_guard on public.journal_entries;
create trigger journal_entries_period_guard before insert or update on public.journal_entries
  for each row execute function public.sarraf_enforce_open_period_trigger();

create unique index if not exists day_closes_date_uq on public.day_closes(close_date);
create unique index if not exists ledger_reversal_once_uq on public.ledger(reversal_of) where reversal_of is not null;

-- Only the narrow public command surface is executable by browser sessions.
revoke all on function public.sarraf_actor() from public,anon,authenticated;
revoke all on function public.sarraf_require_admin(boolean) from public,anon,authenticated;
revoke all on function public.sarraf_assert_writes_open(text) from public,anon,authenticated;
revoke all on function public.sarraf_is_period_closed(timestamptz) from public,anon,authenticated;
revoke all on function public.sarraf_assert_period_open(timestamptz) from public,anon,authenticated;
revoke all on function public.sarraf_command_replay(uuid,text,text) from public,anon,authenticated;
revoke all on function public.sarraf_store_command(uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.sarraf_locked_cash_balance(text,text) from public,anon,authenticated;
revoke all on function public.sarraf_post_payment_ledger() from public,anon,authenticated;
revoke all on function public.sarraf_queue_approval(text,text,jsonb,numeric,text,text) from public,anon,authenticated;
revoke all on function public.sarraf_execute_approval(text) from public,anon,authenticated;
revoke all on function public.sarraf_post_ledger_command(jsonb,text,text,text) from public,anon;
revoke all on function public.sarraf_commit_transactions(jsonb,jsonb,text,text,text,text) from public,anon;
revoke all on function public.sarraf_edit_transaction(jsonb,jsonb,text,text,text) from public,anon;
revoke all on function public.sarraf_void_transaction(text,text,text,text) from public,anon;
revoke all on function public.sarraf_save_rates(jsonb,jsonb,text,text,text) from public,anon;
revoke all on function public.sarraf_add_currency(jsonb,text) from public,anon;
revoke all on function public.sarraf_account_move(jsonb,jsonb,text,text,text) from public,anon;
revoke all on function public.sarraf_account_transfer(jsonb,jsonb,jsonb,text,text,text) from public,anon;
revoke all on function public.sarraf_close_day(jsonb,jsonb,text,text,text) from public,anon;
revoke all on function public.sarraf_approve_request(text,text,text) from public,anon;
revoke all on function public.sarraf_reject_request(text,text,text) from public,anon;
revoke all on function public.sarraf_cancel_approval_request(text,text,text) from public,anon;
revoke all on function public.sarraf_owner_override_approval(text,text,text) from public,anon;
revoke all on function public.sarraf_record_audit_event(text,text,text) from public,anon;
revoke all on function public.sarraf_update_control_settings(jsonb,text) from public,anon;
grant execute on function public.sarraf_post_ledger_command(jsonb,text,text,text),
  public.sarraf_commit_transactions(jsonb,jsonb,text,text,text,text),
  public.sarraf_edit_transaction(jsonb,jsonb,text,text,text),
  public.sarraf_void_transaction(text,text,text,text),
  public.sarraf_save_rates(jsonb,jsonb,text,text,text),
  public.sarraf_add_currency(jsonb,text),
  public.sarraf_account_move(jsonb,jsonb,text,text,text),
  public.sarraf_account_transfer(jsonb,jsonb,jsonb,text,text,text),
  public.sarraf_close_day(jsonb,jsonb,text,text,text),
  public.sarraf_approve_request(text,text,text),
  public.sarraf_reject_request(text,text,text),
  public.sarraf_cancel_approval_request(text,text,text),
  public.sarraf_owner_override_approval(text,text,text),
  public.sarraf_record_audit_event(text,text,text),
  public.sarraf_update_control_settings(jsonb,text)
to authenticated;

commit;
