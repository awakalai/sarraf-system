-- ZEMAN bounded server read models, runtime contract and aggregate-data authorization.

begin;

create or replace function public.sarraf_self_profile()
returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;
begin
  v_actor:=public.sarraf_actor();
  return to_jsonb(v_actor);
end;
$$;

create or replace function public.sarraf_control_snapshot()
returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_settings jsonb;v_pending bigint;v_tz text;
begin
  v_actor:=public.sarraf_require_admin(false);
  select to_jsonb(c)-'singleton',c.business_timezone into v_settings,v_tz
    from public.control_settings c where singleton;
  select count(*) into v_pending from public.approval_requests
    where status='pending' and expires_at>statement_timestamp();
  return coalesce(v_settings,'{}'::jsonb)||jsonb_build_object(
    'business_date',(statement_timestamp() at time zone coalesce(v_tz,'Asia/Baghdad'))::date,
    'pending_approvals',v_pending,'actor_admin_level',v_actor.admin_level);
end;
$$;

create or replace function public.sarraf_read_model_snapshot(p_days integer default 30)
returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_days integer;v_inventory jsonb;v_physical jsonb;
  v_partner jsonb;v_investor jsonb;v_paid jsonb;v_self jsonb;v_expenses jsonb;v_fees jsonb;
  v_accounts jsonb;v_pending jsonb;v_profit jsonb;v_counts jsonb;
begin
  v_actor:=public.sarraf_require_admin(false);v_days:=least(greatest(coalesce(p_days,30),1),366);
  select coalesce(jsonb_object_agg(cur_id,amount),'{}'::jsonb) into v_physical from (
    select cur_id,round(sum(amount),10) amount from public.ledger group by cur_id) s;
  select coalesce(jsonb_agg(to_jsonb(s) order by partner_id,cur_id),'[]'::jsonb) into v_partner from (
    select partner_id,cur_id,round(sum(amount),10) amount from public.ledger
     where partner_id is not null group by partner_id,cur_id) s;
  select coalesce(jsonb_agg(to_jsonb(s) order by investor_id,cur_id),'[]'::jsonb) into v_investor from (
    select investor_id,cur_id,round(sum(amount),10) amount from public.ledger
     where investor_id is not null and owner='investor' and type in ('deposit','withdraw')
     group by investor_id,cur_id) s;
  select coalesce(jsonb_agg(to_jsonb(s) order by investor_id,cur_id),'[]'::jsonb) into v_paid from (
    select investor_id,cur_id,round(sum(abs(amount)),10) amount from public.ledger
     where investor_id is not null and type='investor_payout' group by investor_id,cur_id) s;
  select coalesce(jsonb_object_agg(cur_id,amount),'{}'::jsonb) into v_self from (
    select cur_id,round(sum(amount),10) amount from public.ledger
     where investor_id is null and coalesce(owner,'self')<>'investor' and type in ('deposit','withdraw') group by cur_id) s;
  select coalesce(jsonb_object_agg(cur_id,amount),'{}'::jsonb) into v_expenses from (
    select cur_id,round(sum(abs(amount)),10) amount from public.ledger where type='expense' group by cur_id) s;
  select coalesce(jsonb_object_agg(cur_id,amount),'{}'::jsonb) into v_fees from (
    select cur_id,round(sum(abs(amount)),10) amount from public.ledger where type='partner_fee' group by cur_id) s;
  select coalesce(jsonb_agg(to_jsonb(s) order by user_id,kind,cur_id),'[]'::jsonb) into v_accounts from (
    select user_id,kind,cur_id,round(sum(amount),10) amount from public.account_ledger group by user_id,kind,cur_id) s;
  select coalesce(jsonb_agg(to_jsonb(s) order by cp_id nulls last,cp_name,type,against_id),'[]'::jsonb) into v_pending from (
    select cp_id,cp_name,type,against_id,round(sum(total),10) total,count(*) tx_count
      from public.txs where not deleted and status='pending'
     group by cp_id,cp_name,type,against_id) s;
  select coalesce(jsonb_agg(to_jsonb(s) order by cur_id,direct),'[]'::jsonb) into v_profit from (
    select profit_cur_id cur_id,(business_flow='owner_cashbox') direct,round(sum(profit),10) amount
      from public.txs where not deleted and type='sell' and profit is not null
     group by profit_cur_id,(business_flow='owner_cashbox')) s;
  select coalesce(jsonb_agg(public.sarraf_inventory_snapshot_at(c.id,null,null) order by c.code),'[]'::jsonb)
    into v_inventory from public.currencies c;
  select jsonb_build_object('active_txs',(select count(*) from public.txs where not deleted),
    'ledger_rows',(select count(*) from public.ledger),
    'account_ledger_rows',(select count(*) from public.account_ledger),
    'pending_txs',(select count(*) from public.txs where not deleted and status='pending'),
    'open_approvals',(select count(*) from public.approval_requests where status='pending'),
    'period_days',v_days) into v_counts;
  return jsonb_build_object('generated_at',statement_timestamp(),'physical_by_currency',v_physical,
    'partner_balances',v_partner,'investor_capital',v_investor,'investor_paid',v_paid,
    'self_capital',v_self,'expenses',v_expenses,'partner_fees',v_fees,
    'account_balances',v_accounts,'pending_customer_balances',v_pending,
    'profit_totals',v_profit,'inventory',v_inventory,'counts',v_counts);
