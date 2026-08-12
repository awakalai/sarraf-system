import test from "node:test";
import assert from "node:assert/strict";
import {
  CURRENCY_UNREAD, PAYEE_UNKNOWN, currencyOf, mayEditExtraction, payeeLabel, payeeOf,
  uploaderReceiptView, uploaderTotals,
} from "../src/services/receiptDisplay.js";

// ── the payee ────────────────────────────────────────────────────────────────

// The owner's report: "every receipt has a name in it, but it writes 'sent to unknown'".
test("a name is found wherever the payment service put it", () => {
  assert.equal(payeeOf({ receiver: "ئەحمەد" }), "ئەحمەد");
  assert.equal(payeeOf({ payee: "Ahmed" }), "Ahmed");
  assert.equal(payeeOf({ merchantName: "Taobao" }), "Taobao");
  assert.equal(payeeOf({ merchant_name: "Taobao" }), "Taobao");
  assert.equal(payeeOf({ raw: { payee: "支付宝" } }), "支付宝");
  assert.equal(payeeOf({ recipientNote: "بۆ کڕین" }), "بۆ کڕین");
});

test("the receiver wins over every other name on the receipt", () => {
  assert.equal(payeeOf({ receiver: "ئەحمەد", merchantName: "Taobao", sender: "من" }), "ئەحمەد");
});

test("the sender is the last resort, not the first", () => {
  assert.equal(payeeOf({ sender: "من", merchantName: "Taobao" }), "Taobao");
});

test("whitespace is not a name", () => {
  assert.equal(payeeOf({ receiver: "   ", merchantName: "Taobao" }), "Taobao");
});

// "Unknown" must mean the receipt genuinely did not say, not that we failed to look.
test("only a receipt with no name at all reads as unknown", () => {
  assert.equal(payeeOf({}), null);
  assert.equal(payeeLabel({}), PAYEE_UNKNOWN);
  assert.notEqual(payeeLabel({ receiver: "ئەحمەد" }), PAYEE_UNKNOWN);
});

test("the unknown wording says what is missing rather than blaming the receipt", () => {
  assert.match(PAYEE_UNKNOWN, /وەرگر/);
});

// ── the currency ─────────────────────────────────────────────────────────────

// The owner's report: "the receipt says 3400 yuan, but it says dollars — that is a bug".
test("a receipt is labelled with the currency it states and no other", () => {
  assert.equal(currencyOf({ currency: "CNY" }), "CNY");
  assert.equal(currencyOf({ currency: "cny" }), "CNY");
});

test("a receipt whose currency was not read is labelled with nothing", () => {
  for (const bad of [{}, { currency: "" }, { currency: "?" }, { currency: "12" }, { currency: null }]) {
    assert.equal(currencyOf(bad), null, `${JSON.stringify(bad)} must not produce a currency`);
  }
});

test("there is no default currency to fall back to", () => {
  const v = uploaderReceiptView({ amount: 3400 });
  assert.equal(v.currency, null);
  assert.equal(v.currencyKnown, false);
});

// ── what the uploader sees ───────────────────────────────────────────────────

// "They only need to know they sent this much yuan, with the fee and without."
test("the uploader sees the amount, the fee and the net — in the receipt's own currency", () => {
  const v = uploaderReceiptView({ amount: 2520.41, fee: 73.41, net: 2447, currency: "CNY" });
  assert.equal(v.gross, 2520.41);
  assert.equal(v.fee, 73.41);
  assert.equal(v.net, 2447);
  assert.equal(v.currency, "CNY");
});

// The whole point of the change: no valuation at upload time.
test("no valuation in any other currency is offered", () => {
  const v = uploaderReceiptView({ amount: 3400, currency: "CNY" });
  assert.equal(v.valuation, null);
  assert.equal("usd" in v, false);
  assert.equal("usdEquivalent" in v, false);
});

test("the net is derived when the receipt did not state one", () => {
  assert.equal(uploaderReceiptView({ amount: 1000, fee: 3, currency: "CNY" }).net, 997);
});

test("no fee means the net is the whole amount", () => {
  assert.equal(uploaderReceiptView({ amount: 1000, currency: "CNY" }).net, 1000);
});

test("a receipt with no amount has no net, rather than a net of zero", () => {
  const v = uploaderReceiptView({ currency: "CNY" });
  assert.equal(v.gross, null);
  assert.equal(v.net, null);
});

test("a displayed minus sign is a direction, not a negative amount", () => {
  assert.equal(uploaderReceiptView({ amount: -3400, currency: "CNY" }).gross, 3400);
});

test("the reference and date come through under either naming", () => {
  assert.equal(uploaderReceiptView({ ref_no: "R-1", tx_date: "2026-08-01" }).reference, "R-1");
  assert.equal(uploaderReceiptView({ refNo: "R-2", txDate: "2026-08-02" }).date, "2026-08-02");
});

// ── totals ───────────────────────────────────────────────────────────────────

test("totals are per currency and nothing is converted", () => {
  const t = uploaderTotals([
    { amount: 1000, fee: 3, currency: "CNY" },
    { amount: 500, fee: 1, currency: "CNY" },
    { amount: 200, currency: "USD" },
  ]);
  assert.equal(t.byCurrency.CNY.net, 1496);
  assert.equal(t.byCurrency.CNY.count, 2);
  assert.equal(t.byCurrency.USD.net, 200);
  assert.equal(Object.keys(t.byCurrency).length, 2);
});

// A receipt whose currency was not read must not be folded into one it may not belong to.
test("a receipt with no currency is counted apart, never added to another", () => {
  const t = uploaderTotals([
    { amount: 1000, currency: "CNY" },
    { amount: 999 },
  ]);
  assert.equal(t.byCurrency.CNY.net, 1000);
  assert.equal(t.unread, 1);
  assert.equal(Object.keys(t.byCurrency).length, 1);
});

test("nothing at all totals to nothing rather than failing", () => {
  assert.deepEqual(uploaderTotals([]), { byCurrency: {}, unread: 0 });
  assert.deepEqual(uploaderTotals(null), { byCurrency: {}, unread: 0 });
});

// ── who may change the figures ───────────────────────────────────────────────

// "There must not be an edit — the details of the images must not be changed. 1200 came to me,
// the image says so. How can they edit it and make it more?"
test("an uploader can never edit what the reader extracted", () => {
  assert.equal(mayEditExtraction(false), false);
  assert.equal(mayEditExtraction(undefined), false);
  assert.equal(mayEditExtraction(null), false);
  assert.equal(mayEditExtraction("yes"), false, "only an explicit staff flag counts");
});

test("staff may, through the reviewed path", () => {
  assert.equal(mayEditExtraction(true), true);
});

test("the unread-currency wording exists for the interface to use", () => {
  assert.ok(CURRENCY_UNREAD.length > 0);
});
