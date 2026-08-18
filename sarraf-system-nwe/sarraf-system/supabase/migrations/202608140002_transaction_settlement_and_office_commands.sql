-- Canonical transaction settlement and office-payment commands.
--
-- Recognition and cash settlement are separate accounting events.  A pending trade records
-- inventory plus a receivable/payable; completing it clears that control account against cash.
-- The original recognition entry is never rewritten.  Unsettling posts an exact reversal of
-- the settlement entry and returns the transaction to pending.
begin;

-- One immutable manual daily-rate source serves receipts and every accounting command.
-- The legacy p_rate argument remains in function signatures for compatibility, but it is not
-- trusted: valuation is derived here from the server-held snapshot.
create or replace function public.sarraf_base_amount(
  p_amount numeric, p_currency text, p_rate numeric
) returns numeric
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare v_currency text:=upper(btrim(p_currency)); v_rate numeric;
begin
  if v_currency='USD' then return round(p_amount,10); end if;
  select r.rate_value into v_rate from public.receipt_daily_rates r
   where r.currency=v_currency and r.effective_date<=current_date
   order by r.effective_date desc,r.version desc limit 1;
  if v_rate is null or v_rate<=0 then
    raise exception using errcode='22023',
      message=format('a server-held daily rate is required to value %s',v_currency);
  end if;
  return round(p_amount/v_rate,10);
end;
$$;

create or replace function public.sarraf_usd_value(p_amount numeric,p_cur_id text)
returns numeric
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare v_code text; v_rate numeric;
begin
  if p_amount is null then return null; end if;
  select upper(code) into v_code from public.currencies where id=p_cur_id;
  if v_code is null then return null; end if;
  if v_code='USD' then return round(p_amount,10); end if;
  select r.rate_value into v_rate from public.receipt_daily_rates r
   where r.currency=v_code and r.effective_date<=current_date
   order by r.effective_date desc,r.version desc limit 1;
  if v_rate is null or v_rate<=0 then return null; end if;
  return round(p_amount/v_rate,10);
end;
$$;

-- The old helper accepted a browser-supplied rate and also stored that value as journal
-- metadata.  Base valuation above was already moved to the server snapshot; replace the
-- writer as well so base_rate/rate_date/rate_source describe the same immutable snapshot.
create or replace function public.sarraf_post_simple_entry(
  p_id text, p_business_date date, p_source_type text, p_actor_id text,
  p_debit_account text, p_credit_account text,
  p_currency text, p_amount numeric, p_rate numeric,
  p_description text, p_command_key text default null,
  p_party_type text default null, p_party_id text default null,
  p_transaction_id text default null, p_rate_date date default null
) returns text
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_currency text:=upper(btrim(p_currency));
  v_base numeric; v_effective_rate numeric; v_rate_date date; v_rate_source text;
begin
  if p_amount is null or p_amount<=0 then
    raise exception using errcode='22023', message='journal amount must be greater than zero';
  end if;
  -- p_rate remains only for call-signature compatibility.  It is deliberately never trusted.
  if v_currency='USD' then
    v_base:=round(p_amount,10);
    v_effective_rate:=1; v_rate_date:=coalesce(p_rate_date,p_business_date,current_date);
    v_rate_source:='base_currency';
  else
    select r.rate_value,r.effective_date into v_effective_rate,v_rate_date
      from public.receipt_daily_rates r
     where r.currency=v_currency and r.effective_date<=coalesce(p_business_date,current_date)
     order by r.effective_date desc,r.version desc limit 1;
    if v_effective_rate is null or v_effective_rate<=0 then
      raise exception using errcode='22023',
        message=format('a server-held daily rate is required to post %s',v_currency);
    end if;
    v_base:=round(p_amount/v_effective_rate,10);
    v_rate_source:='manual_daily_snapshot';
  end if;

  insert into public.journal_entries(
    id,status,business_date,posted_at,source_type,actor_id,command_key,
    description,transaction_id)
  values (p_id,'posted',p_business_date,statement_timestamp(),p_source_type,p_actor_id,
    p_command_key,left(p_description,500),p_transaction_id);
  insert into public.journal_lines(
    entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,
    rate_source,rate_date,party_type,party_id)
  values
    (p_id,1,p_debit_account,'debit',v_currency,p_amount,v_base,v_effective_rate,
      v_rate_source,v_rate_date,p_party_type,p_party_id),
    (p_id,2,p_credit_account,'credit',v_currency,p_amount,v_base,v_effective_rate,
      v_rate_source,v_rate_date,p_party_type,p_party_id);
  return p_id;
end;
$$;

create table if not exists public.transaction_payment_events (
  id bigint generated always as identity primary key,
  transaction_id text not null references public.txs(id),
  event_kind text not null check (event_kind in ('settled','settlement_reversed')),
  amount numeric(38,10) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3,8}$'),
  journal_entry_id text not null references public.journal_entries(id),
  office_assignment_id text references public.office_payment_assignments(id),
  actor_id text not null references public.app_users(id),
  reason text not null,
  command_key text not null,
  created_at timestamptz not null default statement_timestamp(),
  unique (actor_id, command_key)
);
create index if not exists tpe_tx_idx
  on public.transaction_payment_events(transaction_id, created_at desc);

create table if not exists public.office_payment_evidence (
  id text primary key,
  assignment_id text not null references public.office_payment_assignments(id),
  storage_path text not null unique,
  image_sha256 text not null,
  file_size bigint not null,
  media_type text not null,
  actor_id text not null references public.app_users(id),
  command_key text not null,
  created_at timestamptz not null default statement_timestamp(),
  unique(actor_id,command_key),
  check (image_sha256 ~ '^[a-f0-9]{64}$'),
  check (file_size between 1 and 10485760),
  check (media_type in ('image/jpeg','image/png','image/webp','application/pdf'))
);
create index if not exists opev_assignment_idx
  on public.office_payment_evidence(assignment_id,created_at desc);
alter table public.office_payment_events add column if not exists evidence_id text
  references public.office_payment_evidence(id);

-- An approval may execute the transaction later under a checker.  Preserve the exact office
-- intent beside that approval so the delayed transaction and its assignment can be reconciled
-- without guessing an office, amount, currency, or customer.
create table if not exists public.office_pending_assignments (
  approval_id text primary key,
  requested_transaction_id text not null,
  office_id text not null references public.app_users(id),
  due_at timestamptz,
  reason text not null,
  requested_by text not null references public.app_users(id),
  command_key text not null,
  status text not null default 'pending'
    check(status in ('pending','completed','cancelled','failed')),
  assignment_id text references public.office_payment_assignments(id),
  error_text text,
  created_at timestamptz not null default statement_timestamp(),
  resolved_at timestamptz,
  unique(requested_by,command_key)
);

create or replace function public.protect_transaction_payment_events()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception using errcode='42501',
    message='transaction payment events are append-only; post a reversal instead';
end;
$$;
drop trigger if exists transaction_payment_events_immutable on public.transaction_payment_events;
create trigger transaction_payment_events_immutable
  before update or delete on public.transaction_payment_events
  for each row execute function public.protect_transaction_payment_events();