end;
$$;

create or replace function public.sarraf_inventory_snapshot(
  p_cur_id text,p_as_of timestamptz default null,p_exclude_tx_id text default null
) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;
begin
  v_actor:=public.sarraf_require_admin(false);
  if not exists(select 1 from public.currencies where id=p_cur_id) then
    raise exception using errcode='22023',message='unknown inventory currency';
  end if;
  return public.sarraf_inventory_snapshot_at(p_cur_id,p_as_of,p_exclude_tx_id);
end;
$$;

create or replace function public.sarraf_tx_history_page(
  p_limit integer default 80,p_before_date timestamptz default null,p_before_id text default null,
  p_type text default null,p_status text default null,p_cur_id text default null,
  p_from date default null,p_to date default null,p_search text default null
) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_limit integer;v_items jsonb;v_count bigint;v_totals jsonb;
  v_last_date timestamptz;v_last_id text;v_size integer;v_has_more boolean:=false;
begin
  v_actor:=public.sarraf_require_admin(false);v_limit:=least(greatest(coalesce(p_limit,80),1),200);
  if p_type is not null and p_type not in ('buy','sell') then raise exception using errcode='22023',message='invalid transaction type filter';end if;
  if p_status is not null and p_status not in ('completed','pending') then raise exception using errcode='22023',message='invalid transaction status filter';end if;
  if p_from is not null and p_to is not null and p_from>p_to then raise exception using errcode='22023',message='invalid history range';end if;

  with filtered as (
    select t.* from public.txs t where
      (p_type is null or t.type=p_type) and (p_status is null or t.status=p_status)
      and (p_cur_id is null or t.cur_id=p_cur_id)
      and (p_from is null or t.date>=p_from::timestamptz)
      and (p_to is null or t.date<(p_to+1)::timestamptz)
      and (p_search is null or btrim(p_search)='' or t.code::text ilike '%'||btrim(p_search)||'%'
        or coalesce(t.cp_name,'') ilike '%'||btrim(p_search)||'%'
        or coalesce(t.note,'') ilike '%'||btrim(p_search)||'%')
  ), page as (
    select * from filtered where p_before_date is null
      or (date,id)<(p_before_date,coalesce(p_before_id,'\uffff'))
    order by date desc,id desc limit v_limit+1
  ), numbered as (
    select page.*,row_number() over(order by date desc,id desc) rn from page
  )
  select coalesce(jsonb_agg(to_jsonb(numbered)-'rn' order by date desc,id desc)
           filter(where rn<=v_limit),'[]'::jsonb),
         count(*) filter(where rn<=v_limit),count(*)>v_limit
    into v_items,v_size,v_has_more from numbered;

  with filtered as (
    select t.* from public.txs t where
      (p_type is null or t.type=p_type) and (p_status is null or t.status=p_status)
      and (p_cur_id is null or t.cur_id=p_cur_id)
      and (p_from is null or t.date>=p_from::timestamptz)
      and (p_to is null or t.date<(p_to+1)::timestamptz)
      and (p_search is null or btrim(p_search)='' or t.code::text ilike '%'||btrim(p_search)||'%'
        or coalesce(t.cp_name,'') ilike '%'||btrim(p_search)||'%'
        or coalesce(t.note,'') ilike '%'||btrim(p_search)||'%')
  )
  select (select count(*) from filtered),coalesce(jsonb_agg(to_jsonb(s) order by against_id),'[]'::jsonb)
    into v_count,v_totals from (
      select against_id,round(sum(total),10) total,count(*) tx_count from filtered group by against_id) s;
  if v_size>0 then
    select (x->>'date')::timestamptz,x->>'id' into v_last_date,v_last_id
      from jsonb_array_elements(v_items) with ordinality a(x,n) order by n desc limit 1;
  end if;
  return jsonb_build_object('items',v_items,'has_more',v_has_more,
    'next_cursor',case when v_last_id is null then null else jsonb_build_object('date',v_last_date,'id',v_last_id) end,
    'matched_count',v_count,'totals_by_against',v_totals);
