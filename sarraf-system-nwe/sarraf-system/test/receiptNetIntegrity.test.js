import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { receiptNetFrom, unsendableReceipts } from "../src/services/receiptValidation.js";
import { verifiedFishReceipts } from "./fixtures/verified-fish-receipts.js";

// Regression: Number(null) is 0 and 0 is finite, so guarding an explicit order amount with
// Number.isFinite(Number(orderAmount)) alone resolved a missing order amount to a net of 0.
// Editing the amount on any receipt without an order amount silently zeroed its value.
test("a missing order amount never collapses the net to zero", () => {
  assert.equal(receiptNetFrom({ amount: 1258.66, fee: 36.66, orderAmount: null }), 1222);
  assert.equal(receiptNetFrom({ amount: 1258.66, fee: 36.66 }), 1222);
  assert.equal(receiptNetFrom({ amount: 1258.66, fee: 36.66, orderAmount: "" }), 1222);
  assert.equal(receiptNetFrom({ amount: 1258.66, fee: 36.66, orderAmount: 0 }), 1222);
});

test("an explicit positive order amount still wins over amount minus fee", () => {
  assert.equal(receiptNetFrom({ amount: 2442, fee: 42, orderAmount: 2400 }), 2400);
});

test("every verified receipt keeps its transcribed net when recomputed", () => {
  for (const receipt of verifiedFishReceipts) {
    assert.equal(
      receiptNetFrom(receipt),
      receipt.netAmount,
      `net drifted for ${receipt.id} (${receipt.source})`
    );
  }
});

test("net is null only when there is no amount to work from", () => {
  assert.equal(receiptNetFrom({ amount: null, fee: 5 }), null);
  assert.equal(receiptNetFrom({}), null);
  assert.equal(receiptNetFrom({ amount: 100, fee: null }), 100);
});

test("a fee larger than the gross cannot produce a negative net", () => {
  assert.equal(receiptNetFrom({ amount: 100, fee: 250 }), 0);
});

// Regression: send() shipped whatever was in state. A row edited to an inconsistent net was
// ingested verbatim, and sum(net_amount) becomes the converted transaction's amount.
test("receipts whose arithmetic does not reconcile are rejected before ingestion", () => {
  const rows = [
    { id: "good", amount: 1258.66, fee: 36.66, net: 1222 },
    { id: "inflated", amount: 1000, fee: 0, net: 999999 },
    { id: "mismatch", amount: 100, fee: 3, orderAmount: 90, net: 90 },
  ];
  const blocked = unsendableReceipts(rows);
  assert.deepEqual(blocked.map((x) => x.id), ["inflated", "mismatch"]);
  assert.ok(blocked[0].issues.includes("net_amount_mismatch"));
});

test("the verified receipt set passes the pre-send gate unchanged", () => {
  const rows = verifiedFishReceipts.map((r) => ({ ...r, net: r.netAmount }));
  assert.deepEqual(unsendableReceipts(rows), []);
});

// The database is the last line of defence: the client is not the only possible writer.
test("ingestion integrity is enforced in SQL, not only in the browser", () => {
  const sql = fs.readFileSync(
    new URL("../supabase/migrations/202608110003_receipt_net_integrity.sql", import.meta.url),
    "utf8"
  );
  assert.match(sql, /alter table public\.receipt_intake_items[\s\S]*?add constraint receipt_intake_net_reconciles/);
  assert.match(sql, /abs\(net_amount - \(amount - coalesce\(fee, 0\)\)\) <= 0\.01/);
  assert.match(sql, /not valid/i);
});
