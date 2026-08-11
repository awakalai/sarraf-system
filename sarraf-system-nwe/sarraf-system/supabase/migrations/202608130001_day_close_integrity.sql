-- Day close: a counted-cash difference must be explained, recorded, and kept (§12).
--
-- Three things were wrong with closing a day.
--
-- 1. A difference could be closed with no reason at all. The note field was optional in the
--    UI and unchecked anywhere else, so a safe that came up short by 400,000 IQD could be
--    closed with silence, and nobody could ever find out why.
--
-- 2. The difference never reached the books. The UI writes an `adjustment` row into the legacy
--    ledger so the displayed cash matches the count, but the journal knew nothing about it —
--    so the trial balance and the money in the drawer drifted apart every time a day closed
--    with a difference, and the drift had no account to show up in.
--
-- 3. A close could be edited or deleted afterwards. A close history that can be rewritten is
--    not a close history.
--
-- All three are enforced here rather than in the UI, so they hold whichever route writes the
-- close. Each trigger is installed only if the table exists, because `day_closes` predates
-- these migrations.
begin;

-- A counted difference is a real gain or loss and needs somewhere to land. One account takes
-- both directions, which is the ordinary treatment: a shortage debits it, an overage credits
-- it, and the balance over a period is what the drawer actually cost or earned.
insert into public.chart_of_accounts (id, code, name, kind, normal_side, is_control, subledger)
values ('acc-5910','5910','کەم و زیادی قاسە — Cash over and short','expense','debit', false, null)
on conflict (id) do nothing;

-- Reads the close's own lines rather than trusting a `has_diff` flag the writer supplied.
create or replace function public.day_close_has_difference(p_lines jsonb)
returns boolean
language sql immutable
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select bool_or(abs(coalesce((l->>'diff')::numeric, 0)) > 0.0000000001)
       from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) l),
    false);
$$;

-- §12: a difference needs a reason. Eight characters is the same minimum every other command
-- in the system asks for, and it is deliberately checked against the lines rather than the
-- flag, so a close cannot claim to be clean while carrying a difference.
create or replace function public.assert_day_close_explained()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_row jsonb; v_note text;
begin
  v_row := to_jsonb(new);
  if not public.day_close_has_difference(v_row->'lines') then
    return new;
  end if;
  v_note := btrim(coalesce(v_row->>'note', ''));
  if char_length(v_note) < 8 then
    raise exception using errcode='22023',
      message='بەستنی ڕۆژ بە جیاوازی پێویستی بە هۆکارە (لانیکەم ٨ پیت)';
  end if;
  return new;
end;
$$;

-- §12: immutable close history. A correction is a new close, not an edit of the old one —
-- which is what the interface already offers. Deletion is refused outright; an update is
-- refused when it would change what was counted, who counted it, or when.
create or replace function public.prevent_day_close_rewrite()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_old jsonb; v_new jsonb; k text;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode='42501', message='مێژووی بەستنی ڕۆژ ناسڕدرێتەوە';
  end if;
  v_old := to_jsonb(old); v_new := to_jsonb(new);
  foreach k in array array['close_date','lines','total_diff','has_diff','closed_by','adjust'] loop
    if v_old ? k and (v_old->k) is distinct from (v_new->k) then
      raise exception using errcode='42501',
        message='بەستنی ڕۆژی تۆمارکراو ناگۆڕدرێت — بەستنێکی نوێ بکە';
    end if;
  end loop;
  return new;
end;
$$;

-- §12 and §13: the difference goes to the journal, so the books and the drawer agree and the
-- cost of the difference is visible in an account instead of vanishing into an adjustment.
create or replace function public.post_day_close_journal()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row jsonb; v_lines jsonb; l jsonb;
  v_entry text; v_line int := 0;
  v_diff numeric; v_cur text; v_code text; v_usd numeric; v_rate numeric;
  v_draft boolean := false; v_unvalued text := null;
  v_date date;
