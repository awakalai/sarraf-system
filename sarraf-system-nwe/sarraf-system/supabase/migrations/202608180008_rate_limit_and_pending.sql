-- A limit on how fast our own doors can be knocked on, and a third cashbox state (after core hardening).
--
-- Rate limiting: every provider we call has one, and we read theirs carefully. Our own routes
-- had none, so a single account could hold the OCR budget open against every other customer, and
-- an automated attempt at the admin route was limited only by how fast it could type. The
-- counter lives in the database rather than in the process, because the routes are serverless:
-- a per-process counter would reset on every cold start and count separately in every instance,
-- which is the same as not counting.
--
-- The cashbox: money handed over is not the same as money confirmed. A deposit that has been
-- reported but not yet verified sat in `available` and could be spent against a debt before
-- anyone had checked it arrived. It now lands in `pending` and moves across when confirmed.
begin;

-- ── how fast a door may be knocked on ────────────────────────────────────────

create table if not exists public.rate_limit_counters (
  bucket text not null,
  subject text not null,
  window_started_at timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, subject),
  check (hits >= 0)
);
alter table public.rate_limit_counters enable row level security;
revoke all on public.rate_limit_counters from public, anon, authenticated;

-- Counts this attempt and says whether it is allowed. One statement, so two requests arriving
-- together cannot both read the old count and both decide they are within the limit.
create or replace function public.sarraf_rate_limit(
  p_bucket text, p_subject text, p_limit int, p_window_seconds int
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_window interval := make_interval(secs => greatest(1, least(coalesce(p_window_seconds, 60), 86400)));
  v_limit int := greatest(1, coalesce(p_limit, 60));
  v_row public.rate_limit_counters%rowtype;
begin
  if nullif(btrim(coalesce(p_subject, '')), '') is null then
    raise exception using errcode = '22023', message = 'a rate limit needs a subject';
  end if;

  insert into public.rate_limit_counters(bucket, subject, window_started_at, hits)
  values (p_bucket, p_subject, statement_timestamp(), 1)
  on conflict (bucket, subject) do update
    set window_started_at = case
          when public.rate_limit_counters.window_started_at < statement_timestamp() - v_window
          then statement_timestamp()
          else public.rate_limit_counters.window_started_at end,
        hits = case
          when public.rate_limit_counters.window_started_at < statement_timestamp() - v_window
          then 1
          else public.rate_limit_counters.hits + 1 end
  returning * into v_row;

  return jsonb_build_object(
    'allowed', v_row.hits <= v_limit,
    'hits', v_row.hits,
    'limit', v_limit,
    'remaining', greatest(0, v_limit - v_row.hits),
    'retry_after_seconds',
      greatest(0, ceil(extract(epoch from (v_row.window_started_at + v_window - statement_timestamp()))))::int);
end;
$$;
revoke all on function public.sarraf_rate_limit(text,text,int,int) from public, anon, authenticated;

-- Old windows are of no interest once they have passed; kept only so a cleanup job has something
-- to call rather than growing a row per subject for ever.
create or replace function public.sarraf_rate_limit_sweep(p_older_than_hours int default 24)
returns int
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_n int;
begin
  delete from public.rate_limit_counters
   where window_started_at < statement_timestamp()
       - make_interval(hours => greatest(1, coalesce(p_older_than_hours, 24)));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.sarraf_rate_limit_sweep(int) from public, anon, authenticated;

-- ── money that has been handed over but not yet confirmed ────────────────────

alter table public.customer_vaults add column if not exists pending numeric(38,10) not null default 0;

comment on column public.customer_vaults.pending is
  'Reported but not yet confirmed. Cannot be spent, settled against a debt, or withdrawn.';

do $$ begin
  alter table public.customer_vaults add constraint customer_vaults_pending_positive check (pending >= 0);
exception when duplicate_object then null; end $$;

alter table public.customer_vault_events
  add column if not exists pending_delta numeric(38,10) not null default 0;

-- The original check said "an event must move availability or reservation". It was added
-- anonymously, so its name differs between databases; it is found by what it says rather than by
-- what it is called.
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.customer_vault_events'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%available_delta%'
      and pg_get_constraintdef(oid) not like '%pending_delta%'
  loop
    execute format('alter table public.customer_vault_events drop constraint %I', r.conname);
  end loop;
end $$;

-- An event has to move something. The original check named only the two columns that existed.
do $$ begin
  alter table public.customer_vault_events
    add constraint customer_vault_events_moves_something
    check (available_delta <> 0 or reserved_delta <> 0 or pending_delta <> 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter type public.vault_event_kind add value if not exists 'pending_deposit';
exception when others then null; end $$;
do $$ begin
  alter type public.vault_event_kind add value if not exists 'pending_confirmed';
exception when others then null; end $$;
do $$ begin
  alter type public.vault_event_kind add value if not exists 'pending_rejected';
exception when others then null; end $$;

commit;

-- The projection has to be replaced outside the transaction that added the enum values, because
-- a new enum label cannot be used in the same transaction that created it.
begin;

create or replace function public.apply_customer_vault_event()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_available numeric(38,10); v_reserved numeric(38,10); v_pending numeric(38,10);
begin
  update public.customer_vaults
     set available = available + new.available_delta,
         reserved  = reserved  + new.reserved_delta,
         pending   = pending   + new.pending_delta,
         last_event_at = statement_timestamp()
   where id = new.vault_id
  returning available, reserved, pending into v_available, v_reserved, v_pending;

  if not found then
    raise exception using errcode='23503', message=format('unknown customer vault %s', new.vault_id);
  end if;
  -- The CHECK constraints would also catch these, but the message must name the cause.
  if v_available < 0 then
    raise exception using errcode='23514',
      message=format('vault %s would be overdrawn: available would become %s', new.vault_id, v_available);
  end if;
  if v_reserved < 0 then
    raise exception using errcode='23514',
      message=format('vault %s would hold negative reserved funds (%s)', new.vault_id, v_reserved);
  end if;
  if v_pending < 0 then
    raise exception using errcode='23514',
      message=format('vault %s would hold negative pending funds (%s)', new.vault_id, v_pending);
  end if;
  return new;
end;
$$;

-- Report a deposit that nobody has verified yet. It is visible to the customer immediately —
-- they handed the money over and want to see that it registered — and spendable by nobody.
create or replace function public.sarraf_vault_pending_deposit(
  p_customer_id text, p_currency text, p_amount numeric, p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_vault public.customer_vaults%rowtype;
  v_cur text := upper(btrim(p_currency)); v_event bigint; v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role not in ('admin','office') then
    raise exception using errcode='42501', message='reporting a deposit is not authorized';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception using errcode='22023', message='amount must be greater than zero';
  end if;
  if char_length(btrim(coalesce(p_reason,''))) < 3 then
    raise exception using errcode='22023', message='a reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || coalesce(p_command_key,''), 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  select * into v_vault from public.customer_vaults
   where customer_id = p_customer_id and currency = v_cur for update;
  if not found then
    insert into public.customer_vaults(id, customer_id, currency)
    values ('cv-' || md5(p_customer_id || ':' || v_cur), p_customer_id, v_cur)
    returning * into v_vault;
  end if;

  insert into public.customer_vault_events(
    vault_id, customer_id, currency, kind, pending_delta, reason, actor_id, command_key)
  values (v_vault.id, p_customer_id, v_cur, 'pending_deposit', p_amount,
          left(btrim(p_reason), 700), v_actor.id, p_command_key)
  returning id into v_event;

  -- Nothing is posted to the journal. Unconfirmed money is not the house's money yet; posting it
  -- would put an asset and a liability on the books for a deposit that may never have happened.
  v_result := jsonb_build_object('vault_id', v_vault.id, 'currency', v_cur, 'pending', p_amount,
    'event_id', v_event, 'posted', false, 'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'vault_pending_deposit', v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_vault_pending_deposit(text,text,numeric,text,text) from public, anon;
grant execute on function public.sarraf_vault_pending_deposit(text,text,numeric,text,text) to authenticated;

-- Confirm it, or turn it away. Confirming moves the money into available and posts it; turning
-- it away removes it and posts nothing, because nothing ever arrived.
create or replace function public.sarraf_vault_pending_resolve(
  p_customer_id text, p_currency text, p_amount numeric, p_confirm boolean,
  p_rate numeric, p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_vault public.customer_vaults%rowtype;
  v_cur text := upper(btrim(p_currency)); v_entry text; v_result jsonb; v_voucher public.vouchers%rowtype;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='only an administrator may confirm a deposit';
  end if;
  if char_length(btrim(coalesce(p_reason,''))) < 3 then
    raise exception using errcode='22023', message='a reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || coalesce(p_command_key,''), 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  select * into v_vault from public.customer_vaults
   where customer_id = p_customer_id and currency = v_cur for update;
  if not found then
    raise exception using errcode='22023', message='the customer has no cashbox in this currency';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > v_vault.pending then
    raise exception using errcode='23514',
      message=format('%s %s is pending; %s cannot be resolved', v_vault.pending, v_cur, coalesce(p_amount, 0));
  end if;

  if coalesce(p_confirm, false) then
    insert into public.customer_vault_events(
      vault_id, customer_id, currency, kind, pending_delta, available_delta,
      reason, actor_id, command_key)
    values (v_vault.id, p_customer_id, v_cur, 'pending_confirmed', -p_amount, p_amount,
            left(btrim(p_reason), 700), v_actor.id, p_command_key);

    -- Now it is real: the house holds it, and owes it.
    v_entry := 'je-vault-confirm-' || md5(v_actor.id || ':' || coalesce(p_command_key,''));
    perform public.sarraf_post_simple_entry(
      v_entry, current_date, 'vault_deposit_confirmed', v_actor.id,
      'acc-1000', 'acc-2000', v_cur, p_amount,
      coalesce(p_rate, public.sarraf_required_ratio(v_cur)),
      format('پشتڕاستکردنەوەی دانانی پارە — %s %s', p_amount, v_cur),
      coalesce(p_command_key,'') || ':confirm', 'customer', p_customer_id);

    v_voucher := public.sarraf_issue_voucher(
      'vault_deposit', 'customer'::public.party_kind, p_customer_id,
      'zeman'::public.party_kind, null, v_cur, p_amount, btrim(p_reason), v_actor.id,
      null, v_entry, null, null, p_command_key);
  else
    insert into public.customer_vault_events(
      vault_id, customer_id, currency, kind, pending_delta, reason, actor_id, command_key)
    values (v_vault.id, p_customer_id, v_cur, 'pending_rejected', -p_amount,
            left(btrim(p_reason), 700), v_actor.id, p_command_key);
  end if;

  v_result := jsonb_build_object(
    'vault_id', v_vault.id, 'currency', v_cur, 'amount', p_amount,
    'confirmed', coalesce(p_confirm, false),
    'pending', (select pending from public.customer_vaults where id = v_vault.id),
    'available', (select available from public.customer_vaults where id = v_vault.id),
    'voucher', v_voucher.reference, 'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'vault_pending_resolve', v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_vault_pending_resolve(text,text,numeric,boolean,numeric,text,text) from public, anon;
grant execute on function public.sarraf_vault_pending_resolve(text,text,numeric,boolean,numeric,text,text) to authenticated;

commit;