end;
$$;

create or replace function public.sarraf_report_range(p_from date default null,p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_from date;v_to date;v_daily jsonb;
begin
  v_actor:=public.sarraf_require_admin(false);
  v_to:=coalesce(p_to,(statement_timestamp() at time zone 'Asia/Baghdad')::date);
  v_from:=coalesce(p_from,v_to-29);
  if v_from>v_to or v_to-v_from>366 then raise exception using errcode='22023',message='report range must be 367 days or less';end if;
  select coalesce(jsonb_agg(to_jsonb(s) order by date),'[]'::jsonb) into v_daily from (
    select t.date::date date,count(*) tx_count,count(*) filter(where t.type='buy') buy_count,
      count(*) filter(where t.type='sell') sell_count,
      round(coalesce(sum(public.sarraf_usd_value_at(t.profit,t.profit_cur_id,'receive',t.date))
        filter(where t.type='sell' and t.profit is not null),0),10) profit_usd
    from public.txs t where not t.deleted and t.date>=v_from::timestamptz and t.date<(v_to+1)::timestamptz
    group by t.date::date) s;
  return jsonb_build_object('from',v_from,'to',v_to,'daily',v_daily,'generated_at',statement_timestamp());
end;
$$;

-- Same accounting answer as the original function, now with an application-role boundary.
create or replace function public.sarraf_trial_balance_check()
returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_debits numeric;v_credits numeric;v_lines bigint;
begin
  v_actor:=public.sarraf_require_admin(false);
  select coalesce(sum(case when l.side='debit' then l.base_amount else 0 end),0),
         coalesce(sum(case when l.side='credit' then l.base_amount else 0 end),0),count(*)
    into v_debits,v_credits,v_lines
    from public.journal_lines l join public.journal_entries e on e.id=l.entry_id where e.status='posted';
  return jsonb_build_object('balanced',abs(v_debits-v_credits)<=0.00000001,
    'debits',round(v_debits,10),'credits',round(v_credits,10),
    'difference',round(v_debits-v_credits,10),'posted_lines',v_lines);
end;
$$;

create or replace function public.sarraf_subledger_reconciliation()
returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_vault jsonb;v_debt jsonb;v_partner jsonb;
begin
  v_actor:=public.sarraf_require_admin(false);
  select coalesce(jsonb_agg(to_jsonb(s) order by currency),'[]'::jsonb) into v_vault from (
    select currency,round(sum(available),10) customer_vault_total,round(sum(reserved),10) held_total
      from public.customer_vaults group by currency) s;
  select coalesce(jsonb_agg(to_jsonb(s) order by currency,debtor_type,creditor_type),'[]'::jsonb) into v_debt from (
    select currency,debtor_type,creditor_type,round(sum(outstanding_principal),10) outstanding
      from public.debts where status in ('open','partially_settled') group by currency,debtor_type,creditor_type) s;
  select coalesce(jsonb_agg(to_jsonb(s) order by currency),'[]'::jsonb) into v_partner from (
    select currency,round(sum(available),10) partner_available from public.partner_accounts group by currency) s;
  return jsonb_build_object('customer_vaults',v_vault,'debts',v_debt,'partner_accounts',v_partner,
    'generated_at',statement_timestamp());
end;
$$;

create or replace function public.sarraf_ledger_journal_reconciliation()
returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_gap bigint;v_orphan bigint;v_draft bigint;v_trial jsonb;
begin
  v_actor:=public.sarraf_require_admin(false);
  select count(*) into v_gap from public.v_ledger_journal_gaps;
  select count(*) into v_orphan from public.v_journal_orphans;
  select count(*) into v_draft from public.v_journal_drafts;
  v_trial:=public.sarraf_trial_balance_check();
  return jsonb_build_object('ok',v_gap=0 and v_orphan=0 and v_draft=0 and coalesce((v_trial->>'balanced')::boolean,false),
    'ledger_journal_gaps',v_gap,'journal_orphans',v_orphan,'journal_drafts',v_draft,
    'trial_balance',v_trial,'generated_at',statement_timestamp());
end;
$$;

create or replace function public.sarraf_reconciliation_report()
returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_checks jsonb:='[]'::jsonb;v_fail integer:=0;v_warn integer:=0;
  v_count bigint;v_trial jsonb;v_status text;
begin
  v_actor:=public.sarraf_require_admin(false);
  select count(*) into v_count from public.txs t where not t.deleted and not exists(select 1 from public.ledger l where l.tx_id=t.id);
  v_status:=case when v_count=0 then 'PASS' else 'FAIL' end;v_fail:=v_fail+case when v_count>0 then 1 else 0 end;
  v_checks:=v_checks||jsonb_build_object('name','active transactions have physical-ledger rows','status',v_status,'count',v_count);
  select count(*) into v_count from public.ledger l where l.tx_id is not null and not exists(select 1 from public.txs t where t.id=l.tx_id);
  v_status:=case when v_count=0 then 'PASS' else 'FAIL' end;v_fail:=v_fail+case when v_count>0 then 1 else 0 end;
  v_checks:=v_checks||jsonb_build_object('name','ledger transaction references exist','status',v_status,'count',v_count);
  select count(*) into v_count from public.v_transaction_business_flow_integrity where issue is not null;
  v_status:=case when v_count=0 then 'PASS' else 'FAIL' end;v_fail:=v_fail+case when v_count>0 then 1 else 0 end;
  v_checks:=v_checks||jsonb_build_object('name','A/B/C transaction invariants','status',v_status,'count',v_count);
  select count(*) into v_count from public.v_pending_transaction_gaps;
  v_status:=case when v_count=0 then 'PASS' else 'WARN' end;v_warn:=v_warn+case when v_count>0 then 1 else 0 end;
  v_checks:=v_checks||jsonb_build_object('name','pending transaction links','status',v_status,'count',v_count);
  select count(*) into v_count from public.v_journal_drafts;
  v_status:=case when v_count=0 then 'PASS' else 'WARN' end;v_warn:=v_warn+case when v_count>0 then 1 else 0 end;
  v_checks:=v_checks||jsonb_build_object('name','journal drafts awaiting rates','status',v_status,'count',v_count);
  select count(*) into v_count from public.v_ledger_journal_gaps;
  v_status:=case when v_count=0 then 'PASS' else 'FAIL' end;v_fail:=v_fail+case when v_count>0 then 1 else 0 end;
  v_checks:=v_checks||jsonb_build_object('name','ledger and journal linkage','status',v_status,'count',v_count);
  select count(*) into v_count from public.v_journal_orphans;
  v_status:=case when v_count=0 then 'PASS' else 'FAIL' end;v_fail:=v_fail+case when v_count>0 then 1 else 0 end;
  v_checks:=v_checks||jsonb_build_object('name','journal source references','status',v_status,'count',v_count);
  select count(*) into v_count from public.currencies c
    where coalesce((public.sarraf_inventory_snapshot_at(c.id,null,null)->>'oversold')::numeric,0)>0;
  v_status:=case when v_count=0 then 'PASS' else 'FAIL' end;v_fail:=v_fail+case when v_count>0 then 1 else 0 end;
  v_checks:=v_checks||jsonb_build_object('name','no negative shared inventory','status',v_status,'count',v_count);
  v_trial:=public.sarraf_trial_balance_check();
  v_status:=case when coalesce((v_trial->>'balanced')::boolean,false) then 'PASS' else 'FAIL' end;
  v_fail:=v_fail+case when v_status='FAIL' then 1 else 0 end;
  v_checks:=v_checks||jsonb_build_object('name','double-entry trial balance','status',v_status,
    'count',case when v_status='PASS' then 0 else 1 end,'detail',v_trial);
  return jsonb_build_object('ok',v_fail=0,'failures',v_fail,'warnings',v_warn,'checks',v_checks,
    'generated_at',statement_timestamp());
end;
$$;

create or replace function public.sarraf_runtime_contract()
returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_missing jsonb;v_tables boolean;v_settings public.control_settings%rowtype;
begin
  v_actor:=public.sarraf_actor();
  if v_actor.role in ('admin','office')
     and (nullif(current_setting('request.jwt.claims',true),'') is not null
       or nullif(current_setting('request.jwt.claim.aal',true),'') is not null)
     and public.sarraf_request_aal() is distinct from 'aal2' then
    raise exception using errcode='42501',message='MFA/AAL2 is required';end if;
  select coalesce(jsonb_agg(name order by name),'[]'::jsonb) into v_missing from (values
    ('sarraf_commit_transactions(jsonb,jsonb,text,text,text,text)'),('sarraf_edit_transaction(jsonb,jsonb,text,text,text)'),
    ('sarraf_void_transaction(text,text,text,text)'),('sarraf_post_ledger_command(jsonb,text,text,text)'),
    ('sarraf_read_model_snapshot(integer)'),('sarraf_reconciliation_report()'),('sarraf_runtime_contract()')
  ) f(name) where to_regprocedure(name) is null;
  v_tables:=to_regclass('public.txs') is not null and to_regclass('public.ledger') is not null
    and to_regclass('public.journal_entries') is not null and to_regclass('public.receipt_documents') is not null;
  select * into v_settings from public.control_settings where singleton;
  return jsonb_build_object('ok',v_tables and jsonb_array_length(v_missing)=0,
    'contract_version','13f-v1','phase13f_applied',true,'baseline_ready',v_tables,
    'missing_critical_functions',v_missing,'maintenance_mode',coalesce(v_settings.maintenance_mode,false),
    'maintenance_reason',v_settings.maintenance_reason,'settings_version',v_settings.version,
    'server_time',statement_timestamp(),'actor_role',v_actor.role);
end;
$$;

create or replace function public.sarraf_system_health()
returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_runtime jsonb;v_recon jsonb;
begin
  v_actor:=public.sarraf_require_admin(false);v_runtime:=public.sarraf_runtime_contract();v_recon:=public.sarraf_reconciliation_report();
  return jsonb_build_object('ok',coalesce((v_runtime->>'ok')::boolean,false) and coalesce((v_recon->>'ok')::boolean,false),
    'runtime',v_runtime,'reconciliation',v_recon,'generated_at',statement_timestamp(),
    'row_counts',jsonb_build_object('transactions',(select count(*) from public.txs),
      'ledger',(select count(*) from public.ledger),'journal_entries',(select count(*) from public.journal_entries),
      'receipt_documents',(select count(*) from public.receipt_documents)));
end;
$$;

create or replace function public.sarraf_set_maintenance_mode(p_enabled boolean,p_reason text,p_command_key text)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_replay jsonb;v_result jsonb;
begin
  v_actor:=public.sarraf_require_admin(true);perform public.sarraf_assert_writes_open('set_maintenance_mode');
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text||':'||p_command_key,0));
  v_replay:=public.sarraf_command_replay(v_actor.auth_id,p_command_key,'set_maintenance_mode');if v_replay is not null then return v_replay;end if;
  if char_length(btrim(coalesce(p_reason,'')))<12 then raise exception using errcode='22023',message='a 12-character maintenance reason is required';end if;
  update public.control_settings set maintenance_mode=coalesce(p_enabled,false),maintenance_reason=left(btrim(p_reason),700),
    maintenance_changed_by=v_actor.id,maintenance_changed_at=statement_timestamp(),version=version+1,
    updated_by=v_actor.id,updated_at=statement_timestamp() where singleton;
  perform public.sarraf_write_audit(v_actor.id,case when p_enabled then 'Emergency Freeze چالاک کرا' else 'Emergency Freeze ناچالاک کرا' end,p_reason);
  v_result:=jsonb_build_object('ok',true,'maintenance_mode',coalesce(p_enabled,false),'reason',left(btrim(p_reason),700));
  return public.sarraf_store_command(v_actor.auth_id,p_command_key,'set_maintenance_mode',v_result);