create or replace function public.protect_office_payment_evidence()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  raise exception using errcode='42501',message='office payment evidence is append-only';
end;
$$;
drop trigger if exists office_payment_evidence_immutable on public.office_payment_evidence;
create trigger office_payment_evidence_immutable
  before update or delete on public.office_payment_evidence
  for each row execute function public.protect_office_payment_evidence();

-- Populate an existing DRAFT recognition entry after its missing currency rate is supplied.
-- Nothing is guessed: both legs must have a current USD value before any line is posted.
create or replace function public.sarraf_resolve_transaction_recognition(p_transaction_id text)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_t public.txs%rowtype; v_e public.journal_entries%rowtype;
  v_cur_code text; v_against_code text; v_amount numeric; v_total numeric;
  v_amount_usd numeric; v_total_usd numeric; v_rate_cur numeric; v_rate_against numeric;
  v_spread numeric; v_counterparty text; v_line int := 0; v_settled boolean;
begin
  select * into v_t from public.txs where id=p_transaction_id and not deleted for update;
  if not found then raise exception using errcode='P0002', message='transaction not found'; end if;

  select * into v_e from public.journal_entries
   where id='je-tx-' || v_t.id for update;
  if not found then
    raise exception using errcode='P0002', message='transaction recognition entry not found';
  end if;
  if v_e.status='posted' then return v_e.id; end if;
  if v_e.status<>'draft' then
    raise exception using errcode='22023', message='transaction recognition is not an open draft';
  end if;

  select code into v_cur_code from public.currencies where id=v_t.cur_id;
  select code into v_against_code from public.currencies where id=v_t.against_id;
  v_amount := abs(v_t.amount); v_total := abs(v_t.total);
  v_amount_usd := public.sarraf_usd_value(v_amount, v_t.cur_id);
  v_total_usd := public.sarraf_usd_value(v_total, v_t.against_id);
  if v_amount_usd is null or v_total_usd is null then
    raise exception using errcode='22023',
      message='the transaction still has a currency without a USD rate';
  end if;

  v_rate_cur := case when lower(v_t.cur_id)='usd' then 1 else v_amount/nullif(v_amount_usd,0) end;
  v_rate_against := case when lower(v_t.against_id)='usd' then 1 else v_total/nullif(v_total_usd,0) end;
  v_spread := v_total_usd-v_amount_usd;
  v_settled := v_t.status='completed';
  v_counterparty := case when v_settled then 'acc-1000'
                         when v_t.type='buy' then 'acc-2300' else 'acc-1200' end;

  if v_t.type='buy' then
    v_line := v_line+1;
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,
      base_amount,base_rate,rate_source,party_type,party_id,memo)
    values (v_e.id,v_line,'acc-1400','debit',v_cur_code,v_amount,v_amount_usd,v_rate_cur,
      'currency_mid',case when v_t.partner_id is not null then 'partner' end,v_t.partner_id,
      'دراوی کڕدراو هاتە ژوورەوە');
    v_line := v_line+1;
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,
      base_amount,base_rate,rate_source,party_type,party_id,memo)
    values (v_e.id,v_line,v_counterparty,'credit',v_against_code,v_total,v_total_usd,v_rate_against,
      'currency_mid',case when v_t.cp_id is not null then 'customer' end,v_t.cp_id,
      case when v_settled then 'پارە درا' else 'پارە هێشتا نەدراوە' end);
    if abs(v_spread)>0.0000000001 then
      v_line := v_line+1;
      insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,
        base_amount,base_rate,rate_source,memo)
      values (v_e.id,v_line,case when v_spread>0 then 'acc-5900' else 'acc-4000' end,
        (case when v_spread>0 then 'debit' else 'credit' end)::public.entry_side,
        'USD',abs(v_spread),abs(v_spread),1,'currency_mid','جیاوازی نرخ لە کڕیندا');
    end if;
  else
    v_line := v_line+1;
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,
      base_amount,base_rate,rate_source,party_type,party_id,memo)
    values (v_e.id,v_line,v_counterparty,'debit',v_against_code,v_total,v_total_usd,v_rate_against,
      'currency_mid',case when v_t.cp_id is not null then 'customer' end,v_t.cp_id,
      case when v_settled then 'پارە وەرگیرا' else 'پارە هێشتا وەرنەگیراوە' end);
    v_line := v_line+1;
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,
      base_amount,base_rate,rate_source,party_type,party_id,memo)
    values (v_e.id,v_line,'acc-1400','credit',v_cur_code,v_amount,v_amount_usd,v_rate_cur,
      'currency_mid',case when v_t.partner_id is not null then 'partner' end,v_t.partner_id,
      'دراوی فرۆشراو چووە دەرەوە');
    if abs(v_spread)>0.0000000001 then
      v_line := v_line+1;
      insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,
        base_amount,base_rate,rate_source,memo)
      values (v_e.id,v_line,case when v_spread>0 then 'acc-4000' else 'acc-5900' end,
        (case when v_spread>0 then 'credit' else 'debit' end)::public.entry_side,
        'USD',abs(v_spread),abs(v_spread),1,'currency_mid','جیاوازی نرخ لە فرۆشتندا');
    end if;
  end if;

  update public.journal_entries
     set status='posted', posted_at=statement_timestamp(),
         description=left(format('transaction %s resolved after rate publication',v_t.id),500)
   where id=v_e.id;
  return v_e.id;
end;
$$;
revoke all on function public.sarraf_resolve_transaction_recognition(text) from public, anon, authenticated;

