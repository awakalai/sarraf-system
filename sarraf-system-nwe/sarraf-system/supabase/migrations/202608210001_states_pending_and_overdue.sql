-- The states an entry can be in, a partner's unconfirmed money, and debts nobody is chasing.
--
-- Three small gaps, each of which makes something in the specification not quite true:
--
--   §13.A.8 asks for `draft → approved → posted → settled` with `reversed/voided`. The enum had
--   three of the six. An entry awaiting a second pair of eyes had nowhere to sit, and a voided
--   entry was indistinguishable from a reversed one — which matters, because reversing is a
--   correction with an opposite entry behind it and voiding is a cancellation with nothing.
--
--   §13.D.1 asks a partner's account to show `available`, `reserved`, `pending`. A customer's
--   cashbox learned the difference between money handed over and money confirmed; a partner's
--   did not, so a partner's unconfirmed balance was spendable.
--
--   §13.C.10 asks that a debt nobody is chasing be surfaced. Nothing looked. An overdue debt sat
--   in the list at the same weight as one due next month.
begin;

-- ── the states an entry can be in ────────────────────────────────────────────
--
-- Added rather than replaced: an enum with rows already using it cannot be narrowed, and there
-- is no reason to. `posted` remains what every command writes today.
do $$ begin alter type public.journal_status add value if not exists 'approved' before 'posted';
exception when others then null; end $$;
do $$ begin alter type public.journal_status add value if not exists 'settled' after 'posted';
exception when others then null; end $$;
do $$ begin alter type public.journal_status add value if not exists 'voided';
exception when others then null; end $$;

commit;

begin;

comment on column public.journal_entries.status is
  'draft → approved → posted → settled, or reversed (a correction with an opposite entry) or voided (a cancellation with none). A posted entry is never edited; §1.3.';

-- Which way an entry may move. Written down rather than left to each caller to remember: the
-- one rule that matters is that a posted entry is never edited back into a draft, because
-- something in the books already depends on it.
create or replace function public.sarraf_journal_transition_allowed(
  p_from public.journal_status, p_to public.journal_status
) returns boolean
language sql immutable
set search_path = pg_catalog
as $$
  select case p_from
    when 'draft'    then p_to in ('approved', 'posted', 'voided')
    when 'approved' then p_to in ('posted', 'draft', 'voided')
    when 'posted'   then p_to in ('settled', 'reversed')
    when 'settled'  then p_to in ('reversed')
    else false
  end;
$$;

create or replace function public.sarraf_guard_journal_status()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  if not public.sarraf_journal_transition_allowed(old.status, new.status) then
    raise exception using errcode = '23514',
      message = format('an entry cannot go from %s to %s', old.status, new.status);
  end if;
  return new;
end;
$$;
drop trigger if exists journal_status_transitions on public.journal_entries;
create trigger journal_status_transitions
  before update of status on public.journal_entries
  for each row execute function public.sarraf_guard_journal_status();

-- Settling changes no figure: it records that the money the entry describes has actually moved.
-- The immutability guard allowed only `posted → reversed`, so the state §13.A.8 asks for could
-- never be reached. Everything the guard already protects — the date, the source, the
-- transaction, the moment it was posted — stays exactly as protected as before.
create or replace function public.protect_posted_journal()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'posted' then
      raise exception using errcode='42501',
        message=format('posted journal entry %s cannot be deleted; post a reversal instead', old.id);
    end if;
    return old;
  end if;
  if old.status = 'posted' then
    if new.status is distinct from old.status
       or new.business_date is distinct from old.business_date
       or new.source_type is distinct from old.source_type
       or new.source_id is distinct from old.source_id
       or new.transaction_id is distinct from old.transaction_id
       or new.posted_at is distinct from old.posted_at then
      -- The two ways a posted entry may still move: it is reversed by an opposite entry, or it
      -- is marked settled because what it describes has been paid. Neither alters an amount.
      if not (new.status in ('reversed', 'settled')
              and new.business_date = old.business_date
              and new.source_type is not distinct from old.source_type
              and new.source_id is not distinct from old.source_id
              and new.transaction_id is not distinct from old.transaction_id
              and new.posted_at is not distinct from old.posted_at) then
        raise exception using errcode='42501',
          message=format('posted journal entry %s is immutable; post a reversal instead', old.id);
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- ── a partner's unconfirmed money ────────────────────────────────────────────

alter table public.partner_accounts add column if not exists pending numeric(38,10) not null default 0;

comment on column public.partner_accounts.pending is
  'Reported but not yet confirmed. Cannot be spent, disbursed, or settled against a debt.';

do $$ begin
  alter table public.partner_accounts add constraint partner_accounts_pending_positive check (pending >= 0);
exception when duplicate_object then null; end $$;

-- ── debts nobody is chasing ──────────────────────────────────────────────────
--
-- §13.C.10 wants reminders. A reminder needs somewhere to be sent, and this system has no
-- channel of its own — so what it gets is the part that is actually true: the list, computed
-- once, on the server, ordered by how late it is, for the operator's own inbox. Inventing an
-- SMS gateway nobody asked for would be worse than an honest list.
--
-- Reading it changes nothing, so it is safe to poll and cannot fail a balance.
create or replace function public.sarraf_overdue_debts(p_days_ahead int default 7)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_ahead int := greatest(0, least(coalesce(p_days_ahead, 7), 365));
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then raise exception using errcode = '42501', message = 'not authorized'; end if;

  return (
    with mine as (
      select d.*,
             case
               when d.due_at is null then null
               else (current_date - d.due_at::date) end as days_late
      from public.debts d
      where d.status in ('open', 'partially_settled')
        and (v_actor.role = 'admin'
             or d.debtor_id = v_actor.id or d.creditor_id = v_actor.id)
    ), listed as (
      select id, debtor_type, debtor_id, creditor_type, creditor_id, currency,
             outstanding_principal, due_at, opened_at, reason, days_late,
             case
               when days_late is null then 'no_due_date'
               when days_late > 0 then 'overdue'
               when days_late >= -v_ahead then 'due_soon'
               else 'later' end as urgency
      from mine
    )
    select jsonb_build_object(
      'overdue', coalesce((select jsonb_agg(to_jsonb(l) order by l.days_late desc)
                           from listed l where l.urgency = 'overdue'), '[]'::jsonb),
      'due_soon', coalesce((select jsonb_agg(to_jsonb(l) order by l.due_at)
                            from listed l where l.urgency = 'due_soon'), '[]'::jsonb),
      -- Counted per currency, because there is no total across two of them.
      'overdue_totals', coalesce((select jsonb_object_agg(currency, total) from (
          select currency, sum(outstanding_principal) as total
          from listed where urgency = 'overdue' group by currency) t), '{}'::jsonb),
      'overdue_count', (select count(*) from listed where urgency = 'overdue'),
      'due_soon_count', (select count(*) from listed where urgency = 'due_soon'),
      'days_ahead', v_ahead,
      'checked_at', statement_timestamp())
  );
end;
$$;
revoke all on function public.sarraf_overdue_debts(int) from public, anon;
grant execute on function public.sarraf_overdue_debts(int) to authenticated;

commit;
