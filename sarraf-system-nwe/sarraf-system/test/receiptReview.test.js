import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { finalizeReceiptBatch, loadReceiptPolicy, reviewReceiptBatch, updateReceiptPolicy } from "../src/services/receiptReview.js";

test("receipt decisions are explicit RPC commands and never imply a transaction mutation", async () => {
  const calls = [];
  const client = { rpc: async (name, args) => { calls.push([name, args]); return { data: { ok: true }, error: null }; } };
  await reviewReceiptBatch(client, { batchId: "batch-123456789", decision: "accept", txId: "tx-1", reviewReason: "signals agree" });
  await reviewReceiptBatch(client, { batchId: "batch-123456789", decision: "reject", reviewReason: "receipt is unrelated" });
  assert.deepEqual(calls.map(([name]) => name), ["sarraf_review_receipt_batch", "sarraf_review_receipt_batch"]);
  assert.equal(calls[0][1].p_decision, "accept");
  assert.equal(calls[1][1].p_decision, "reject");
  assert.equal(calls[1][1].p_tx_id, null);
});

test("short rejection, correction, finalization and policy reasons fail before RPC", async () => {
  const client = { rpc: async () => { throw new Error("must not call"); } };
  await assert.rejects(() => reviewReceiptBatch(client, { batchId: "b", decision: "reject", reviewReason: "short" }), /8-character/);
  await assert.rejects(() => reviewReceiptBatch(client, { batchId: "b", decision: "correction", reviewReason: "short" }), /8-character/);
  await assert.rejects(() => finalizeReceiptBatch(client, { batchId: "b", finalizationReason: "short" }), /8-character/);
  await assert.rejects(() => updateReceiptPolicy(client, { policy: {}, updateReason: "too short" }), /12-character/);
});

// §4.15: finalization is an action taken against a particular set of figures, and must say
// which. A finalization that names no version could be finalizing numbers nobody looked at.
test("finalization must quote the summary version it was decided against", async () => {
  const client = { rpc: async () => { throw new Error("must not call"); } };
  await assert.rejects(
    () => finalizeReceiptBatch(client, { batchId: "b", finalizationReason: "the figures were checked" }),
    /summary version/);
});

test("the quoted version travels with the command", async () => {
  const calls = [];
  const client = { rpc: async (name, args) => { calls.push([name, args]); return { data: { finalized: true }, error: null }; } };
  await finalizeReceiptBatch(client, {
    batchId: "batch-123456789", finalizationReason: "the figures were checked", summaryVersion: "v-aaa",
  });
  assert.equal(calls[0][0], "sarraf_finalize_receipt_batch");
  assert.equal(calls[0][1].p_summary_version, "v-aaa");
});

test("receipt policy parsing preserves explicit false controls", async () => {
  const client = { rpc: async () => ({ data: { min_match_score: 82, require_reason_below: 94, allow_reject: false, allow_correction: false, require_finalization: true, require_separate_finalizer: true, version: 3 }, error: null }) };
  const policy = await loadReceiptPolicy(client);
  assert.equal(policy.min_match_score, 82);
  assert.equal(policy.allow_reject, false);
  assert.equal(policy.allow_correction, false);
  assert.equal(policy.version, 3);
});

test("receipt review SQL protects accounting and enforces policy before finalization", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202608100006_receipt_review_policy.sql", import.meta.url), "utf8");
  assert.match(sql, /security definer[\s\S]*set search_path = pg_catalog, public/i);
  assert.match(sql, /v_candidate\.score < v_policy\.min_match_score/);
  assert.match(sql, /require_separate_finalizer and v_batch\.decision_by = v_actor\.id/);
  assert.match(sql, /only the system owner may change receipt policy/);
  assert.doesNotMatch(sql, /\b(?:update|insert into|delete from)\s+public\.(?:txs|ledger|account_ledger)\b/i);
  assert.match(sql, /revoke all on function public\.sarraf_finalize_receipt_batch/);
});
