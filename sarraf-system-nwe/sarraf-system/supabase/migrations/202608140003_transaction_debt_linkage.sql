-- Keep the explicit debt subledger in lockstep with pending transactions.
--
-- A pending purchase means ZEMAN owes the registered customer; a pending sale means the
-- customer owes ZEMAN.  The debt is created from the transaction, never from a browser-supplied
-- direction or amount.  Completion is refused unless a posted settlement journal entry exists.
begin;

-- Once the recognition entry exists, economic identity is part of the books.  Metadata may
-- still be corrected, while amount/currency/party/date changes require a reversal and a new
-- transaction instead of silently drifting away from the journal and debt subledger.
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
       or new.date is distinct from old.date) then
    raise exception using errcode='42501',
      message='posted transaction economics are immutable; reverse and replace the transaction';
  end if;
  return new;
end;
$$;
drop trigger if exists txs_financial_identity_immutable on public.txs;
create trigger txs_financial_identity_immutable
  before update on public.txs
  for each row execute function public.protect_transaction_financial_identity();

create unique index if not exists debt_one_open_transaction_uq
  on public.debts(source_transaction_id)
  where source_type='unpaid_transaction' and status in ('open','partially_settled');

create or replace function public.sync_transaction_debt()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor text; v_currency text; v_debt public.debts%rowtype; v_entry text;
  v_key text; v_existing_count bigint;
begin
  if new.deleted then return null; end if;

  if new.status='pending' then
    if new.cp_id is null then
      raise exception using errcode='22023',
        message='a pending transaction requires a registered counterparty';
    end if;
    if not exists (select 1 from public.app_users
                    where id=new.cp_id and role='customer' and not deleted) then
      raise exception using errcode='22023', message='pending transaction counterparty is invalid';
    end if;
    if exists (select 1 from public.debts where source_type='unpaid_transaction'
                and source_transaction_id=new.id and status in ('open','partially_settled')) then
      return null;
    end if;

    select code into v_currency from public.currencies where id=new.against_id;
    select id into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
    if v_actor is null then
      select id into v_actor from public.app_users where role='admin' and not deleted order by id limit 1;
    end if;
    if v_actor is null then
      raise exception using errcode='42501', message='no accountable actor exists for the debt';
    end if;

    select count(*) into v_existing_count from public.debts
     where source_type='unpaid_transaction' and source_transaction_id=new.id;
    v_key:='tx-debt:'||new.id||':'||(v_existing_count+1)::text;
    if tg_op='UPDATE' and old.status='completed' then
      select id into v_entry from public.journal_entries
       where transaction_id=new.id and source_type='transaction_settlement_reversal' and status='posted'
       order by created_at desc limit 1;
      if v_entry is null then
        raise exception using errcode='23514',
          message='a completed transaction cannot reopen without a posted settlement reversal';
      end if;
    else
      v_entry:='je-tx-'||new.id;
    end if;

    insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
      original_principal,outstanding_principal,source_type,source_transaction_id,reason,
      created_by,journal_entry_id,command_key)
    values ('debt-tx-'||md5(new.id||':'||(v_existing_count+1)::text),
      case when new.type='buy' then 'zeman' else 'customer' end::public.party_kind,
      case when new.type='buy' then null else new.cp_id end,
      case when new.type='buy' then 'customer' else 'zeman' end::public.party_kind,
      case when new.type='buy' then new.cp_id else null end,
      v_currency,abs(new.total),abs(new.total),'unpaid_transaction',new.id,
      case when tg_op='UPDATE' and old.status='completed'
           then 'payment settlement was reversed; transaction is pending again'
           else 'pending transaction' end,
      v_actor,v_entry,v_key);
    return null;
  end if;

  if tg_op='UPDATE' and old.status='pending' and new.status='completed' then
    select * into v_debt from public.debts
     where source_type='unpaid_transaction' and source_transaction_id=new.id
       and status in ('open','partially_settled') for update;
    if not found then
      raise exception using errcode='P0002',
        message='pending transaction has no open debt to settle';
    end if;
    -- A partial settlement follows a different command path.  Completing the transaction with
    -- the full cash leg here would otherwise clear the control account twice.
    if v_debt.outstanding_principal<>v_debt.original_principal then
      raise exception using errcode='22023',
        message='partially settled transaction debt requires a remaining-balance settlement command';
    end if;
    select id into v_entry from public.journal_entries
     where transaction_id=new.id and source_type='transaction_settlement' and status='posted'
     order by created_at desc limit 1;
    if v_entry is null then
      raise exception using errcode='23514',
        message='transaction cannot complete without a posted settlement entry';
    end if;
    select id into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
    if v_actor is null then
      raise exception using errcode='42501', message='settlement actor is not accountable';
    end if;
    insert into public.debt_settlements(debt_id,amount_applied,outstanding_before,outstanding_after,
      source_kind,transaction_id,journal_entry_id,actor_id,command_key,reason)
    values (v_debt.id,v_debt.outstanding_principal,v_debt.outstanding_principal,0,
      'transaction_payment',new.id,v_entry,v_actor,
      'tx-payment:'||new.id||':'||v_entry,'transaction payment completed');
  end if;
  return null;
