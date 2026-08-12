import test from "node:test";
import assert from "node:assert/strict";
import {
  diffVersions, reviewEquation, reviewTotals, correctExtraction, transitionDocument,
} from "../src/services/receiptWorkspace.js";

const client = (impl = {}) => ({
  inserts: [], updates: [],
  from(table) {
    const self = this;
    return {
      insert(row) { self.inserts.push({ table, row }); return Promise.resolve(impl.insert ?? { error: null }); },
      update(patch) {
        return { eq(_c, v) { self.updates.push({ table, patch, id: v }); return Promise.resolve(impl.update ?? { error: null }); } };
      },
    };
  },
});

// §3: the fixture equation, with the fee added on top of the order amount.
test("an added-on-top fee reconciles against the gross", () => {
  const eq = reviewEquation({
    grossAmount: 2520.41, orderAmount: 2447.0, feeAmount: 73.41,
    feeTreatment: "added_on_top", netAmount: 2447.0, currency: "cny",
  });
  assert.equal(eq.expectedGross, 2520.41);
  assert.equal(eq.reconciles, true);
  assert.equal(eq.currency, "CNY");
});

test("a fee included in the total does not inflate the expected gross", () => {
  const eq = reviewEquation({
    grossAmount: 2447.0, orderAmount: 2447.0, feeAmount: 73.41,
    feeTreatment: "included_in_total", netAmount: 2373.59,
  });
  assert.equal(eq.expectedGross, 2447.0);
  assert.equal(eq.reconciles, true);
});

test("a gross that does not match its own fee treatment is reported, not silently accepted", () => {
  const eq = reviewEquation({
    grossAmount: 2600, orderAmount: 2447, feeAmount: 73.41, feeTreatment: "added_on_top",
  });
  assert.equal(eq.reconciles, false);
});

test("the equation is undecidable, not false, when the receipt does not state an order amount", () => {
  const eq = reviewEquation({ grossAmount: 2520.41, feeAmount: 73.41, feeTreatment: "unknown" });
  assert.equal(eq.reconciles, null, "an unknown treatment must not masquerade as a failed check");
});

test("cent precision survives the reconciliation", () => {
  const eq = reviewEquation({
    grossAmount: 1258.66, orderAmount: 1222.0, feeAmount: 36.66, feeTreatment: "added_on_top",
  });
  assert.equal(eq.reconciles, true);
  assert.equal(eq.gross, 1258.66, "1258.66 must never be rounded to 1259");
});

test("a correction is shown field by field, not as two blocks of numbers", () => {
  const before = { grossAmount: 2520.41, currency: "IQD", refNo: "A1", payee: "X" };
  const after = { grossAmount: 2520.41, currency: "CNY", refNo: "A1", payee: "Y" };
  const diff = diffVersions(before, after);
  assert.deepEqual(diff.map((d) => d.field).sort(), ["currency", "payee"]);
  const currency = diff.find((d) => d.field === "currency");
  assert.equal(currency.before, "IQD");
  assert.equal(currency.after, "CNY");
});

test("a correction must carry a reason and an actual change", async () => {
  const c = client();
  const base = { version: 1, grossAmount: 100, currency: "CNY" };
  await assert.rejects(() => correctExtraction(c, { documentId: "d", base, changes: { grossAmount: 90 }, reason: "short" }));
  await assert.rejects(() => correctExtraction(c, { documentId: "d", base, changes: {}, reason: "a proper eight-character reason" }));
  assert.equal(c.inserts.length, 0, "nothing may be written without a reason and a change");
});

test("a correction is written as a new version, never over the original", async () => {
  const c = client();
  const base = { version: 1, grossAmount: 2520.41, currency: "CNY", feeAmount: 73.41 };
  await correctExtraction(c, {
    documentId: "doc-1", base, changes: { grossAmount: 2447.0 },
    reason: "gross misread from the image", correctedBy: "admin-1",
  });
  assert.equal(c.inserts.length, 1);
  const row = c.inserts[0].row;
  assert.equal(row.version, 2, "a correction increments the version");
  assert.equal(row.is_original, false);
  assert.equal(row.gross_amount, 2447.0);
  assert.equal(row.fee_amount, 73.41, "untouched fields carry forward from the base version");
  assert.equal(row.corrected_by, "admin-1");
  assert.ok(row.correction_reason.length >= 8);
});

test("rejecting a receipt requires a reason and records it", async () => {
  const c = client();
  await assert.rejects(() => transitionDocument(c, { documentId: "d", toState: "rejected", reason: "no" }));
  await transitionDocument(c, { documentId: "d", toState: "rejected", reason: "the image is not a payment receipt" });
  const patch = c.updates[0].patch;
  assert.equal(patch.state, "rejected");
  assert.equal(patch.rule_code, "manual_reject");
  assert.ok(patch.rule_reason.length >= 8);
});

test("moving a receipt forward needs no reason", async () => {
  const c = client();
  await transitionDocument(c, { documentId: "d", toState: "validated" });
  assert.deepEqual(c.updates[0].patch, { state: "validated" });
});

// §11.13 with §4.14: the queue footer counts documents. The money belongs to one place only,
// the server's canonical batch summary, so that two people cannot be shown two answers.
test("the queue footer counts documents and never money", () => {
  const docs = [
    { id: "a", state: "accepted", counted: true },
    { id: "b", state: "accepted", counted: true },
    { id: "c", state: "needs_manual_review" },
    { id: "d", state: "rejected" },
    { id: "e", state: "duplicate" },
  ];
  const totals = reviewTotals(docs, {
    a: { currency: "CNY", grossAmount: 1258.66, feeAmount: 36.66, netAmount: 1222 },
    b: { currency: "USD", grossAmount: 100, feeAmount: 0, netAmount: 100 },
    c: { currency: "CNY", grossAmount: 9999, feeAmount: 0, netAmount: 9999 },
  });
  assert.equal(totals.accepted, 2);
  assert.equal(totals.pending, 1);
  assert.equal(totals.rejected, 1);
  assert.equal(totals.duplicate, 1);
  assert.equal(totals.byCurrency.CNY.count, 1);
  assert.equal(totals.byCurrency.USD.count, 1);
  assert.ok(!("CNYUSD" in totals.byCurrency), "currencies are never merged");
  // No amount is totalled in the browser at all — not even one that is never displayed.
  assert.deepEqual(Object.keys(totals.byCurrency.CNY), ["count"]);
  assert.equal(JSON.stringify(totals).includes("1258.66"), false);
});

test("a receipt still under review never contributes to a total", () => {
  const totals = reviewTotals(
    [{ id: "x", state: "needs_manual_review" }],
    { x: { currency: "CNY", grossAmount: 500, netAmount: 500 } }
  );
  assert.equal(totals.accepted, 0);
  assert.deepEqual(totals.byCurrency, {});
});
