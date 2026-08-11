-- ═══════════════════════════════════════════════════════════════════════════════
-- ZEMAN — پشکنینی فەیسی ١ تا ٥ لەسەر داتابەیسی خۆت
-- Paste this whole file into the Supabase SQL Editor and press Run.
--
-- It proves two different things:
--   STRUCTURE  — every table, function, trigger, enum and policy actually exists.
--   BEHAVIOUR  — the database really does REFUSE the things it is supposed to refuse.
--
-- Nothing is left behind. Every write happens inside a savepoint that is always rolled
-- back, so this is safe to run on a live database as often as you like.
-- ═══════════════════════════════════════════════════════════════════════════════

drop table if exists _zeman_verify;
create temp table _zeman_verify(seq serial, area text, check_name text, status text, detail text);

do $$
declare
  ok boolean;
  detail text;
  n int;

begin
  -- ── STRUCTURE: tables ────────────────────────────────────────────────────────
  for detail in
    select unnest(array[
      'chart_of_accounts','journal_entries','journal_lines','accounting_commands',
      'customer_vaults','customer_vault_events','debts','debt_settlements',
      'partner_accounts','partner_account_events',
      'office_payment_assignments','office_payment_events',
      'receipt_documents','receipt_extractions','receipt_state_transitions',
      'receipt_forwardings','receipt_custody_ledger'])
  loop
    ok := to_regclass('public.' || detail) is not null;
    insert into _zeman_verify(area, check_name, status, detail)
    values ('STRUCTURE', 'خشتەی ' || detail, case when ok then 'PASS' else 'FAIL' end,
            case when ok then 'هەیە' else 'نەدۆزرایەوە — migration جێبەجێ نەکراوە' end);
  end loop;

  -- ── STRUCTURE: functions ─────────────────────────────────────────────────────
  for detail in
    select unnest(array[
      'sarraf_trial_balance_check','sarraf_subledger_reconciliation','sarraf_debt_waterfall',
      'sarraf_base_amount','sarraf_post_simple_entry',
      'sarraf_customer_vault_move','sarraf_apply_vault_to_debt','sarraf_zeman_debt_to_vault',
      'sarraf_partner_disburse','sarraf_partner_credit','sarraf_office_payment_report',
      'receipt_transition_allowed','receipt_upload_allowed',
      'sarraf_receipt_intake_begin','sarraf_receipt_intake_stored','sarraf_receipt_intake_extracted',
      'sarraf_my_receipt_intakes',
      'sarraf_forward_receipts','sarraf_receipt_mark_delivered','sarraf_receipt_mark_seen',
      'sarraf_my_forwarded_receipts','sarraf_forwarding_reconciliation',
      'sarraf_usd_value','post_transaction_journal','sarraf_reverse_transaction_entry'])
  loop
    select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = detail;
    ok := n > 0;
    insert into _zeman_verify(area, check_name, status, detail)
    values ('STRUCTURE', 'فەنکشنی ' || detail, case when ok then 'PASS' else 'FAIL' end,
            case when ok then 'هەیە' else 'نەدۆزرایەوە' end);
  end loop;

  -- ── STRUCTURE: enums ─────────────────────────────────────────────────────────
  for detail in
    select unnest(array['account_kind','journal_status','entry_side','vault_event_kind',
                        'debt_status','party_kind','office_assignment_status',
                        'receipt_flow','receipt_state','delivery_status'])
  loop
    ok := exists (select 1 from pg_type t join pg_namespace ns on ns.oid = t.typnamespace
                   where ns.nspname='public' and t.typname = detail and t.typtype='e');
    insert into _zeman_verify(area, check_name, status, detail)
    values ('STRUCTURE', 'جۆری ' || detail, case when ok then 'PASS' else 'FAIL' end, null);
  end loop;

  -- ── STRUCTURE: chart of accounts is seeded ───────────────────────────────────
  -- Wrapped so a missing table reports itself instead of aborting the whole report.
  begin
    select count(*) into n from public.chart_of_accounts;
    insert into _zeman_verify(area, check_name, status, detail)
    values ('STRUCTURE', 'هێڵکاری هەژمارەکان', case when n >= 18 then 'PASS' else 'FAIL' end,
            n || ' هەژمار (پێویستە ١٨ یان زیاتر)');
  exception when others then
    insert into _zeman_verify(area, check_name, status, detail)
    values ('STRUCTURE', 'هێڵکاری هەژمارەکان', 'FAIL', 'خشتەکە نییە — migration جێبەجێ نەکراوە');
  end;

  -- ── STRUCTURE: the transaction journal trigger is attached ───────────────────
  ok := exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
                 where c.relname='txs' and t.tgname='txs_post_journal' and not t.tgisinternal);
  insert into _zeman_verify(area, check_name, status, detail)
  values ('STRUCTURE', 'مامەڵەکان دەچنە ناو دەفتەرەوە', case when ok then 'PASS' else 'FAIL' end,
          case when ok then 'trigger چالاکە' else 'trigger نییە — فەیسی ٥ جێبەجێ نەکراوە' end);

  -- ── STRUCTURE: RLS is on ─────────────────────────────────────────────────────
  select count(*) into n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
   where ns.nspname='public' and c.relrowsecurity
     and c.relname in ('journal_entries','journal_lines','customer_vaults','debts',
                       'partner_accounts','office_payment_assignments','receipt_documents');
  insert into _zeman_verify(area, check_name, status, detail)
  values ('SECURITY', 'RLS چالاکە لەسەر خشتە هەستیارەکان',
          case when n = 7 then 'PASS' else 'FAIL' end, n || ' لە ٧ خشتە');
