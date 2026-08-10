import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMatchText, scoreReceiptCandidate } from "../src/services/receiptMatching.js";

const receipt = { tenantId: "business", orderNo: " ORD-١٢٣ ", merchantOrderNo: "M-9", currency: "CNY", netAmount: 100, date: "2026-08-10T10:00:00Z", payee: "بازاڕی کورد", customerId: "c1", partnerId: "p1" };
const tx = { tenantId: "business", code: "ord123", merchantOrderNo: "m9", currency: "CNY", amount: 100, date: "2026-08-10T11:00:00Z", counterparty: "بازاڕی كورد", customerId: "c1", partnerId: "p1" };

test("normalizes Kurdish/Arabic letters, digits, case and punctuation", () => assert.equal(normalizeMatchText(" كورد-١٢۳ "), "کورد123"));
test("exact Order No ranks more strongly than fuzzy identity signals", () => {
  const result = scoreReceiptCandidate(receipt, { ...tx, merchantOrderNo: null });
  assert.equal(result.reasons.find((x) => x.signal === "exact_order_no").weight, 55);
  assert.ok(result.score >= 90);
});
test("exact merchant order number contributes a deterministic identifier weight", () => assert.equal(scoreReceiptCandidate(receipt, tx).reasons.find((x) => x.signal === "exact_merchant_order_no").weight, 50));
test("amount/date/payee matches and their tolerances are explained", () => {
  const result = scoreReceiptCandidate({ ...receipt, orderNo: null, merchantOrderNo: null }, { ...tx, code: null, merchantOrderNo: null });
  assert.deepEqual(result.reasons.filter((x) => ["amount", "date_24h", "payee"].includes(x.signal)).map((x) => x.signal), ["amount", "date_24h", "payee"]);
  assert.equal(result.reasons.find((x) => x.signal === "amount").tolerance, 0.1);
});
test("currency mismatches stay visible and are penalized without conversion", () => {
  const result = scoreReceiptCandidate(receipt, { ...tx, currency: "USD" });
  assert.equal(result.conflicts.find((x) => x.signal === "currency_mismatch").weight, -45);
});
test("cross-tenant candidates are excluded", () => assert.equal(scoreReceiptCandidate(receipt, { ...tx, tenantId: "other" }), null));
test("amount, stale date, customer and partner conflicts are explicit penalties", () => {
  const result = scoreReceiptCandidate(receipt, { ...tx, amount: 80, date: "2026-07-01", customerId: "c2", partnerId: "p2" });
  assert.deepEqual(result.conflicts.map((x) => x.signal), ["amount_mismatch", "date_far", "customer_mismatch", "partner_mismatch"]);
});
