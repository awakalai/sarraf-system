import test from "node:test";
import assert from "node:assert/strict";
import {
  RECEIPT_REVIEW_STATES, diffVersions, reviewEquation, reviewTotals, correctExtraction,
  finalizeReceipt, loadReceiptSummary, setReceiptDailyRate, transitionDocument,
} from "../src/services/receiptWorkspace.js";

const client = (impl = {}) => ({
  calls: [],
  rpc(fn, args) {
    this.calls.push({ fn, args });
    return Promise.resolve(impl.rpc ?? {
      data: { document_id: args.p_document_id, action: args.p_action, state: args.p_action === "accept" ? "accepted" : "needs_manual_review", version: 2 },
      error: null,
    });
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
  assert.equal(c.calls.length, 0, "nothing may be written without a reason and a change");
});

test("a correction is delegated to the audited versioning command", async () => {
  const c = client();
  const base = { version: 1, grossAmount: 2520.41, currency: "CNY", feeAmount: 73.41 };
  await correctExtraction(c, {
    documentId: "doc-1", base, changes: { grossAmount: 2447.0 },
    reason: "gross misread from the image",
  });
  assert.equal(c.calls.length, 1);
  const call = c.calls[0];
  assert.equal(call.fn, "sarraf_receipt_review_command");
  assert.equal(call.args.p_action, "correct");
  assert.deepEqual(call.args.p_changes, { grossAmount: 2447.0 });
  assert.ok(call.args.p_command_key.startsWith("receipt-review:correct:doc-1:"));
  assert.equal("corrected_by" in call.args, false, "the server derives the reviewer identity");
});

test("rejecting a receipt requires a reason and records it", async () => {
  const c = client();
  await assert.rejects(() => transitionDocument(c, { documentId: "d", toState: "rejected", reason: "no" }));
  await transitionDocument(c, { documentId: "d", toState: "rejected", reason: "the image is not a payment receipt" });
  const call = c.calls[0];
  assert.equal(call.fn, "sarraf_receipt_review_command");
  assert.equal(call.args.p_action, "reject");
  assert.ok(call.args.p_reason.length >= 8);
});

test("accepting a receipt requires an auditable reason", async () => {
  const c = client();
  await assert.rejects(() => transitionDocument(c, { documentId: "d", toState: "accepted" }));
  await transitionDocument(c, { documentId: "d", toState: "accepted", reason: "verified against the stored original" });
  assert.equal(c.calls[0].args.p_action, "accept");
  assert.deepEqual(c.calls[0].args.p_changes, {});
});

test("accepted receipts remain in the admin queue until their rate is finalized", () => {
  assert.ok(RECEIPT_REVIEW_STATES.includes("accepted"));
  assert.ok(!RECEIPT_REVIEW_STATES.includes("finalized"));
});

test("daily rates use the immutable 1 USD equals X currency convention", async () => {
  const c = client({ rpc: { data: { convention: "1_USD_EQUALS_X_CURRENCY", rate_value: 7.2 }, error: null } });
  const result = await setReceiptDailyRate(c, {
    currency: "cny", effectiveDate: "2026-08-12", rate: "7.20",
    reason: "verified manual business-day rate",
  });
  assert.equal(result.convention, "1_USD_EQUALS_X_CURRENCY");
  assert.equal(c.calls[0].fn, "sarraf_set_receipt_daily_rate");
  assert.deepEqual(
    [c.calls[0].args.p_currency, c.calls[0].args.p_effective_date, c.calls[0].args.p_rate],
    ["CNY", "2026-08-12", 7.2],
  );
  assert.ok(c.calls[0].args.p_command_key.startsWith("receipt-rate:CNY:2026-08-12:"));
  const invalid = client();
  await assert.rejects(() => setReceiptDailyRate(invalid, {
    currency: "CNY", effectiveDate: "2026-08-12", rate: 0, reason: "verified manual rate",
  }));
  assert.equal(invalid.calls.length, 0);
});

test("finalization is an audited command and USD figures come back from the server summary", async () => {
  const c = client({ rpc: { data: { state: "finalized", valuation_status: "valued" }, error: null } });
  await finalizeReceipt(c, { documentId: "doc-1", reason: "freeze the verified daily rate" });
  assert.equal(c.calls[0].fn, "sarraf_receipt_finalize_command");
  assert.deepEqual(Object.keys(c.calls[0].args).sort(), ["p_command_key", "p_document_id", "p_reason"]);
  assert.ok(c.calls[0].args.p_command_key.startsWith("receipt-finalize:doc-1:"));

  const summaryClient = client({
    rpc: {
      data: {
        document_id: "doc-1", currency: "CNY", state: "finalized", counted: true,
        business_date: "2026-08-12", rate_value: "7.20", rate_convention: "1_USD_EQUALS_X_CURRENCY",
        rate_date: "2026-08-12", rate_version: "4", gross_usd: "350.06",
        fee_usd: "10.20", net_usd: "339.86", valuation_status: "valued",
      },
      error: null,
    },
  });
  const summary = await loadReceiptSummary(summaryClient, "doc-1");
  assert.equal(summaryClient.calls[0].fn, "sarraf_receipt_summary");
  assert.deepEqual(
    [summary.rateValue, summary.rateVersion, summary.grossUsd, summary.feeUsd, summary.netUsd],
    [7.2, 4, 350.06, 10.2, 339.86],
  );
  assert.equal(summary.rateConvention, "1_USD_EQUALS_X_CURRENCY");
});

test("review writes never target receipt tables directly", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../src/services/receiptWorkspace.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\("receipt_documents"\)\.update/);
  assert.doesNotMatch(source, /from\("receipt_extractions"\)\.insert/);
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