end;
$$;

-- Final least-privilege pass. Earlier migrations treated every office as generic internal
-- staff. PostgreSQL SELECT policies are permissive (OR-composed), so adding a narrow office
-- policy did not cancel those older broad policies. Offices now see their exact assignments
-- through tx_office_r/office RPCs; raw books, bank evidence and unrelated receipts stay admin
-- only. Customer/partner ownership policies remain intact.
drop policy if exists txs_tenant_read on public.txs;
create policy txs_tenant_read on public.txs for select to authenticated using (
  public.is_admin() or cp_id=public.my_app_id() or partner_id=public.my_app_id()
);
drop policy if exists ledger_tenant_read on public.ledger;
create policy ledger_tenant_read on public.ledger for select to authenticated using (
  public.is_admin() or partner_id=public.my_app_id() or investor_id=public.my_app_id()
);

drop policy if exists receipt_batches_portal_read_b on public.receipt_batches;
drop policy if exists receipts_admin_read_baseline on public.receipts;
drop policy if exists receipts_assurance_read on public.receipts;
create policy receipts_assurance_read on public.receipts for select to authenticated using (
  public.is_admin() or partner_id=public.my_app_id() or exists(
    select 1 from public.receipt_custody c
     where c.item_id=receipts.id and c.partner_id=public.my_app_id())
);

