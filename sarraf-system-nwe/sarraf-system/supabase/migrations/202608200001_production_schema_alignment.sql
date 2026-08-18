-- Making the live database say what this repository says it says.
--
-- 202608090001 states the shape of the legacy tables, but it states it with `create table if
-- not exists`, so on a database that already had them it changed nothing. A fresh database —
-- the one every test runs against — gets the declared shape; the owner's database kept whatever
-- it had. The two then disagree silently, and a green suite proves only that the code agrees
-- with the declaration.
--
-- A schema read of the live database on 2026-08-17 found three disagreements, and two of them
-- had already reached the owner as errors:
--
--   audit has no user_id            → `column "user_id" of relation "audit" does not exist`
--                                      on every ratio save
--   receipts.tx_date is text        → `operator does not exist: text = date` inside
--                                      check_receipt_dupe, which is the check that decides
--                                      whether an uploaded receipt is new. With it unable to
--                                      run, every upload reaching the compound key was turned
--                                      away — receipts reported as duplicates that were nothing
--                                      of the kind.
--   receipts.tx_time is text        → the same disagreement, not yet reached by a query.
--
-- The columns are converted rather than the queries taught to tolerate either type. Tolerating
-- both would mean every future reader of a date has to remember to, forever, and the first one
-- who forgets reproduces exactly this bug. The live table holds three receipts, so the rewrite
-- is a moment's work and there is no reason to carry the ambiguity instead.
begin;

-- ── who made the change ─────────────────────────────────────────────────────
--
-- Nullable, and `on delete set null` rather than cascade: rows written before the column existed
-- have no actor to attribute, and deleting a user must never delete the record of what they did.
alter table public.audit add column if not exists user_id text;

do $$
begin
  if not exists (select 1 from information_schema.table_constraints
                 where constraint_schema = 'public' and constraint_name = 'audit_user_id_fkey') then
    alter table public.audit
      add constraint audit_user_id_fkey foreign key (user_id)
      references public.app_users(id) on delete set null;
  end if;
end $$;

create index if not exists idx_audit_user on public.audit(user_id);

-- ── the receipt's own date and time ─────────────────────────────────────────
--
-- Converted only where the column is still text, so this file is a no-op on any database that
-- already matches — including every fresh one, where 202608090001 created it as a date.
--
-- The USING clause never raises. A value that is not a date becomes null instead of aborting the
-- conversion partway through a production table, and null is the honest reading of a date nobody
-- can parse: the receipt is still evidence, and every caller already falls back to created_at.
do $$
declare v_type text;
begin
  select data_type into v_type from information_schema.columns
   where table_schema = 'public' and table_name = 'receipts' and column_name = 'tx_date';

  if v_type = 'text' then
    alter table public.receipts
      alter column tx_date type date
      using (case
               when nullif(btrim(tx_date), '') is null then null
               when btrim(tx_date) ~ '^\d{4}-\d{2}-\d{2}' then left(btrim(tx_date), 10)::date
               else null
             end);
    raise notice 'receipts.tx_date converted from text to date';
  end if;

  select data_type into v_type from information_schema.columns
   where table_schema = 'public' and table_name = 'receipts' and column_name = 'tx_time';

  if v_type = 'text' then
    alter table public.receipts
      alter column tx_time type time
      using (case
               when nullif(btrim(tx_time), '') is null then null
               when btrim(tx_time) ~ '^\d{1,2}:\d{2}' then btrim(tx_time)::time
               else null
             end);
    raise notice 'receipts.tx_time converted from text to time';
  end if;
end $$;

-- ── the disagreement must not be able to come back ──────────────────────────
--
-- The two failures above were not mistakes in any single file; they were a gap between two
-- files that nothing compared. This function closes the gap by making the comparison itself a
-- thing that can be run — against a fresh database in the test harness, and against the live one
-- from the SQL editor.
--
-- It reports rather than repairs. What to do about a drifted column depends on what is in it,
-- and a migration that silently rewrites a column it was not told about is how data is lost.
create or replace function public.sarraf_schema_drift()
returns table(table_name text, column_name text, expected text, found text)
language sql
stable
set search_path = pg_catalog, public
as $$
  with expected(t, c, ty) as (values
    ('audit', 'user_id', 'text'),
    ('receipts', 'tx_date', 'date'),
    ('receipts', 'tx_time', 'time without time zone'),
    ('receipts', 'amount', 'numeric'),
    ('receipts', 'counted', 'boolean'),
    ('receipts', 'raw', 'jsonb'),
    ('receipt_batches', 'created_at', 'timestamp with time zone'),
    ('receipt_batches', 'rejected_n', 'integer'),
    ('currencies', 'rate', 'numeric')
  )
  select e.t, e.c, e.ty, coalesce(a.data_type, '<missing>')
  from expected e
  left join information_schema.columns a
    on a.table_schema = 'public' and a.table_name = e.t and a.column_name = e.c
  where coalesce(a.data_type, '<missing>') is distinct from e.ty;
$$;

grant execute on function public.sarraf_schema_drift() to authenticated;

commit;