begin
  v_row := to_jsonb(new);
  v_lines := v_row->'lines';
  if not public.day_close_has_difference(v_lines) then return null; end if;

  v_entry := 'je-close-' || new.id;
  if exists (select 1 from public.journal_entries where id = v_entry) then return null; end if;

  -- Anything that cannot be valued in USD makes the whole entry a draft, exactly as an
  -- unvalued transaction does: nothing is invented, and the reason travels with the entry.
  for l in select * from jsonb_array_elements(v_lines) loop
    v_diff := coalesce((l->>'diff')::numeric, 0);
    if abs(v_diff) <= 0.0000000001 then continue; end if;
    v_cur := l->>'cur';
    if public.sarraf_usd_value(abs(v_diff), v_cur) is null then
      v_draft := true;
      v_unvalued := coalesce(v_unvalued || '، ', '') || coalesce(l->>'code', v_cur, '?');
    end if;
  end loop;

  v_date := coalesce(nullif(v_row->>'close_date','')::date, current_date);

  insert into public.journal_entries(
    id, status, business_date, posted_at, source_type, source_id, actor_id, description)
  values (
    v_entry,
    (case when v_draft then 'draft' else 'posted' end)::public.journal_status,
    v_date,
    case when v_draft then null else statement_timestamp() end,
    'day_close', new.id, nullif(v_row->>'closed_by',''),
    left(case when v_draft
              then format('نرخی USD بۆ %s دانەنراوە — جیاوازیی بەستنی ڕۆژ هەڵنەسەنگێندراوە', v_unvalued)
              else coalesce(nullif(btrim(coalesce(v_row->>'note','')), ''), 'جیاوازیی ژماردنی کۆتایی ڕۆژ')
         end, 500));

  if v_draft then return null; end if;

  for l in select * from jsonb_array_elements(v_lines) loop
    v_diff := coalesce((l->>'diff')::numeric, 0);
    if abs(v_diff) <= 0.0000000001 then continue; end if;
    v_cur := l->>'cur';
    v_code := coalesce(l->>'code', (select code from public.currencies where id = v_cur), v_cur);
    v_usd := public.sarraf_usd_value(abs(v_diff), v_cur);
    v_rate := case when v_usd > 0 then abs(v_diff) / v_usd else 1 end;

    -- Counted more than the books said: cash rises and the gain is credited.
    -- Counted less: the shortage is an expense and cash falls.
    v_line := v_line + 1;
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,rate_source,memo)
    values (v_entry, v_line, 'acc-1000',
            (case when v_diff > 0 then 'debit' else 'credit' end)::public.entry_side,
            v_code, abs(v_diff), v_usd, v_rate, 'currency_mid',
            case when v_diff > 0 then 'زیادەی ژماردن' else 'کەمیی ژماردن' end);
    v_line := v_line + 1;
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,rate_source,memo)
    values (v_entry, v_line, 'acc-5910',
            (case when v_diff > 0 then 'credit' else 'debit' end)::public.entry_side,
            v_code, abs(v_diff), v_usd, v_rate, 'currency_mid',
            'کەم و زیادی قاسە');
  end loop;

  return null;
end;
$$;

do $$
begin
  if to_regclass('public.day_closes') is null then
    raise notice 'day_closes does not exist yet — day close integrity triggers not installed';
    return;
  end if;

  drop trigger if exists day_close_explained on public.day_closes;
  create trigger day_close_explained
    before insert or update on public.day_closes
    for each row execute function public.assert_day_close_explained();

  drop trigger if exists day_close_immutable on public.day_closes;
  create trigger day_close_immutable
    before update or delete on public.day_closes
    for each row execute function public.prevent_day_close_rewrite();

  drop trigger if exists day_close_post_journal on public.day_closes;
  create trigger day_close_post_journal
    after insert on public.day_closes
    for each row execute function public.post_day_close_journal();
end;
$$;

-- What an operator needs to see: every close that carried a difference, what it cost in USD,
-- and whether the books received it. A close whose entry is a draft is not yet in the books.
create or replace view public.v_day_close_differences as
select c.id,
       (to_jsonb(c)->>'close_date')::date              as close_date,
       to_jsonb(c)->>'note'                            as reason,
       to_jsonb(c)->>'closed_by'                       as closed_by,
       e.status                                        as journal_status,
       e.id                                            as entry_id,
       coalesce(sum(jl.base_amount) filter (where jl.account_id = 'acc-5910' and jl.side = 'debit'), 0)
         - coalesce(sum(jl.base_amount) filter (where jl.account_id = 'acc-5910' and jl.side = 'credit'), 0)
                                                       as net_short_usd
from public.day_closes c
left join public.journal_entries e on e.id = 'je-close-' || c.id
left join public.journal_lines jl on jl.entry_id = e.id
where public.day_close_has_difference(to_jsonb(c)->'lines')
group by c.id, to_jsonb(c), e.status, e.id;

commit;
