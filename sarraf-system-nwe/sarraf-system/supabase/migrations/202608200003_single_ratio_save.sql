-- Saving a ratio must write the ratio.
--
-- The interface has sent one number per currency since Phase 2 — `1 USD = X`, in `rate`. The
-- command in 202608180002 reads only buy_rate and sell_rate from the payload, writes only those
-- two columns, and never touches `rate` at all.
--
-- So the screen the owner uses does two wrong things at once. The ratio every valuation in the
-- system reads is left at yesterday's number, and buy_rate and sell_rate — which the payload
-- does not carry — are set to null, discarding the spread that was there. The save reports
-- success either way, which is the worst part: nothing on the screen says the number did not
-- take.
--
-- Restored below with the payload read the way the interface writes it. Both spellings are
-- accepted, because `rate` is what the application sends and buy_rate/sell_rate is what an older
-- caller or a hand-written command might still send, and a currency command should not fail on
-- the shape of its own history.
--
-- Everything else about the command — the admin check, the write gate, the advisory lock, the
-- replay, the audit line, the command store — is exactly as 202608180002 has it.
begin;

create or replace function public.sarraf_save_rates(
  p_rows jsonb, p_history jsonb, p_command_key text,
  p_action text default 'گۆڕینی ڕەیتیۆی ڕۆژ', p_detail text default ''
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_replay jsonb; v_result jsonb; x jsonb;
  v_id text; v_rate numeric; v_buy numeric; v_sell numeric; v_n int := 0;
begin
  v_actor := public.sarraf_require_admin(false);
  perform public.sarraf_assert_writes_open('save_rates');
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text || ':' || p_command_key, 0));
  v_replay := public.sarraf_command_replay(v_actor.auth_id, p_command_key, 'save_rates');
  if v_replay is not null then return v_replay; end if;

  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 100 then
    raise exception using errcode = '22023', message = 'invalid rates payload';
  end if;

  for x in select value from jsonb_array_elements(p_rows) loop
    v_id   := nullif(btrim(x->>'id'), '');
    v_rate := nullif(btrim(coalesce(x->>'rate', '')), '')::numeric;
    v_buy  := nullif(btrim(coalesce(x->>'buy_rate', '')), '')::numeric;
    v_sell := nullif(btrim(coalesce(x->>'sell_rate', '')), '')::numeric;

    -- An older payload that carries only a spread still means one ratio: the midpoint is the
    -- single number the rest of the system reads, and refusing such a payload outright would
    -- strand any caller that has not been updated.
    if v_rate is null and v_buy is not null and v_sell is not null then
      v_rate := (v_buy + v_sell) / 2;
    elsif v_rate is null then
      v_rate := coalesce(v_buy, v_sell);
    end if;

    if not exists (select 1 from public.currencies where id = v_id) then
      raise exception using errcode = '22023', message = 'invalid currency rate';
    end if;
    -- Zero and negative are refused here rather than dividing the whole system by them later.
    if v_rate is null or v_rate <= 0
       or (v_buy is not null and v_buy <= 0) or (v_sell is not null and v_sell <= 0) then
      raise exception using errcode = '22023', message = 'invalid currency rate';
    end if;

    -- `rate` is the ratio everything reads. buy_rate and sell_rate are kept only where the
    -- payload supplied them: a save that says nothing about the spread must not erase it.
    update public.currencies
       set rate = v_rate,
           buy_rate = coalesce(v_buy, buy_rate),
           sell_rate = coalesce(v_sell, sell_rate),
           rate_updated = statement_timestamp()
     where id = v_id;

    insert into public.rate_history(id, cur_id, rate, buy_rate, sell_rate, changed_by, command_key)
    values ('rate-' || md5(v_id || ':' || p_command_key), v_id, v_rate, v_buy, v_sell,
            v_actor.id, p_command_key)
    on conflict (id) do nothing;
    v_n := v_n + 1;
  end loop;

  -- The rows the interface hands over as history, kept for the ids it generated. Ignored where
  -- a row names no currency, because a history line that cannot say what it is about is noise.
  if jsonb_typeof(p_history) = 'array' then
    for x in select value from jsonb_array_elements(p_history) loop
      if nullif(btrim(coalesce(x->>'cur_id', '')), '') is not null then
        insert into public.rate_history(id, cur_id, rate, changed_by, command_key)
        values (coalesce(nullif(btrim(x->>'id'), ''), gen_random_uuid()::text),
                x->>'cur_id',
                nullif(btrim(coalesce(x->>'rate', '')), '')::numeric,
                nullif(btrim(coalesce(x->>'changed_by', '')), ''),
                p_command_key)
        on conflict (id) do nothing;
      end if;
    end loop;
  end if;

  perform public.sarraf_write_audit(v_actor.id, p_action, p_detail);
  v_result := jsonb_build_object('ok', true, 'updated', v_n);
  return public.sarraf_store_command(v_actor.auth_id, p_command_key, 'save_rates', v_result);
end;
$$;

revoke all on function public.sarraf_save_rates(jsonb,jsonb,text,text,text) from public, anon;
grant execute on function public.sarraf_save_rates(jsonb,jsonb,text,text,text) to authenticated;

commit;
