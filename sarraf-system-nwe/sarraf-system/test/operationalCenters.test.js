import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadActionInbox, loadIntegrityCenter } from "../src/services/operationalControl.js";

test("operational centers call only their bounded read RPCs", async () => {
  const calls = [];
  const client = { rpc: async (name, args) => {
    calls.push([name, args]);
    return { data: { total: 200, counts: { sample: 1 }, items: Array.from({ length: 120 }, (_, index) => ({ index })) }, error: null };
  } };
  const inbox = await loadActionInbox(client, { limit: 500 });
  const integrity = await loadIntegrityCenter(client, { limit: 0 });
  assert.deepEqual(calls, [
    ["sarraf_action_inbox_v2", { p_limit: 100 }],
    ["sarraf_integrity_center_v2", { p_limit: 80 }],
  ]);
  assert.equal(inbox.items.length, 100);
  assert.equal(inbox.total, 100);
  assert.equal(integrity.items.length, 80);
});

test("receipt follow-up queues cover required finalization and finalized decision drift", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202608100008_operational_receipt_followup.sql", import.meta.url), "utf8");
  assert.equal((sql.match(/security definer/gi) || []).length, 2);
  assert.equal((sql.match(/set search_path = pg_catalog, public/gi) || []).length, 2);
  assert.match(sql, /p\.require_finalization[\s\S]*b\.receipt_stage in \('matched', 'rejected'\)/i);
  assert.match(sql, /finalized_broken_match/);
  assert.match(sql, /receipt_decision_mismatch/);
  assert.match(sql, /receipt_policy_drift/);
  assert.doesNotMatch(sql, /\b(?:insert\s+into|update\s+public\.|delete\s+from|truncate\s+)\b/i);
  assert.match(sql, /revoke all on function public\.sarraf_integrity_center_v2\(integer\) from public, anon/);
});

test("operational center errors are not converted into empty success", async () => {
  const denied = Object.assign(new Error("not authorized"), { code: "42501" });
  const client = { rpc: async () => ({ data: null, error: denied }) };
  await assert.rejects(() => loadActionInbox(client), /not authorized/);
});

test("operational center SQL is fixed-path, authenticated, bounded and read-only", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202608100005_operational_centers.sql", import.meta.url), "utf8");
  assert.equal((sql.match(/security definer/gi) || []).length, 2);
  assert.equal((sql.match(/set search_path = pg_catalog, public/gi) || []).length, 2);
  assert.equal((sql.match(/auth\.uid\(\)/g) || []).length, 2);
  assert.match(sql, /least\(greatest\(coalesce\(p_limit, 80\), 1\), 100\)/);
  assert.match(sql, /v_actor\.role <> 'admin'/);
  assert.doesNotMatch(sql, /\b(?:insert\s+into|update\s+public\.|delete\s+from|truncate\s+)\b/i);
  assert.match(sql, /revoke all on function public\.sarraf_action_inbox\(integer\) from public, anon/);
  assert.match(sql, /grant execute on function public\.sarraf_integrity_center\(integer\) to authenticated/);
});
