import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveReceiptCurrency, usdEquivalent,
  AMBIGUOUS_YEN, NO_EVIDENCE, CONFLICTING, EXPECTED_MISMATCH,
} from "../src/services/receiptCurrency.js";
import { validateReceiptArithmetic } from "../src/services/receiptValidation.js";

// Regression for the reported defect: a CNY receipt rendered as "IQD 2,300" and "$1.63".
// The old rule was text.toUpperCase().includes(code) with IQD tested first, so the letters
// IQD anywhere in the receipt captured the whole document.
test("stray IQD letters inside other words never capture the currency", () => {
  const r = resolveReceiptCurrency("Alipay 支付宝\nLIQDATED BALANCE\n订单金额 2447.00 元", { platform: "Alipay" });
  assert.equal(r.currency, "CNY");
  assert.equal(r.confident, true);
});

test("a Chinese receipt is never resolved to IQD by locale or language", () => {
  const r = resolveReceiptCurrency("微信支付\n订单金额 ¥2447.00\n国际卡手续费 ¥73.41", { platform: "WeChat" });
  assert.equal(r.currency, "CNY");
});

test("the yen symbol alone is ambiguous between CNY and JPY and is held for review", () => {
  const r = resolveReceiptCurrency("Payment receipt\nAmount ¥2,447.00\nThank you");
  assert.equal(r.currency, null);
  assert.equal(r.reason, AMBIGUOUS_YEN);
});

test("the yen symbol resolves to CNY only with a Chinese payment platform", () => {
  const r = resolveReceiptCurrency("支付宝\nAmount ¥2,447.00", { platform: "Alipay" });
  assert.equal(r.currency, "CNY");
  assert.ok(r.evidence.includes("resolved:yen+chinese-platform"));
});

test("an explicit JPY receipt stays JPY and is not coerced to CNY", () => {
  const r = resolveReceiptCurrency("領収書\n金額 ¥2,447 円\nJPY");
  assert.equal(r.currency, "JPY");
});

test("CNY, RMB, 人民币 and 元 all resolve to CNY", () => {
  for (const t of ["Total 100 CNY", "Total 100 RMB", "订单金额 100 人民币", "订单金额 100 元"]) {
    assert.equal(resolveReceiptCurrency(t).currency, "CNY", `failed for: ${t}`);
  }
});

test("conflicting currency codes are refused rather than resolved by priority order", () => {
  const r = resolveReceiptCurrency("Charged 100 USD settled as 720 CNY");
  assert.equal(r.currency, null);
  assert.equal(r.reason, CONFLICTING);
});

test("a receipt with no currency evidence yields no currency", () => {
  const r = resolveReceiptCurrency("Transfer complete\nReference 12345\nThank you");
  assert.equal(r.currency, null);
  assert.equal(r.reason, NO_EVIDENCE);
});

test("OCR may confirm the transaction's expected currency but never override it", () => {
  const ok = resolveReceiptCurrency("订单金额 2447.00 元", { expected: "CNY" });
  assert.equal(ok.currency, "CNY");

  const bad = resolveReceiptCurrency("Total 2447.00 IQD", { expected: "CNY" });
  assert.equal(bad.currency, null);
  assert.equal(bad.reason, EXPECTED_MISMATCH, "an unexpected currency must be flagged, not accepted");
});

// Section 4: USD must come from the manually set daily rate, and must never be invented.
test("USD equivalent uses the manual daily rate with the documented convention", () => {
  const r = usdEquivalent(2447.0, { rate: 7.2, rateDate: "2026-08-11" });
  assert.equal(r.status, "ok");
  assert.equal(Number(r.usd.toFixed(2)), 339.86);
  assert.equal(r.rate, 7.2);
  assert.equal(r.rateDate, "2026-08-11");
});

test("without a rate the result is pending, never a fabricated $0 or $2", () => {
  for (const rate of [undefined, null, 0, -1, NaN, "abc"]) {
    const r = usdEquivalent(2447.0, { rate });
    assert.equal(r.status, "pending_rate", `rate ${String(rate)} must not produce a number`);
    assert.equal(r.usd, null);
  }
});

// The fixture equation quoted in the repair brief.
test("the documented fixture reconciles exactly at two decimals", () => {
  const gross = 2520.41, fee = 73.41, order = 2447.0;
  const v = validateReceiptArithmetic({ amount: gross, fee, orderAmount: order, netAmount: order });
  assert.equal(v.valid, true, `issues: ${v.issues}`);
  assert.equal(v.gross, 2520.41, "decimals must survive, never rounded to 2520");
  assert.equal(v.fee, 73.41);
  assert.equal(v.netAmount, 2447.0);

  const usd = usdEquivalent(order, { rate: 7.2 });
  assert.equal(Number(usd.usd.toFixed(2)), 339.86);
});

test("the IQD misreading that produced $1.63 cannot recur for this fixture", () => {
  const text = "支付宝 Alipay\nTransaction Details\n订单金额 2447.00 元\n国际卡手续费 73.41\nTotal 2520.41";
  const resolved = resolveReceiptCurrency(text, { platform: "Alipay", expected: "CNY" });
  assert.equal(resolved.currency, "CNY");
  assert.notEqual(resolved.currency, "IQD");
  // 2300 / 1410 (the IQD rate) is the 1.63 that was displayed; at the CNY rate it cannot arise.
  const usd = usdEquivalent(2300, { rate: 7.2 });
  assert.ok(usd.usd > 300, `expected a CNY-scale valuation, got ${usd.usd}`);
});