drop policy if exists receipt_intake_staff_read on public.receipt_intake_items;
create policy receipt_intake_staff_read on public.receipt_intake_items for select to authenticated
  using (public.is_admin());
drop policy if exists receipt_custody_staff_read on public.receipt_custody;
create policy receipt_custody_staff_read on public.receipt_custody for select to authenticated
  using (public.is_admin());
drop policy if exists receipt_custody_events_staff_read on public.receipt_custody_events;
create policy receipt_custody_events_staff_read on public.receipt_custody_events for select to authenticated
  using (public.is_admin());
drop policy if exists receipt_batch_transactions_staff_read on public.receipt_batch_transactions;
create policy receipt_batch_transactions_staff_read on public.receipt_batch_transactions for select to authenticated
  using (public.is_admin());

drop policy if exists rd_staff_read on public.receipt_documents;
create policy rd_staff_read on public.receipt_documents for select to authenticated using (public.is_admin());
drop policy if exists re_staff_read on public.receipt_extractions;
create policy re_staff_read on public.receipt_extractions for select to authenticated using (public.is_admin());
drop policy if exists rst_staff_read on public.receipt_state_transitions;
create policy rst_staff_read on public.receipt_state_transitions for select to authenticated using (public.is_admin());
drop policy if exists rf_staff_read on public.receipt_forwardings;
create policy rf_staff_read on public.receipt_forwardings for select to authenticated using (public.is_admin());
drop policy if exists rcl_staff_read on public.receipt_custody_ledger;
create policy rcl_staff_read on public.receipt_custody_ledger for select to authenticated using (public.is_admin());