end;
$$;

drop trigger if exists txs_sync_explicit_debt on public.txs;
create trigger txs_sync_explicit_debt
  after insert or update of status on public.txs
  for each row execute function public.sync_transaction_debt();

-- Historical pending transactions are brought under the same invariant.  Rows without a
-- registered customer are intentionally left visible for remediation rather than guessed.
insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
  original_principal,outstanding_principal,source_type,source_transaction_id,reason,
  created_by,journal_entry_id,command_key)
select 'debt-tx-'||md5(t.id||':1'),
  case when t.type='buy' then 'zeman' else 'customer' end::public.party_kind,
  case when t.type='buy' then null else t.cp_id end,
  case when t.type='buy' then 'customer' else 'zeman' end::public.party_kind,
  case when t.type='buy' then t.cp_id else null end,
  c.code,abs(t.total),abs(t.total),'unpaid_transaction',t.id,'pending transaction backfill',
  coalesce((select id from public.app_users where role='admin' and not deleted order by id limit 1),t.cp_id),
  case when exists (select 1 from public.journal_entries where id='je-tx-'||t.id)
       then 'je-tx-'||t.id else null end,
  'tx-debt:'||t.id||':1'
from public.txs t
join public.currencies c on c.id=t.against_id
join public.app_users cp on cp.id=t.cp_id and cp.role='customer' and not cp.deleted
where not t.deleted and t.status='pending' and t.cp_id is not null
  and not exists (select 1 from public.debts d where d.source_type='unpaid_transaction'
                   and d.source_transaction_id=t.id and d.status in ('open','partially_settled'));

-- A repair queue for historical or externally-created rows that predate the canonical command
-- path.  It never guesses an office or a customer; administrators see the exact missing link.
create or replace view public.v_pending_transaction_gaps as
select t.id as transaction_id,t.type,t.cp_id,t.status,t.date,
  not exists (select 1 from public.debts d
               where d.source_type='unpaid_transaction' and d.source_transaction_id=t.id
                 and d.status in ('open','partially_settled')) as missing_open_debt,
  (t.type='buy' and not exists (select 1 from public.office_payment_assignments a
               where a.transaction_id=t.id and a.status not in ('confirmed','cancelled','rejected'))) as missing_office_assignment,
  not exists (select 1 from public.journal_entries e
               where e.source_type='transaction' and e.source_id=t.id and e.status='posted') as missing_posted_recognition
from public.txs t
where not t.deleted and t.status='pending'
  and (not exists (select 1 from public.debts d
                    where d.source_type='unpaid_transaction' and d.source_transaction_id=t.id
                      and d.status in ('open','partially_settled'))
    or (t.type='buy' and not exists (select 1 from public.office_payment_assignments a
                    where a.transaction_id=t.id and a.status not in ('confirmed','cancelled','rejected')))
    or not exists (select 1 from public.journal_entries e
                    where e.source_type='transaction' and e.source_id=t.id and e.status='posted'));
revoke all on public.v_pending_transaction_gaps from public,anon;
grant select on public.v_pending_transaction_gaps to authenticated;

commit;
