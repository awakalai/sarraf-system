-- Task B: a direct trade could never be recorded at all.
--
-- `column reference "b" is ambiguous`. sarraf_commit_transactions declares a record variable
-- named `b`, and the one statement that reads the buy side of a direct pair aliases its own
-- FROM item `b` as well:
--
--   select (b->>'total')::numeric into v_buy_total
--   from jsonb_array_elements(p_txs) b where b->>'type'='buy' and b->>'pair_id'=v_pair
--
-- PostgreSQL resolves plpgsql variables before query aliases, sees both, and refuses the
-- statement. The branch is reached only when a direct sell is being priced against its buy —
-- which is every direct trade there is — so the whole of transaction type B has been
-- unrecordable since the command was written. Nothing caught it because nothing exercised it.
--
-- The alias is renamed. Nothing else about the command changes: the pair rules, the profit
-- arithmetic, the cost basis and the ledger it writes are all exactly as 202608180002 has them.
--
-- The fix is done with a rename inside the one statement rather than by restating the whole
-- command, because a five-hundred-line function copied for a one-word change is five hundred
-- lines that can drift.
begin;

do $migrate$
declare
  v_src text;
  v_fixed text;
begin
  select pg_get_functiondef(p.oid) into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'sarraf_commit_transactions'
    and pg_get_function_identity_arguments(p.oid) = 'p_txs jsonb, p_ledger jsonb, p_batch_id text, p_command_key text, p_action text, p_detail text';

  if v_src is null then
    raise exception 'sarraf_commit_transactions(jsonb,jsonb,text,text,text,text) was not found';
  end if;

  v_fixed := replace(v_src,
    'from jsonb_array_elements(p_txs) b where b->>''type''=''buy'' and b->>''pair_id''=v_pair',
    'from jsonb_array_elements(p_txs) pair_leg where pair_leg->>''type''=''buy'' and pair_leg->>''pair_id''=v_pair');
  v_fixed := replace(v_fixed,
    'select (b->>''total'')::numeric into v_buy_total',
    'select (pair_leg->>''total'')::numeric into v_buy_total');

  if v_fixed = v_src then
    -- Already repaired, or the statement has since been rewritten. Either way there is nothing
    -- to do, and rewriting the function blindly would be worse than leaving it.
    raise notice 'sarraf_commit_transactions already reads the direct pair unambiguously';
    return;
  end if;

  execute v_fixed;
end;
$migrate$;

commit;