drop policy if exists coa_staff_read on public.chart_of_accounts;
create policy coa_staff_read on public.chart_of_accounts for select to authenticated using (public.is_admin());
drop policy if exists je_staff_read on public.journal_entries;
create policy je_staff_read on public.journal_entries for select to authenticated using (public.is_admin());
drop policy if exists jl_staff_read on public.journal_lines;
create policy jl_staff_read on public.journal_lines for select to authenticated using (public.is_admin());
drop policy if exists pa_staff_read on public.partner_accounts;
create policy pa_staff_read on public.partner_accounts for select to authenticated using (public.is_admin());
drop policy if exists pae_staff_read on public.partner_account_events;
create policy pae_staff_read on public.partner_account_events for select to authenticated using (public.is_admin());
drop policy if exists cv_staff_read on public.customer_vaults;
create policy cv_staff_read on public.customer_vaults for select to authenticated using (public.is_admin());
drop policy if exists cve_staff_read on public.customer_vault_events;
create policy cve_staff_read on public.customer_vault_events for select to authenticated using (public.is_admin());
drop policy if exists debt_staff_read on public.debts;
create policy debt_staff_read on public.debts for select to authenticated using (public.is_admin());
drop policy if exists ds_staff_read on public.debt_settlements;
create policy ds_staff_read on public.debt_settlements for select to authenticated using (public.is_admin());

