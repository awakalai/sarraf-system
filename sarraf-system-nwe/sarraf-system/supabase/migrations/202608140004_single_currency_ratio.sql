-- One ratio per currency (ordered after the canonical receipt migrations).
--
--   rate = how many units of this currency one US dollar buys
--
-- Every currency carried two numbers, a buy rate and a sell rate, and the application then
-- *derived* a cross rate between any two currencies by routing through USD and applying a
-- spread on each leg. Nobody could predict or check the result by hand, and the numbers it
-- produced were wrong often enough that the owner stopped trusting them.
--
-- The replacement is a single number per currency and one operation: divide by it.
--
--   3400 CNY at 1 USD = 7.20   →   3400 / 7.20 = 472.22 USD
--
-- Profit no longer comes from a spread invented at valuation time. It comes from the ratio
-- having moved between the day something was bought and the day it was sold, which the
-- inventory cost-basis engine already measures. A trade may still be struck at whatever rate
-- was actually agreed; that lives on the transaction. This is the house's own reference.
--
-- Nothing is dropped. buy_rate and sell_rate stay exactly as they are — they are the record of
-- what was in force before today, and §1.3 forbids destroying financial history to tidy up.
-- They simply stop being read.
begin;

alter table public.currencies add column if not exists rate numeric(20,8);

comment on column public.currencies.rate is
  'Units of this currency per 1 USD. The single valuation ratio; buy_rate/sell_rate are retained history and are no longer read.';

-- A ratio is a positive number or it is absent. Zero would divide the whole system into
-- nonsense, and a negative one is not a thing.
do $$
begin
  alter table public.currencies add constraint currencies_rate_positive check (rate is null or rate > 0) not valid;
exception when duplicate_object then null; end $$;

-- Backfill from what the pair already said. The midpoint is the honest reading of two rates
-- that were meant to straddle one value; where only one side was ever set, that side is it.
update public.currencies
   set rate = round(
         case
           when buy_rate > 0 and sell_rate > 0 then (buy_rate + sell_rate) / 2
           else coalesce(nullif(buy_rate, 0), nullif(sell_rate, 0))
         end, 8)
 where rate is null
   and (buy_rate > 0 or sell_rate > 0);

-- The dollar is the base and is always exactly one.
update public.currencies set rate = 1 where lower(id) = 'usd';

-- History records the ratio too, so a past valuation can be reproduced.
alter table public.rate_history add column if not exists rate numeric(20,8);

update public.rate_history
   set rate = round(
         case
           when buy_rate > 0 and sell_rate > 0 then (buy_rate + sell_rate) / 2
           else coalesce(nullif(buy_rate, 0), nullif(sell_rate, 0))
         end, 8)
 where rate is null
   and (buy_rate > 0 or sell_rate > 0);

-- The valuation function follows the same one rule. It previously took the midpoint of the
-- pair, which is the same answer for backfilled rows and the right answer from now on.
create or replace function public.sarraf_usd_value(p_amount numeric, p_cur_id text)
returns numeric
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare v_rate numeric;
begin
  if p_amount is null then return null; end if;
  if lower(p_cur_id) = 'usd' then return round(p_amount, 10); end if;

  select c.rate into v_rate from public.currencies c where c.id = p_cur_id;

  -- A currency whose ratio has not been set yet cannot be valued. The caller must say so
  -- rather than receive a number nobody entered.
  if v_rate is null or v_rate <= 0 then return null; end if;
  return round(p_amount / v_rate, 10);
end;
$$;

-- What an operator needs to see before trusting any USD figure: which currencies are held
-- but have no ratio, and therefore cannot be valued at all.
create or replace view public.v_unpriced_currencies as
select c.id, c.code, c.name
from public.currencies c
where lower(c.id) <> 'usd'
  and (c.rate is null or c.rate <= 0);

revoke all on public.v_unpriced_currencies from public, anon;
grant select on public.v_unpriced_currencies to authenticated;

-- Saving the ratio. The previous function took a buy rate and a sell rate; it now takes the
-- one number, records it in history, and refuses anything that is not positive — a zero would
-- divide every valuation in the system into nonsense.
--
-- Dropped first rather than replaced: the existing function carries defaults on its trailing
-- parameters, and PostgreSQL will not let CREATE OR REPLACE remove a default. The signature is
-- unchanged, and the defaults are kept below so any caller passing fewer arguments still works.
drop function if exists public.sarraf_save_rates(jsonb, jsonb, text, text, text);

create function public.sarraf_save_rates(
  p_rows jsonb, p_history jsonb, p_command_key text,
  p_action text default 'گۆڕینی ڕەیتیۆی ڕۆژ', p_detail text default ''
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; r jsonb; v_rate numeric; v_n int := 0;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='only an administrator may set the daily ratio';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode='22023', message='no ratios supplied';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || coalesce(p_command_key,''), 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_rate := nullif(r->>'rate','')::numeric;
    if v_rate is not null and v_rate <= 0 then
      raise exception using errcode='22023',
        message=format('%s: a ratio must be greater than zero', r->>'id');
    end if;
    update public.currencies
       set rate = round(v_rate, 8), rate_updated = statement_timestamp()
     where id = r->>'id';
    v_n := v_n + 1;
  end loop;

  if jsonb_typeof(p_history) = 'array' then
    for r in select * from jsonb_array_elements(p_history) loop
      insert into public.rate_history(id, cur_id, rate, changed_by)
      values (coalesce(nullif(r->>'id',''), gen_random_uuid()::text),
              r->>'cur_id', nullif(r->>'rate','')::numeric, nullif(r->>'changed_by',''))
      on conflict (id) do nothing;
    end loop;
  end if;

  insert into public.audit(id, date, user_id, action, detail)
  values (gen_random_uuid()::text, statement_timestamp(), v_actor.id,
          left(coalesce(p_action,'ratio change'), 120), left(coalesce(p_detail,''), 700));

  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'save_rates',
          jsonb_build_object('updated', v_n, 'replayed', false));

  return jsonb_build_object('updated', v_n, 'replayed', false);
end;
$$;
revoke all on function public.sarraf_save_rates(jsonb,jsonb,text,text,text) from public, anon;
grant execute on function public.sarraf_save_rates(jsonb,jsonb,text,text,text) to authenticated;

commit;