create or replace function public.sarraf_resolve_transaction_draft(
  p_transaction_id text, p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_actor public.app_users%rowtype; v_prev jsonb; v_entry text; v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' then
    raise exception using errcode='42501', message='only an administrator may resolve a journal draft';
  end if;
  if char_length(btrim(coalesce(p_reason,'')))<8 then
    raise exception using errcode='22023', message='an 8-character reason is required';
  end if;
  if nullif(btrim(coalesce(p_command_key,'')),'') is null then
    raise exception using errcode='22023', message='a command key is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_prev from public.accounting_commands
   where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_prev||jsonb_build_object('replayed',true); end if;
  v_entry := public.sarraf_resolve_transaction_recognition(p_transaction_id);
  v_result := jsonb_build_object('transaction_id',p_transaction_id,'journal_entry_id',v_entry,
    'status','posted','replayed',false);
  insert into public.accounting_commands(actor_id,command_key,operation,result)
  values (v_actor.id,p_command_key,'resolve_transaction_draft',v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_resolve_transaction_draft(text,text,text) from public, anon;
grant execute on function public.sarraf_resolve_transaction_draft(text,text,text) to authenticated;

-- Internal exact reversal.  The source lines are copied unchanged except for the side.
create or replace function public.sarraf_reverse_posted_entry(
  p_entry_id text, p_actor_id text, p_reason text, p_command_key text,
  p_source_type text, p_transaction_id text
) returns text
language plpgsql set search_path = pg_catalog, public
as $$
declare v_src public.journal_entries%rowtype; v_rev text; l record; v_n int:=0;
begin
  select * into v_src from public.journal_entries where id=p_entry_id for update;
  if not found or v_src.status<>'posted' then
    raise exception using errcode='P0002', message='posted journal entry not found';
  end if;
  if v_src.reversed_by is not null then return v_src.reversed_by; end if;
  v_rev := 'je-rev-'||md5(p_entry_id||':'||p_command_key);
  insert into public.journal_entries(id,status,business_date,posted_at,source_type,source_id,
    transaction_id,actor_id,command_key,description,reversal_of)
  values (v_rev,'posted',current_date,statement_timestamp(),p_source_type,p_transaction_id,
    p_transaction_id,p_actor_id,p_command_key,left(btrim(p_reason),500),p_entry_id);
  for l in select * from public.journal_lines where entry_id=p_entry_id order by line_no loop
    v_n:=v_n+1;
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,
      base_rate,rate_source,rate_date,party_type,party_id,memo)
    values (v_rev,v_n,l.account_id,
      (case when l.side='debit' then 'credit' else 'debit' end)::public.entry_side,
      l.currency,l.amount,l.base_amount,l.base_rate,l.rate_source,l.rate_date,l.party_type,l.party_id,
      'هەڵوەشاندنەوە: '||coalesce(l.memo,''));
  end loop;
  update public.journal_entries set reversed_by=v_rev,status='reversed' where id=p_entry_id;
  return v_rev;
end;
$$;
revoke all on function public.sarraf_reverse_posted_entry(text,text,text,text,text,text)
  from public, anon, authenticated;

create or replace function public.sarraf_settle_transaction(
  p_tx_id text, p_by_office boolean, p_command_key text, p_action text, p_detail text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_t public.txs%rowtype;
  v_code text; v_base numeric; v_rate numeric; v_entry text; v_result jsonb; v_reason text;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' then
    raise exception using errcode='42501', message='only an administrator may settle a transaction directly';
  end if;
  if coalesce(p_by_office,false) then
    raise exception using errcode='22023',
      message='office payments require an assignment, office report, and administrator confirmation';
  end if;
  v_reason:=coalesce(nullif(btrim(p_detail),''),nullif(btrim(p_action),''));
  if char_length(coalesce(v_reason,''))<8 then
    raise exception using errcode='22023', message='an 8-character settlement reason is required';
  end if;
  if nullif(btrim(coalesce(p_command_key,'')),'') is null then
    raise exception using errcode='22023', message='a command key is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_prev from public.accounting_commands
   where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_prev||jsonb_build_object('replayed',true); end if;

  select * into v_t from public.txs where id=p_tx_id and not deleted for update;
  if not found then raise exception using errcode='P0002', message='transaction not found'; end if;
  if v_t.status<>'pending' then
    raise exception using errcode='22023', message='only a pending transaction may be settled';
  end if;
  if exists (select 1 from public.office_payment_assignments
              where transaction_id=v_t.id and status not in ('confirmed','cancelled','rejected')) then
    raise exception using errcode='22023',
      message='this transaction has an active office assignment and must follow its confirmation flow';
  end if;

  -- A draft recognition must be made real before its control account can be cleared.
  perform public.sarraf_resolve_transaction_recognition(v_t.id);
  select code into v_code from public.currencies where id=v_t.against_id;
  v_base := public.sarraf_usd_value(abs(v_t.total),v_t.against_id);
  if v_base is null then
    raise exception using errcode='22023', message='a USD rate is required for settlement';
  end if;
  v_rate := case when lower(v_t.against_id)='usd' then 1 else abs(v_t.total)/nullif(v_base,0) end;
  v_entry := 'je-tx-settle-'||md5(v_actor.id||':'||p_command_key);
  perform public.sarraf_post_simple_entry(v_entry,current_date,'transaction_settlement',v_actor.id,
    case when v_t.type='buy' then 'acc-2300' else 'acc-1000' end,
    case when v_t.type='buy' then 'acc-1000' else 'acc-1200' end,
    v_code,abs(v_t.total),v_rate,
    v_reason,
    p_command_key,case when v_t.cp_id is not null then 'customer' end,v_t.cp_id,v_t.id,current_date);

  update public.txs set status='completed',paid_at=statement_timestamp() where id=v_t.id;
  insert into public.transaction_payment_events(transaction_id,event_kind,amount,currency,
    journal_entry_id,actor_id,reason,command_key)
  values (v_t.id,'settled',abs(v_t.total),v_code,v_entry,v_actor.id,
    left(v_reason,700),p_command_key);
  v_result:=jsonb_build_object('transaction_id',v_t.id,'status','completed','paid_at',statement_timestamp(),
    'journal_entry_id',v_entry,'replayed',false);
  insert into public.accounting_commands(actor_id,command_key,operation,result)
  values (v_actor.id,p_command_key,'settle_transaction',v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_settle_transaction(text,boolean,text,text,text) from public, anon;
grant execute on function public.sarraf_settle_transaction(text,boolean,text,text,text) to authenticated;

create or replace function public.sarraf_unsettle_transaction(
  p_tx_id text, p_command_key text, p_action text, p_detail text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_t public.txs%rowtype; v_event record;
  v_rev text; v_code text; v_result jsonb; v_reason text;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' then
    raise exception using errcode='42501', message='only an administrator may reverse settlement';
  end if;
  if nullif(btrim(coalesce(p_command_key,'')),'') is null then
    raise exception using errcode='22023', message='a command key is required';
  end if;
  v_reason:=coalesce(nullif(btrim(p_detail),''),nullif(btrim(p_action),''));
  if char_length(coalesce(v_reason,''))<8 then
    raise exception using errcode='22023', message='an 8-character reversal reason is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_prev from public.accounting_commands
   where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_prev||jsonb_build_object('replayed',true); end if;
  select * into v_t from public.txs where id=p_tx_id and not deleted for update;
  if not found then raise exception using errcode='P0002', message='transaction not found'; end if;
  if v_t.status<>'completed' then
    raise exception using errcode='22023', message='only a completed transaction may be unsettled';
  end if;
  select e.* into v_event from public.transaction_payment_events e
   join public.journal_entries j on j.id=e.journal_entry_id and j.status='posted'
   where e.transaction_id=v_t.id and e.event_kind='settled'
   order by e.created_at desc,e.id desc limit 1;
  if not found then
    raise exception using errcode='P0002', message='no active settlement entry exists for this transaction';
  end if;
  v_rev:=public.sarraf_reverse_posted_entry(v_event.journal_entry_id,v_actor.id,v_reason,
    p_command_key,'transaction_settlement_reversal',v_t.id);
  update public.txs set status='pending',paid_at=null where id=v_t.id;
  select code into v_code from public.currencies where id=v_t.against_id;
  insert into public.transaction_payment_events(transaction_id,event_kind,amount,currency,
    journal_entry_id,office_assignment_id,actor_id,reason,command_key)
  values (v_t.id,'settlement_reversed',abs(v_t.total),v_code,v_rev,
    v_event.office_assignment_id,v_actor.id,left(v_reason,700),p_command_key);
  v_result:=jsonb_build_object('transaction_id',v_t.id,'status','pending',
    'reversal_entry_id',v_rev,'replayed',false);
  insert into public.accounting_commands(actor_id,command_key,operation,result)
  values (v_actor.id,p_command_key,'unsettle_transaction',v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_unsettle_transaction(text,text,text,text) from public, anon;
grant execute on function public.sarraf_unsettle_transaction(text,text,text,text) to authenticated;

-- One live office assignment per transaction.  Amount, currency, customer and transaction
-- direction are copied from the locked transaction; the browser supplies only the office.
create unique index if not exists opa_one_active_transaction_uq
  on public.office_payment_assignments(transaction_id)
  where transaction_id is not null and status not in ('confirmed','cancelled','rejected');

create or replace function public.sarraf_create_office_payment_assignment(
  p_transaction_id text, p_office_id text, p_due_at timestamptz,
  p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_t public.txs%rowtype;
  v_assignment text; v_currency text; v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' then
    raise exception using errcode='42501', message='only an administrator may assign office payments';
  end if;
  if nullif(btrim(coalesce(p_command_key,'')),'') is null then
    raise exception using errcode='22023', message='a command key is required';
  end if;
  if char_length(btrim(coalesce(p_reason,'')))<3 then
    raise exception using errcode='22023', message='an assignment reason is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_prev from public.accounting_commands
   where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_prev||jsonb_build_object('replayed',true); end if;
  select * into v_t from public.txs where id=p_transaction_id and not deleted for update;
  if not found then raise exception using errcode='P0002', message='transaction not found'; end if;
  if v_t.type<>'buy' or v_t.status<>'pending' then
    raise exception using errcode='22023', message='only a pending purchase may be assigned to an office';
  end if;
  if not exists (select 1 from public.app_users
                  where id=p_office_id and role='office' and not deleted) then
    raise exception using errcode='22023', message='invalid office';
  end if;
  if exists (select 1 from public.office_payment_assignments
              where transaction_id=v_t.id and status not in ('confirmed','cancelled','rejected')) then
    raise exception using errcode='23505', message='this transaction already has an active office assignment';
  end if;
  select code into v_currency from public.currencies where id=v_t.against_id;
  v_assignment:='opa-'||md5(v_actor.id||':'||p_command_key);
  insert into public.office_payment_assignments(id,office_id,transaction_id,customer_id,
    amount,currency,due_at,assigned_by,command_key,payment_note)
  values (v_assignment,p_office_id,v_t.id,v_t.cp_id,abs(v_t.total),v_currency,p_due_at,
    v_actor.id,p_command_key,left(btrim(p_reason),700));
  insert into public.office_payment_events(assignment_id,from_status,to_status,note,actor_id,command_key)
  values (v_assignment,null,'assigned',left(btrim(p_reason),700),v_actor.id,p_command_key);
  v_result:=jsonb_build_object('assignment_id',v_assignment,'transaction_id',v_t.id,
    'office_id',p_office_id,'amount',abs(v_t.total),'currency',v_currency,'status','assigned','replayed',false);
  insert into public.accounting_commands(actor_id,command_key,operation,result)
  values (v_actor.id,p_command_key,'create_office_payment_assignment',v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_create_office_payment_assignment(text,text,timestamptz,text,text)
  from public, anon;
grant execute on function public.sarraf_create_office_payment_assignment(text,text,timestamptz,text,text)
  to authenticated;

create or replace function public.sarraf_queue_approved_office_assignment(
  p_approval_id text,p_transaction_id text,p_office_id text,p_due_at timestamptz,
  p_reason text,p_command_key text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare
  v_actor public.app_users%rowtype; v_existing public.office_pending_assignments%rowtype;
  v_maker text; v_status text; v_operation text; v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' then
    raise exception using errcode='42501',message='only an administrator may queue an office assignment';
  end if;
  if nullif(btrim(coalesce(p_approval_id,'')),'') is null
     or nullif(btrim(coalesce(p_transaction_id,'')),'') is null
     or nullif(btrim(coalesce(p_command_key,'')),'') is null
     or char_length(btrim(coalesce(p_reason,'')))<3 then
    raise exception using errcode='22023',message='approval, transaction, reason, and command key are required';
  end if;
  if not exists(select 1 from public.app_users where id=p_office_id and role='office' and not deleted) then
    raise exception using errcode='22023',message='invalid office';
  end if;
  if to_regclass('public.approval_requests') is null then
    raise exception using errcode='55000',message='approval storage is unavailable';
  end if;
  -- Approval ids are normalized to text because older deployments used both text and UUID ids.
  execute 'select maker_app_id,status,operation from public.approval_requests where id::text=$1'
    into v_maker,v_status,v_operation using p_approval_id;
  if v_maker is distinct from v_actor.id or v_operation is distinct from 'commit_transactions'
     or v_status not in ('pending','approved','executed') then
    raise exception using errcode='42501',message='the transaction approval does not belong to this request';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('office-approval:'||p_approval_id,0));
  select * into v_existing from public.office_pending_assignments where approval_id=p_approval_id;
  if found then
    if v_existing.requested_transaction_id is distinct from p_transaction_id
       or v_existing.office_id is distinct from p_office_id then
      raise exception using errcode='23505',message='approval already has a different office intent';
    end if;
    return jsonb_build_object('approval_id',v_existing.approval_id,'status',v_existing.status,
      'assignment_id',v_existing.assignment_id,'replayed',true);
  end if;
  insert into public.office_pending_assignments(
    approval_id,requested_transaction_id,office_id,due_at,reason,requested_by,command_key)
  values(p_approval_id,p_transaction_id,p_office_id,p_due_at,left(btrim(p_reason),700),
    v_actor.id,p_command_key);
  v_result:=jsonb_build_object('approval_id',p_approval_id,'transaction_id',p_transaction_id,
    'office_id',p_office_id,'status','pending','replayed',false);
  insert into public.accounting_commands(actor_id,command_key,operation,result)
  values(v_actor.id,p_command_key,'queue_approved_office_assignment',v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_queue_approved_office_assignment(text,text,text,timestamptz,text,text)
  from public,anon;
grant execute on function public.sarraf_queue_approved_office_assignment(text,text,text,timestamptz,text,text)
  to authenticated;

create or replace function public.sarraf_reconcile_pending_office_assignments()
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare
  v_actor public.app_users%rowtype; p record; v_tx_id text; v_assignment jsonb;
  v_completed int:=0; v_cancelled int:=0; v_failed int:=0;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' then
    raise exception using errcode='42501',message='office assignment reconciliation is not authorized';
  end if;
  if to_regclass('public.approval_requests') is null then
    return jsonb_build_object('completed',0,'cancelled',0,'failed',0);
  end if;
  for p in execute $q$
    select o.*,a.status approval_status,a.result approval_result
      from public.office_pending_assignments o join public.approval_requests a on a.id::text=o.approval_id
     where o.status='pending' and a.status in
       ('executed','approved','rejected','cancelled','expired','failed')
     for update of o
  $q$
  loop
    if p.approval_status in ('rejected','cancelled','expired','failed') then
      update public.office_pending_assignments
         set status='cancelled',resolved_at=statement_timestamp()
       where approval_id=p.approval_id;
      v_cancelled:=v_cancelled+1;
      continue;
    end if;
    v_tx_id:=coalesce(
      p.approval_result->'transactions'->0->>'id',p.approval_result->'transaction'->>'id',
      p.approval_result->'result'->'transactions'->0->>'id',
      p.approval_result->'result'->'transaction'->>'id');
    if v_tx_id is null or not exists(select 1 from public.txs where id=v_tx_id and not deleted) then
      continue;
    end if;
    if v_tx_id is distinct from p.requested_transaction_id
       or not exists(select 1 from public.txs where id=v_tx_id and type='buy' and status='pending' and not deleted) then
      update public.office_pending_assignments set status='failed',
        error_text='approved transaction did not match the pending purchase intent',
        resolved_at=statement_timestamp() where approval_id=p.approval_id;
      v_failed:=v_failed+1;
      continue;
    end if;
    select jsonb_build_object('assignment_id',a.id) into v_assignment
      from public.office_payment_assignments a
     where a.transaction_id=v_tx_id and a.office_id=p.office_id
       and a.status not in ('cancelled','rejected') order by a.assigned_at desc limit 1;
    if v_assignment is null then
      begin
        v_assignment:=public.sarraf_create_office_payment_assignment(
          v_tx_id,p.office_id,p.due_at,p.reason,p.command_key||':resolved');
      exception when others then
        update public.office_pending_assignments set status='failed',
          error_text=left(sqlerrm,700),resolved_at=statement_timestamp()
          where approval_id=p.approval_id;
        v_failed:=v_failed+1;
        continue;
      end;
    end if;
    update public.office_pending_assignments set status='completed',
      assignment_id=v_assignment->>'assignment_id',resolved_at=statement_timestamp(),error_text=null
      where approval_id=p.approval_id;
    v_completed:=v_completed+1;
  end loop;
  return jsonb_build_object('completed',v_completed,'cancelled',v_cancelled,'failed',v_failed);
end;
$$;
revoke all on function public.sarraf_reconcile_pending_office_assignments() from public,anon;
grant execute on function public.sarraf_reconcile_pending_office_assignments() to authenticated;

-- Normal pending purchases and their office assignment are one database transaction.  A lost
-- response may replay either inner command, but can never leave a committed purchase without
-- its assignment because any exception rolls the enclosing function back.
create or replace function public.sarraf_commit_pending_purchase_with_office(
  p_tx jsonb, p_office_id text, p_due_at timestamptz,
  p_command_key text, p_action text, p_detail text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_result jsonb; v_assignment jsonb; v_tx_id text;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' then
    raise exception using errcode='42501', message='only an administrator may create a pending office purchase';
  end if;
  if nullif(btrim(coalesce(p_command_key,'')),'') is null then
    raise exception using errcode='22023', message='a command key is required';
  end if;
  if jsonb_typeof(p_tx)<>'object' or p_tx->>'type'<>'buy' or p_tx->>'status'<>'pending'
     or nullif(btrim(p_tx->>'id'),'') is null or nullif(btrim(p_tx->>'cp_id'),'') is null then
    raise exception using errcode='22023',
      message='the command requires one pending purchase with a registered customer';
  end if;
  if not exists (select 1 from public.app_users
                  where id=p_tx->>'cp_id' and role='customer' and not deleted) then
    raise exception using errcode='22023', message='pending purchase customer is invalid';
  end if;
  if not exists (select 1 from public.app_users
                  where id=p_office_id and role='office' and not deleted) then
    raise exception using errcode='22023', message='pending purchase office is invalid';
  end if;

  v_result:=public.sarraf_commit_transactions(
    jsonb_build_array(p_tx),'[]'::jsonb,null,p_command_key||':tx',p_action,p_detail);
  if coalesce((v_result->>'approval_required')::boolean,false) then
    if nullif(v_result->>'approval_id','') is null then
      raise exception using errcode='23514',message='transaction approval identity is missing';
    end if;
    v_assignment:=public.sarraf_queue_approved_office_assignment(
      v_result->>'approval_id',p_tx->>'id',p_office_id,p_due_at,p_detail,p_command_key||':office-pending');
    return v_result||jsonb_build_object('office_assignment_pending',v_assignment);
  end if;
  v_tx_id:=coalesce(v_result->'transactions'->0->>'id',v_result->'transaction'->>'id',p_tx->>'id');
  if v_tx_id is distinct from p_tx->>'id' then
    raise exception using errcode='23514', message='committed transaction identity changed';
  end if;
  v_assignment:=public.sarraf_create_office_payment_assignment(
    v_tx_id,p_office_id,p_due_at,p_detail,p_command_key||':office');
  return coalesce(v_result,'{}'::jsonb)||jsonb_build_object('office_assignment',v_assignment);
end;
$$;
revoke all on function public.sarraf_commit_pending_purchase_with_office(jsonb,text,timestamptz,text,text,text)
  from public,anon;
grant execute on function public.sarraf_commit_pending_purchase_with_office(jsonb,text,timestamptz,text,text,text)
  to authenticated;

-- Receipt conversion owns its receipt locks and approval recovery.  This wrapper adds the same
-- exact-office invariant without splitting the immediate transaction and assignment into two
-- browser calls; delayed approvals persist the office intent above.
create or replace function public.sarraf_convert_pending_receipt_purchase_with_office(
  p_batch_id text,p_receipt_ids jsonb,p_tx jsonb,p_office_id text,p_due_at timestamptz,
  p_reason text,p_command_key text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype; v_result jsonb; v_assignment jsonb; v_tx_id text;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' then
    raise exception using errcode='42501',message='receipt purchase conversion is not authorized';
  end if;
  if jsonb_typeof(p_tx)<>'object' or p_tx->>'type'<>'buy' or p_tx->>'status'<>'pending'
     or nullif(btrim(p_tx->>'id'),'') is null then
    raise exception using errcode='22023',message='one pending receipt purchase is required';
  end if;
  if not exists(select 1 from public.app_users where id=p_office_id and role='office' and not deleted) then
    raise exception using errcode='22023',message='pending purchase office is invalid';
  end if;
  v_result:=public.sarraf_convert_receipt_batch_to_transaction(
    p_batch_id,p_receipt_ids,p_tx,p_reason,p_command_key||':receipts');
  if coalesce((v_result->>'approval_required')::boolean,false) then
    if nullif(v_result->>'approval_id','') is null then
      raise exception using errcode='23514',message='receipt transaction approval identity is missing';
    end if;
    v_assignment:=public.sarraf_queue_approved_office_assignment(
      v_result->>'approval_id',p_tx->>'id',p_office_id,p_due_at,p_reason,p_command_key||':office-pending');
    return v_result||jsonb_build_object('office_assignment_pending',v_assignment);
  end if;
  v_tx_id:=coalesce(v_result->'transactions'->0->>'id',v_result->'transaction'->>'id',p_tx->>'id');
  if v_tx_id is distinct from p_tx->>'id' then
    raise exception using errcode='23514',message='converted transaction identity changed';
  end if;
  v_assignment:=public.sarraf_create_office_payment_assignment(
    v_tx_id,p_office_id,p_due_at,p_reason,p_command_key||':office');
  return coalesce(v_result,'{}'::jsonb)||jsonb_build_object('office_assignment',v_assignment);
end;
$$;
revoke all on function public.sarraf_convert_pending_receipt_purchase_with_office(
  text,jsonb,jsonb,text,timestamptz,text,text) from public,anon;
grant execute on function public.sarraf_convert_pending_receipt_purchase_with_office(
  text,jsonb,jsonb,text,timestamptz,text,text) to authenticated;

-- The office uploads first, then this command binds the exact immutable object to its exact
-- assignment.  A reference string alone is not accepted as payment evidence.
create or replace function public.sarraf_office_payment_attach_evidence(
  p_assignment_id text,p_storage_path text,p_image_sha256 text,p_command_key text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare
  v_actor public.app_users%rowtype; v_a public.office_payment_assignments%rowtype;
  v_prev jsonb; v_exists boolean:=false; v_size bigint; v_media text; v_id text; v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'office' then
    raise exception using errcode='42501',message='only the assigned office may attach payment evidence';
  end if;
  if nullif(btrim(coalesce(p_command_key,'')),'') is null
     or lower(btrim(coalesce(p_image_sha256,''))) !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='22023',message='a command key and SHA-256 evidence fingerprint are required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_prev from public.accounting_commands
   where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_prev||jsonb_build_object('replayed',true); end if;
  select * into v_a from public.office_payment_assignments where id=p_assignment_id for update;
  if not found then raise exception using errcode='P0002',message='assignment not found'; end if;
  if v_a.office_id<>v_actor.id then
    raise exception using errcode='42501',message='this office payment assignment is not yours';
  end if;
  if v_a.status in ('confirmed','cancelled','rejected') then
    raise exception using errcode='22023',message='this assignment no longer accepts evidence';
  end if;
  if p_storage_path not like 'ingest/office-payments/'||p_assignment_id||'/%'
     or p_storage_path like '%..%' or p_storage_path !~ '\.(jpg|jpeg|png|webp|pdf)$' then
    raise exception using errcode='22023',message='invalid office payment evidence path';
  end if;
  if to_regclass('storage.objects') is null then
    raise exception using errcode='55000',message='evidence storage is unavailable';
  end if;
  execute $q$
    select exists(select 1 from storage.objects
      where bucket_id='receipts' and name=$1 and owner_id=$2
        and coalesce((metadata->>'size')::bigint,0) between 1 and 10485760
        and lower(coalesce(metadata->>'mimetype','')) in
          ('image/jpeg','image/png','image/webp','application/pdf')),
      coalesce((select (metadata->>'size')::bigint from storage.objects
        where bucket_id='receipts' and name=$1 and owner_id=$2),0),
      lower(coalesce((select metadata->>'mimetype' from storage.objects
        where bucket_id='receipts' and name=$1 and owner_id=$2),''))
  $q$ into v_exists,v_size,v_media using p_storage_path,auth.uid()::text;
  if not v_exists then
    raise exception using errcode='23514',message='the uploaded evidence object is missing, oversized, or unsupported';
  end if;
  v_id:='opev-'||md5(v_actor.id||':'||p_command_key);
  insert into public.office_payment_evidence(
    id,assignment_id,storage_path,image_sha256,file_size,media_type,actor_id,command_key)
  values(v_id,v_a.id,p_storage_path,lower(btrim(p_image_sha256)),v_size,v_media,v_actor.id,p_command_key);
  update public.office_payment_assignments set evidence_path=p_storage_path,version=version+1 where id=v_a.id;
  insert into public.office_payment_events(assignment_id,from_status,to_status,note,actor_id,command_key)
  values(v_a.id,v_a.status,v_a.status,'immutable payment evidence attached',v_actor.id,p_command_key);
  v_result:=jsonb_build_object('assignment_id',v_a.id,'evidence_id',v_id,
    'storage_path',p_storage_path,'sha256',lower(btrim(p_image_sha256)),'replayed',false);
  insert into public.accounting_commands(actor_id,command_key,operation,result)
  values(v_actor.id,p_command_key,'office_payment_attach_evidence',v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_office_payment_attach_evidence(text,text,text,text) from public,anon;
revoke all on function public.sarraf_office_payment_attach_evidence(text,text,text,text)
  from authenticated,service_role;
drop function public.sarraf_office_payment_attach_evidence(text,text,text,text);

-- Only the server route may attest bytes.  It downloads the protected object, detects its real
-- signature and hashes the bytes, then calls this service-role-only recorder.  The browser can
-- therefore never claim an arbitrary digest, size, or media type for payment evidence.
create or replace function public.sarraf_office_payment_attach_evidence_server(
  p_assignment_id text,p_storage_path text,p_image_sha256 text,p_file_size bigint,
  p_media_type text,p_actor_id text,p_command_key text
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare
  v_actor public.app_users%rowtype; v_a public.office_payment_assignments%rowtype;
  v_prev jsonb; v_object_exists boolean:=false; v_id text; v_result jsonb;
begin
  select * into v_actor from public.app_users
   where id=p_actor_id and role='office' and not deleted;
  if not found or v_actor.auth_id is null then
    raise exception using errcode='42501',message='evidence actor is not an active office';
  end if;
  if nullif(btrim(coalesce(p_command_key,'')),'') is null
     or lower(btrim(coalesce(p_image_sha256,''))) !~ '^[a-f0-9]{64}$'
     or p_file_size not between 1 and 10485760
     or p_media_type not in ('image/jpeg','image/png','image/webp','application/pdf') then
    raise exception using errcode='22023',message='server evidence attestation is invalid';
  end if;
  if p_storage_path not like 'ingest/office-payments/'||p_assignment_id||'/%'
     or p_storage_path like '%..%'
     or not ((p_media_type='image/jpeg' and p_storage_path~'\.(jpg|jpeg)$')
       or (p_media_type='image/png' and p_storage_path~'\.png$')
       or (p_media_type='image/webp' and p_storage_path~'\.webp$')
       or (p_media_type='application/pdf' and p_storage_path~'\.pdf$')) then
    raise exception using errcode='22023',message='evidence path does not match its detected media type';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_prev from public.accounting_commands
   where actor_id=v_actor.id and command_key=p_command_key;
  if found then
    if v_prev->>'assignment_id' is distinct from p_assignment_id
       or v_prev->>'storage_path' is distinct from p_storage_path then
      raise exception using errcode='23505',message='evidence command key is already bound to another object';
    end if;
    return v_prev||jsonb_build_object('replayed',true);
  end if;
  select * into v_a from public.office_payment_assignments where id=p_assignment_id for update;
  if not found then raise exception using errcode='P0002',message='assignment not found'; end if;
  if v_a.office_id<>v_actor.id then
    raise exception using errcode='42501',message='this office payment assignment is not yours';
  end if;
  if v_a.status in ('confirmed','cancelled','rejected') then
    raise exception using errcode='22023',message='this assignment no longer accepts evidence';
  end if;
  if to_regclass('storage.objects') is null then
    raise exception using errcode='55000',message='evidence storage is unavailable';
  end if;
  execute $q$
    select exists(select 1 from storage.objects
      where bucket_id='receipts' and name=$1 and owner_id=$2)
  $q$ into v_object_exists using p_storage_path,v_actor.auth_id::text;
  if not v_object_exists then
    raise exception using errcode='23514',message='the attested evidence object is missing or has another owner';
  end if;
  v_id:='opev-'||md5(v_actor.id||':'||p_command_key);
  insert into public.office_payment_evidence(
    id,assignment_id,storage_path,image_sha256,file_size,media_type,actor_id,command_key)
  values(v_id,v_a.id,p_storage_path,lower(btrim(p_image_sha256)),p_file_size,p_media_type,
    v_actor.id,p_command_key);
  update public.office_payment_assignments
     set evidence_path=p_storage_path,version=version+1 where id=v_a.id;
  insert into public.office_payment_events(
    assignment_id,from_status,to_status,note,actor_id,command_key)
  values(v_a.id,v_a.status,v_a.status,'server-attested immutable payment evidence attached',
    v_actor.id,p_command_key);
  v_result:=jsonb_build_object('assignment_id',v_a.id,'evidence_id',v_id,
    'storage_path',p_storage_path,'sha256',lower(btrim(p_image_sha256)),
    'file_size',p_file_size,'media_type',p_media_type,'server_attested',true,'replayed',false);
  insert into public.accounting_commands(actor_id,command_key,operation,result)
  values(v_actor.id,p_command_key,'office_payment_attach_evidence_server',v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_office_payment_attach_evidence_server(
  text,text,text,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.sarraf_office_payment_attach_evidence_server(
  text,text,text,bigint,text,text,text) to service_role;

-- Replace the non-idempotent report command from the first office migration.  Replaying the
-- same request returns its stored result and can never add the payment amount twice.
create or replace function public.sarraf_office_payment_report(
  p_assignment_id text, p_status public.office_assignment_status,
  p_amount numeric, p_reference text, p_note text, p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_a public.office_payment_assignments%rowtype;
  v_result jsonb; v_paid numeric; v_evidence_id text;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'office' then
    raise exception using errcode='42501', message='only the assigned office may report payment';
  end if;
  if nullif(btrim(coalesce(p_command_key,'')),'') is null then
    raise exception using errcode='22023', message='a command key is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_prev from public.accounting_commands
   where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_prev||jsonb_build_object('replayed',true); end if;
  select * into v_a from public.office_payment_assignments where id=p_assignment_id for update;
  if not found then raise exception using errcode='P0002', message='assignment not found'; end if;
  if v_actor.id<>v_a.office_id then
    raise exception using errcode='42501', message='this office payment assignment is not yours';
  end if;
  if v_a.status in ('confirmed','cancelled','rejected') then
    raise exception using errcode='22023', message='this assignment no longer accepts reports';
  end if;
  if p_status not in ('acknowledged','payment_initiated','paid_reported') then
    raise exception using errcode='22023', message='invalid office report status';
  end if;
  if p_status='acknowledged' and v_a.status<>'assigned' then
    raise exception using errcode='22023', message='acknowledgement cannot move an assignment backwards';
  end if;
  if p_status='payment_initiated' and v_a.status not in ('assigned','acknowledged','payment_initiated') then
    raise exception using errcode='22023', message='payment initiation cannot move an assignment backwards';
  end if;
  v_paid:=v_a.amount_paid;
  if p_status='paid_reported' then
    if p_amount is null or p_amount<=0 then
      raise exception using errcode='22023', message='a payment amount is required';
    end if;
    if char_length(btrim(coalesce(p_reference,'')))<3 then
      raise exception using errcode='22023', message='a payment reference is required';
    end if;
    select e.id into v_evidence_id from public.office_payment_evidence e
     where e.assignment_id=v_a.id and not exists(
       select 1 from public.office_payment_events pe where pe.evidence_id=e.id)
     order by e.created_at desc,e.id desc limit 1 for update;
    if v_evidence_id is null then
      raise exception using errcode='22023',message='new immutable evidence is required for each payment report';
    end if;
    if v_paid+p_amount>v_a.amount then
      raise exception using errcode='23514', message='reported payment exceeds the assignment';
    end if;
    v_paid:=v_paid+p_amount;
  end if;
  update public.office_payment_assignments
     set status=p_status,amount_paid=v_paid,
         payment_reference=coalesce(nullif(left(btrim(p_reference),160),''),payment_reference),
         payment_note=coalesce(nullif(left(btrim(p_note),700),''),payment_note),
         reported_at=case when p_status='paid_reported' then statement_timestamp() else reported_at end,
         version=version+1
   where id=v_a.id;
  insert into public.office_payment_events(assignment_id,from_status,to_status,amount_applied,
    reference,note,actor_id,command_key,evidence_id)
  values (v_a.id,v_a.status,p_status,case when p_status='paid_reported' then p_amount end,
    left(btrim(p_reference),160),left(btrim(p_note),700),v_actor.id,p_command_key,
    case when p_status='paid_reported' then v_evidence_id end);
  v_result:=jsonb_build_object('assignment_id',v_a.id,'status',p_status,
    'amount_paid',v_paid,'outstanding',v_a.amount-v_paid,'replayed',false);
  insert into public.accounting_commands(actor_id,command_key,operation,result)
  values (v_actor.id,p_command_key,'office_payment_report',v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_office_payment_report(text,public.office_assignment_status,numeric,text,text,text)
  from public, anon;
grant execute on function public.sarraf_office_payment_report(text,public.office_assignment_status,numeric,text,text,text)
  to authenticated;

create or replace function public.sarraf_office_payment_confirm(
  p_assignment_id text, p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_a public.office_payment_assignments%rowtype;
  v_t public.txs%rowtype; v_cur_id text; v_base numeric; v_rate numeric; v_entry text; v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' then
    raise exception using errcode='42501', message='only an administrator may confirm office payment';
  end if;
  if nullif(btrim(coalesce(p_command_key,'')),'') is null then
    raise exception using errcode='22023', message='a command key is required';
  end if;
  if char_length(btrim(coalesce(p_reason,'')))<8 then
    raise exception using errcode='22023', message='an 8-character confirmation reason is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_prev from public.accounting_commands
   where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_prev||jsonb_build_object('replayed',true); end if;
  select * into v_a from public.office_payment_assignments where id=p_assignment_id for update;
  if not found then raise exception using errcode='P0002', message='assignment not found'; end if;
  if v_a.status<>'paid_reported' or v_a.amount_paid<>v_a.amount then
    raise exception using errcode='22023', message='the full assigned amount must be reported before confirmation';
  end if;
  if not exists (select 1 from public.office_payment_events
                  where assignment_id=v_a.id and to_status='paid_reported' and evidence_id is not null) then
    raise exception using errcode='22023',message='payment evidence is required before confirmation';
  end if;
  select * into v_t from public.txs where id=v_a.transaction_id and not deleted for update;
  if not found or v_t.type<>'buy' or v_t.status<>'pending' then
    raise exception using errcode='22023', message='the assigned purchase is not pending';
  end if;
  perform public.sarraf_resolve_transaction_recognition(v_t.id);
  select id into v_cur_id from public.currencies where code=v_a.currency;
  v_base:=public.sarraf_usd_value(v_a.amount,v_cur_id);
  if v_base is null then raise exception using errcode='22023', message='a USD rate is required'; end if;
  v_rate:=case when v_a.currency='USD' then 1 else v_a.amount/nullif(v_base,0) end;
  v_entry:='je-office-settle-'||md5(v_actor.id||':'||p_command_key);
  perform public.sarraf_post_simple_entry(v_entry,current_date,'transaction_settlement',v_actor.id,
    'acc-2300','acc-1000',v_a.currency,v_a.amount,v_rate,
    'پشتڕاستکردنەوەی پارەدانی نووسینگە — '||left(btrim(p_reason),400),p_command_key,
    'office',v_a.office_id,v_t.id,current_date);
  update public.txs set status='completed',paid_at=statement_timestamp() where id=v_t.id;
  update public.office_payment_assignments
     set status='confirmed',confirmed_by=v_actor.id,confirmed_at=statement_timestamp(),version=version+1
   where id=v_a.id;
  insert into public.office_payment_events(assignment_id,from_status,to_status,actor_id,command_key,note)
  values (v_a.id,v_a.status,'confirmed',v_actor.id,p_command_key,left(btrim(p_reason),700));
  insert into public.transaction_payment_events(transaction_id,event_kind,amount,currency,
    journal_entry_id,office_assignment_id,actor_id,reason,command_key)
  values (v_t.id,'settled',v_a.amount,v_a.currency,v_entry,v_a.id,v_actor.id,
    left(btrim(p_reason),700),p_command_key);
  v_result:=jsonb_build_object('assignment_id',v_a.id,'transaction_id',v_t.id,
    'status','confirmed','journal_entry_id',v_entry,'replayed',false);
  insert into public.accounting_commands(actor_id,command_key,operation,result)
  values (v_actor.id,p_command_key,'office_payment_confirm',v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_office_payment_confirm(text,text,text) from public, anon;
grant execute on function public.sarraf_office_payment_confirm(text,text,text) to authenticated;

alter table public.transaction_payment_events enable row level security;
alter table public.office_payment_evidence enable row level security;
alter table public.office_pending_assignments enable row level security;
revoke all on public.transaction_payment_events from public, anon, authenticated;
revoke all on public.office_payment_evidence from public,anon,authenticated;
revoke all on public.office_pending_assignments from public,anon,authenticated;
grant select on public.transaction_payment_events to authenticated;
grant select on public.office_payment_evidence to authenticated;
grant select on public.office_pending_assignments to authenticated;
drop policy if exists tpe_admin_read on public.transaction_payment_events;
create policy tpe_admin_read on public.transaction_payment_events for select to authenticated
  using (public.is_admin());
drop policy if exists tpe_office_read on public.transaction_payment_events;
create policy tpe_office_read on public.transaction_payment_events for select to authenticated
  using (office_assignment_id is not null and exists (
    select 1 from public.office_payment_assignments a
     where a.id=transaction_payment_events.office_assignment_id and a.office_id=public.my_app_id()));

drop policy if exists opev_admin_read on public.office_payment_evidence;
create policy opev_admin_read on public.office_payment_evidence for select to authenticated
  using(public.is_admin());
drop policy if exists opev_office_read on public.office_payment_evidence;
create policy opev_office_read on public.office_payment_evidence for select to authenticated
  using(exists(select 1 from public.office_payment_assignments a
    where a.id=office_payment_evidence.assignment_id and a.office_id=public.my_app_id()));
drop policy if exists opa_pending_admin_read on public.office_pending_assignments;
create policy opa_pending_admin_read on public.office_pending_assignments for select to authenticated
  using(public.is_admin());

-- Once an evidence row points at a receipts-bucket object, neither update nor deletion is
-- allowed. The assigned office and administrators may still create a short-lived signed URL.
do $storage_policies$
begin
  if to_regclass('storage.objects') is not null then
    -- This restrictive policy composes with the project's existing permissive upload grant.  It
    -- prevents a caller from forging another user's owner id, bypassing the canonical ingest
    -- namespace, or parking an oversized/executable object in the financial-evidence bucket.
    execute 'drop policy if exists receipt_storage_assurance_insert on storage.objects';
    execute $policy$
      create policy receipt_storage_assurance_insert on storage.objects
      as restrictive for insert to authenticated with check (
        bucket_id<>'receipts' or (
          owner_id=auth.uid()::text
          and name like 'ingest/%'
          and coalesce(metadata->>'size','') ~ '^[0-9]+$'
          and (metadata->>'size')::bigint between 1 and 10485760
          and (
            (name like 'ingest/office-payments/%' and lower(coalesce(metadata->>'mimetype',''))
              in ('image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'))
            or
            (name not like 'ingest/office-payments/%' and lower(coalesce(metadata->>'mimetype',''))
              in ('image/jpeg','image/png','image/webp','image/heic','image/heif'))
          )
        ))
    $policy$;
    execute 'drop policy if exists receipt_storage_assurance_read on storage.objects';
    execute $policy$
      create policy receipt_storage_assurance_read on storage.objects
      as restrictive for select to authenticated using (
        bucket_id<>'receipts' or (
          (owner_id=auth.uid()::text and name like 'ingest/%'
           and created_at>statement_timestamp()-interval '30 minutes')
          or public.is_admin()
          or exists(select 1 from public.office_payment_evidence e
            join public.office_payment_assignments a on a.id=e.assignment_id
            where e.storage_path=name and a.office_id=public.my_app_id())
          or exists(select 1 from public.receipt_documents d where d.storage_path=name and (
            d.uploader_id=public.my_app_id() or exists(select 1 from public.receipt_forwardings f
              where f.document_id=d.id and f.to_actor_id=public.my_app_id())))
          or exists(select 1 from public.receipts r where r.image_path=name and (
            r.partner_id=public.my_app_id() or exists(select 1 from public.receipt_custody c
              where c.item_id=r.id and c.partner_id=public.my_app_id())))
        ))
    $policy$;
    execute 'drop policy if exists receipt_storage_assurance_delete on storage.objects';
    execute $policy$
      create policy receipt_storage_assurance_delete on storage.objects
      as restrictive for delete to authenticated using (
        bucket_id<>'receipts' or (
          owner_id=auth.uid()::text and name like 'ingest/%'
          and not exists(select 1 from public.receipt_intake_items i where i.image_path=name)
          and not exists(select 1 from public.receipts r where r.image_path=name)
          and not exists(select 1 from public.receipt_documents d where d.storage_path=name)
          and not exists(select 1 from public.office_payment_evidence e where e.storage_path=name)
        ))
    $policy$;
    execute 'drop policy if exists receipt_storage_assurance_update on storage.objects';
    execute $policy$
      create policy receipt_storage_assurance_update on storage.objects
      as restrictive for update to authenticated using (
        bucket_id<>'receipts' or (
          owner_id=auth.uid()::text and name like 'ingest/%'
          and not exists(select 1 from public.receipt_intake_items i where i.image_path=name)
          and not exists(select 1 from public.receipts r where r.image_path=name)
          and not exists(select 1 from public.receipt_documents d where d.storage_path=name)
          and not exists(select 1 from public.office_payment_evidence e where e.storage_path=name)
        )) with check (
        bucket_id<>'receipts' or (
          owner_id=auth.uid()::text and name like 'ingest/%'
          and not exists(select 1 from public.receipt_intake_items i where i.image_path=name)
          and not exists(select 1 from public.receipts r where r.image_path=name)
          and not exists(select 1 from public.receipt_documents d where d.storage_path=name)
          and not exists(select 1 from public.office_payment_evidence e where e.storage_path=name)
        ))
    $policy$;
  end if;
end;
$storage_policies$;

-- Office users no longer see every purchase or update transaction columns directly.  They see
-- only transactions tied to their assignment and mutate state through the report command.
drop policy if exists tx_office_r on public.txs;
create policy tx_office_r on public.txs for select to authenticated
  using (public.my_role()='office' and exists (
    select 1 from public.office_payment_assignments a
     where a.transaction_id=txs.id and a.office_id=public.my_app_id()));
drop policy if exists tx_office_u on public.txs;
revoke update on public.txs from authenticated;

commit;