do $storage_receipt_least_privilege$
begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists receipt_storage_assurance_read on storage.objects';
    execute $policy$
      create policy receipt_storage_assurance_read on storage.objects
      as restrictive for select to authenticated using (
        bucket_id <> 'receipts' or (
          (owner_id=auth.uid()::text and name like 'ingest/%'
            and created_at>statement_timestamp()-interval '30 minutes')
          or public.is_admin()
          or exists(select 1 from public.receipts r where r.image_path=name and (
            r.partner_id=public.my_app_id() or exists(
              select 1 from public.receipt_custody c
               where c.item_id=r.id and c.partner_id=public.my_app_id())
          ))
        )
      )
    $policy$;
  end if;
end;
$storage_receipt_least_privilege$;

-- Aggregate financial views must execute with caller RLS, and browser roles do not receive a
-- blanket SELECT grant. Authorized summaries are exposed only by the guarded RPCs above.
do $$
declare v text;
begin
  foreach v in array array['v_journal_drafts','v_ledger_journal_gaps','v_journal_orphans',
    'v_pending_transaction_gaps','v_transaction_business_flow_integrity','v_partner_trade_custody',
    'v_receipt_batch_structured_details']
  loop
    if to_regclass('public.'||v) is not null then
      execute format('alter view public.%I set (security_invoker=true)',v);
      execute format('revoke all on public.%I from public,anon,authenticated',v);
    end if;
  end loop;
end;
$$;

revoke all on function public.sarraf_self_profile() from public,anon;
revoke all on function public.sarraf_control_snapshot() from public,anon;
revoke all on function public.sarraf_read_model_snapshot(integer) from public,anon;
revoke all on function public.sarraf_inventory_snapshot(text,timestamptz,text) from public,anon;
revoke all on function public.sarraf_tx_history_page(integer,timestamptz,text,text,text,text,date,date,text) from public,anon;
revoke all on function public.sarraf_report_range(date,date) from public,anon;
revoke all on function public.sarraf_trial_balance_check() from public,anon;
revoke all on function public.sarraf_subledger_reconciliation() from public,anon;
revoke all on function public.sarraf_ledger_journal_reconciliation() from public,anon;
revoke all on function public.sarraf_reconciliation_report() from public,anon;
revoke all on function public.sarraf_runtime_contract() from public,anon;
revoke all on function public.sarraf_system_health() from public,anon;
revoke all on function public.sarraf_set_maintenance_mode(boolean,text,text) from public,anon;
grant execute on function public.sarraf_self_profile(),public.sarraf_control_snapshot(),
  public.sarraf_read_model_snapshot(integer),public.sarraf_inventory_snapshot(text,timestamptz,text),
  public.sarraf_tx_history_page(integer,timestamptz,text,text,text,text,date,date,text),
  public.sarraf_report_range(date,date),public.sarraf_trial_balance_check(),
  public.sarraf_subledger_reconciliation(),public.sarraf_ledger_journal_reconciliation(),
  public.sarraf_reconciliation_report(),public.sarraf_runtime_contract(),public.sarraf_system_health(),
  public.sarraf_set_maintenance_mode(boolean,text,text)
to authenticated;

commit;
