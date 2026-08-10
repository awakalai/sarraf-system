import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { auditTimeline, buildSafeCsv, loadAuditExportSnapshot } from "../src/services/auditExport.js";

test("audit snapshot loader validates dates and bounds the server row limit", async () => {
  const calls = [];
  const client = { rpc: async (name, args) => {
    calls.push([name, args]);
    return { data: { datasets: { transactions: [{ id: "tx-1" }] }, counts: { transactions: 1 } }, error: null };
  } };
  const snapshot = await loadAuditExportSnapshot(client, { from: "2026-08-01", to: "2026-08-10", limit: 9000 });
  assert.deepEqual(calls, [["sarraf_export_audit_snapshot", { p_from: "2026-08-01", p_to: "2026-08-10", p_limit: 2500 }]]);
  assert.equal(snapshot.datasets.transactions.length, 1);
  await assert.rejects(() => loadAuditExportSnapshot(client, { from: "bad", to: "2026-08-10" }), /valid export dates/);
});

test("CSV export prevents spreadsheet formulas while preserving numeric values", () => {
  const csv = buildSafeCsv([{ amount: -25, note: "=HYPERLINK(\"https://example.test\")", nested: { safe: true } }]);
  assert.match(csv, /^\uFEFF/);
  assert.match(csv, /"-25"/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.test""\)"/);
  assert.match(csv, /"\{""safe"":true\}"/);
});

test("unified audit timeline sorts heterogeneous events newest first", () => {
  const rows = auditTimeline({ datasets: {
    audit: [{ id: "old", date: "2026-08-01T00:00:00Z", action: "old" }],
    receipt_audit: [{ id: "new", created_at: "2026-08-02T00:00:00Z", event_type: "matched" }],
  } });
  assert.deepEqual(rows.map((row) => row.id), ["new", "old"]);
});

test("export RPC is authenticated, bounded and strictly read-only", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202608100007_export_audit_center.sql", import.meta.url), "utf8");
  assert.match(sql, /security definer[\s\S]*stable[\s\S]*set search_path = pg_catalog, public/i);
  assert.match(sql, /v_actor\.role <> 'admin'/);
  assert.match(sql, /least\(greatest\(coalesce\(p_limit, 1000\), 1\), 2500\)/);
  assert.match(sql, /v_to - v_from > 365/);
  assert.doesNotMatch(sql, /\b(?:insert\s+into|update\s+public\.|delete\s+from|truncate\s+)\b/i);
  assert.match(sql, /revoke all on function public\.sarraf_export_audit_snapshot\(date,date,integer\) from public, anon/);
});
