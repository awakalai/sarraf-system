-- Reconcile the legacy ledger against the double-entry journal (§12).
--
-- The system currently keeps two records of the same money. `ledger` is the original one the
-- whole interface reads from; `journal_entries`/`journal_lines` is the double-entry book added
-- in phase 1 and populated by trigger from phase 5. Both are written on every transaction.
--
-- Two records of the same money is only safe while they agree, and nothing was checking. A
-- transaction posted to the ledger but missing from the journal, or an entry stuck as a draft
-- because a currency had no rate, would sit there indefinitely: the interface would show a
-- number the books could not support, and the trial balance would quietly stop describing the
-- business.
--
-- Replacing the ledger is a rewrite of the application, not an audit fix. What is needed here
-- is the thing that was missing: an answer to "do these two agree, and if not, exactly where".
begin;

-- Transactions the journal does not account for, and why. One row per problem, never a
-- summary that hides which transaction is at fault.
create or replace view public.v_ledger_journal_gaps as
with tx as (
  select t.id, t.code, t.date, t.status, t.cur_id, t.amount, t.against_id, t.total
  from public.txs t
  where not t.deleted
),
posted as (
  select e.source_id, e.id as entry_id, e.status
  from public.journal_entries e
  where e.source_type = 'transaction'
)
select tx.id                        as transaction_id,
       tx.code,
       tx.date,
       tx.status                    as transaction_status,
       posted.entry_id,
       coalesce(posted.status::text, 'missing') as journal_status,
       case
         when posted.entry_id is null then 'no_journal_entry'
         when posted.status = 'draft' then 'entry_unvalued'
         when posted.status = 'reversed' then 'entry_reversed'
         else 'ok'
       end                          as gap
from tx
left join posted on posted.source_id = tx.id
where posted.entry_id is null or posted.status <> 'posted';

revoke all on public.v_ledger_journal_gaps from public, anon;
grant select on public.v_ledger_journal_gaps to authenticated;

-- Journal entries whose transaction no longer exists or was voided: the mirror image of the
-- gap above, and the one that would otherwise inflate the books.
create or replace view public.v_journal_orphans as
select e.id as entry_id, e.source_type, e.source_id, e.business_date, e.status
from public.journal_entries e
where e.source_type = 'transaction'
  and (e.source_id is null
       or not exists (select 1 from public.txs t where t.id = e.source_id and not t.deleted));

revoke all on public.v_journal_orphans from public, anon;
grant select on public.v_journal_orphans to authenticated;

-- The single answer an operator needs, with the detail to act on it.
--
-- `agreed` is deliberately conservative: it is true only when every live transaction has a
-- posted entry, no entry is orphaned, and the trial balance itself balances. A partial pass
-- reports false, because "mostly reconciled" is not a state a set of books can be in.
create or replace function public.sarraf_ledger_journal_reconciliation()
returns jsonb
language plpgsql security definer stable
set search_path = pg_catalog, public
as $$
declare
  v_txs bigint; v_posted bigint; v_missing bigint; v_draft bigint; v_orphans bigint;
  v_balanced boolean; v_trial jsonb; v_ledger bigint := null; v_unlinked bigint := null;
begin
  if not public.is_admin() then
    raise exception using errcode='42501', message='only an administrator may reconcile the books';
  end if;

  select count(*) into v_txs from public.txs where not deleted;
  select count(*) filter (where gap = 'no_journal_entry'),
         count(*) filter (where gap = 'entry_unvalued')
    into v_missing, v_draft
    from public.v_ledger_journal_gaps;
  select count(*) into v_orphans from public.v_journal_orphans;
  v_posted := v_txs - v_missing - v_draft;

  v_trial := public.sarraf_trial_balance_check();
  v_balanced := coalesce((v_trial->>'balanced')::boolean, false);

  -- The legacy ledger is only counted when it exists; this migration must not assume it.
  if to_regclass('public.ledger') is not null then
    execute 'select count(*) from public.ledger' into v_ledger;
    -- Ledger rows that name a transaction the journal never received. These are the rows that
    -- would show the operator money the books cannot account for.
    execute $q$
      select count(*) from public.ledger l
       where l.tx_id is not null
         and exists (select 1 from public.txs t where t.id = l.tx_id and not t.deleted)
         and not exists (select 1 from public.journal_entries e
                          where e.source_type = 'transaction' and e.source_id = l.tx_id
                            and e.status = 'posted')
    $q$ into v_unlinked;
  end if;

  return jsonb_build_object(
    'agreed', (v_missing = 0 and v_draft = 0 and v_orphans = 0 and v_balanced
               and coalesce(v_unlinked, 0) = 0),
    'transactions', v_txs,
    'posted', v_posted,
    'missing_entries', v_missing,
    'unvalued_entries', v_draft,
    'orphan_entries', v_orphans,
    'ledger_rows', v_ledger,
    'ledger_rows_without_entry', v_unlinked,
    'trial_balance', v_trial,
    'checked_at', statement_timestamp());
end;
$$;
revoke all on function public.sarraf_ledger_journal_reconciliation() from public, anon;
grant execute on function public.sarraf_ledger_journal_reconciliation() to authenticated;

commit;