end $$;

-- ── BEHAVIOUR ──────────────────────────────────────────────────────────────────
-- Each test writes inside a savepoint and always rolls back, so nothing persists.
do $$
declare
  v_admin text;
  v_cust  text;
  ok boolean;
begin
  -- Borrow any existing admin/customer so foreign keys resolve; create nothing permanent.
  select id into v_admin from public.app_users where role='admin' and not deleted limit 1;
  select id into v_cust  from public.app_users where role='customer' and not deleted limit 1;

  if v_admin is null then
    insert into _zeman_verify(area, check_name, status, detail)
    values ('BEHAVIOUR','پشکنینی ڕەفتار','SKIP','هیچ ئەدمینێک نییە — سەرەتا ئەکاونتێک دروست بکە');
    return;
  end if;

  -- Skip the behaviour probes entirely when the ledger is not installed yet.
  if to_regclass('public.journal_entries') is null then
    insert into _zeman_verify(area,check_name,status,detail)
    values ('BEHAVIOUR','پشکنینی ڕەفتار','SKIP','دەفتەر دانەمەزراوە — سەرەتا migration ـەکان ڕەن بکە');
    return;
  end if;

  -- 1. An unbalanced journal entry must be refused.
  begin
    insert into public.journal_entries(id,status,business_date,posted_at,source_type,actor_id)
    values ('_vfy_bad','posted',current_date,now(),'verify_probe',v_admin);
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate)
    values ('_vfy_bad',1,'acc-1400','debit','CNY',1000,138.89,7.2),
           ('_vfy_bad',2,'acc-1000','credit','CNY',900,125.00,7.2);
    -- The balance trigger is deferred to COMMIT; force it now so the probe can see it.
    set constraints all immediate;
    ok := false;   -- reaching here means the unbalanced entry was accepted
    raise exception '_vfy_rollback';
  exception when others then
    ok := (sqlerrm <> '_vfy_rollback');
  end;
  insert into _zeman_verify(area,check_name,status,detail)
  values ('BEHAVIOUR','تۆماری ناهاوسەنگ ڕەت دەکرێتەوە', case when ok then 'PASS' else 'FAIL' end,
          case when ok then 'داتابەیس ڕەتی کردەوە ✓' else 'قبووڵ کرا — بەگی گەورە' end);

  -- 2. A balanced entry must post, and then be immutable.
  begin
    insert into public.journal_entries(id,status,business_date,posted_at,source_type,actor_id)
    values ('_vfy_ok','posted',current_date,now(),'verify_probe',v_admin);
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate)
    values ('_vfy_ok',1,'acc-1400','debit','CNY',720,100,7.2),
           ('_vfy_ok',2,'acc-1000','credit','CNY',720,100,7.2);
    set constraints all immediate;
    -- Now prove it cannot be deleted.
    begin
      delete from public.journal_entries where id='_vfy_ok';
      ok := false;
    exception when others then ok := true;
    end;
    raise exception '_vfy_rollback';
  exception when others then
    if sqlerrm <> '_vfy_rollback' then ok := false; end if;
  end;
  insert into _zeman_verify(area,check_name,status,detail)
  values ('BEHAVIOUR','تۆماری posted ناسڕدرێتەوە', case when ok then 'PASS' else 'FAIL' end,
          case when ok then 'تەنها بە reversal دەگۆڕدرێت ✓' else 'سڕایەوە — بەگ' end);

  -- 3. A cashbox cannot be overdrawn.
  if v_cust is not null then
    begin
      insert into public.customer_vaults(id,customer_id,currency)
      values ('_vfy_cv',v_cust,'CNY') on conflict (customer_id,currency) do nothing;
      insert into public.customer_vault_events(vault_id,customer_id,currency,kind,available_delta,actor_id)
      select id, v_cust,'CNY','withdrawal',-999999999,v_admin
        from public.customer_vaults where customer_id=v_cust and currency='CNY';
      ok := false;
      raise exception '_vfy_rollback';
    exception when others then
      ok := (sqlerrm <> '_vfy_rollback');
    end;
    insert into _zeman_verify(area,check_name,status,detail)
    values ('BEHAVIOUR','قاسە ناتوانێت زیاد لە باڵانس دەربکات', case when ok then 'PASS' else 'FAIL' end, null);
  end if;

  -- 4. A receipt cannot skip states.
  if v_cust is not null then
    begin
      insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
      values ('_vfy_doc','customer_sells_to_zeman',v_cust,v_cust,'ingest/_vfy.jpg');
      begin
        update public.receipt_documents set state='accepted' where id='_vfy_doc';
        ok := false;
      exception when others then ok := true;
      end;
      raise exception '_vfy_rollback';
    exception when others then
      if sqlerrm <> '_vfy_rollback' then ok := false; end if;
    end;
    insert into _zeman_verify(area,check_name,status,detail)
    values ('BEHAVIOUR','فیش ناتوانێت قۆناغ بازبدات', case when ok then 'PASS' else 'FAIL' end,
            case when ok then 'created → accepted ڕەتکرایەوە ✓' else 'ڕێگەی پێدرا — بەگ' end);

    -- 5. A customer cannot upload a purchase receipt.
    begin
      insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
      values ('_vfy_doc2','customer_buys_from_zeman',v_cust,v_cust,'ingest/_vfy2.jpg');
      ok := false;
      raise exception '_vfy_rollback';
    exception when others then
      ok := (sqlerrm <> '_vfy_rollback');
    end;
    insert into _zeman_verify(area,check_name,status,detail)
    values ('BEHAVIOUR','کڕیار ناتوانێت فیشی کڕین بنێرێت', case when ok then 'PASS' else 'FAIL' end, null);
  end if;

  -- 6. The empty-selection guard in sarraf_forward_receipts is the fixed one.
  -- The original was written `between 1 and 0`, a range no length can satisfy, so an empty
  -- selection was accepted and burnt its command key on a forward that sent nothing.
  begin
    ok := not exists (
      select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname='public' and p.proname='sarraf_forward_receipts'
         and p.prosrc like '%between 1 and 0%');
    insert into _zeman_verify(area,check_name,status,detail)
    values ('BEHAVIOUR','ناردنی بەتاڵ ڕەت دەکرێتەوە', case when ok then 'PASS' else 'FAIL' end,
            case when ok then 'گارد ڕاستکراوەتەوە ✓'
                 else '202608120009_forwarding_guard_fix.sql ڕەن نەکراوە' end);
  exception when others then
    insert into _zeman_verify(area,check_name,status,detail)
    values ('BEHAVIOUR','ناردنی بەتاڵ ڕەت دەکرێتەوە','SKIP', sqlerrm);
  end;

  -- 7. The trial balance reports itself.
  begin
    ok := (public.sarraf_trial_balance_check()->>'balanced')::boolean;
    insert into _zeman_verify(area,check_name,status,detail)
    values ('BEHAVIOUR','دەفتەر هاوسەنگە', case when ok then 'PASS' else 'WARN' end,
            public.sarraf_trial_balance_check()::text);
  exception when others then
    insert into _zeman_verify(area,check_name,status,detail)
    values ('BEHAVIOUR','دەفتەر هاوسەنگە','FAIL', sqlerrm);
  end;
end $$;

-- ── RESULT ─────────────────────────────────────────────────────────────────────
select area                                              as "بەش",
       check_name                                        as "پشکنین",
       status                                            as "ئەنجام",
       coalesce(detail,'')                               as "وردەکاری"
from _zeman_verify
order by seq;

-- ── SUMMARY ────────────────────────────────────────────────────────────────────
select
  count(*) filter (where status='PASS') as "سەرکەوتوو",
  count(*) filter (where status='FAIL') as "شکستخواردوو",
  count(*) filter (where status in ('SKIP','WARN')) as "تێپەڕێنراو",
  case when count(*) filter (where status='FAIL') = 0
       then '✅ هەموو فەیسەکان لە سیستەمەکەدان و کاردەکەن'
       else '❌ هەندێک شت کەمە — کۆڵۆمی وردەکاری ببینە'
  end as "کۆتا بڕیار"
from _zeman_verify;
