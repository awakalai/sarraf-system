import test from "node:test";
import assert from "node:assert/strict";
import {
  crossRate, findCurrency, fromUsd, fromUsdAsOf, rateAsOf, rateFor, rateLabel,
  rateErrorText, rateOf, unpricedCurrencies, usdFrom, usdFromAsOf, validateRate,
} from "../src/services/currencyRate.js";

const currencies = [
  { id: "usd", code: "USD", rate: 1 },
  { id: "cny", code: "CNY", rate: 7.2 },
  { id: "iqd", code: "IQD", rate: 1410 },
  { id: "xxx", code: "XXX", rate: null },
];
const round2 = (n) => Math.round(n * 100) / 100;

// ── the one rule ─────────────────────────────────────────────────────────────

// The owner's own worked example.
test("3400 yuan at 1 USD = 7.20 is 472.22 dollars", () => {
  assert.equal(round2(usdFrom(3400, "cny", currencies)), 472.22);
});

// The example the specification locks in §4.13.
test("2520.41 CNY at 7.20 is 350.06 USD, fee 10.20, net 339.86", () => {
  assert.equal(round2(usdFrom(2520.41, "cny", currencies)), 350.06);
  assert.equal(round2(usdFrom(73.41, "cny", currencies)), 10.20);
  assert.equal(round2(usdFrom(2447.00, "cny", currencies)), 339.86);
});

test("the yuan equation survives the conversion", () => {
  assert.equal(round2(2447.00 + 73.41), 2520.41);
});

test("dollars are already dollars", () => {
  assert.equal(usdFrom(500, "usd", currencies), 500);
  assert.equal(rateFor(currencies, "usd"), 1);
});

test("the reverse direction agrees with the forward one", () => {
  const usd = usdFrom(3400, "cny", currencies);
  assert.equal(round2(fromUsd(usd, "cny", currencies)), 3400);
});

// ── profit comes from the ratio moving, not from a spread ────────────────────

// The owner's decision, stated as a test.
test("buying at 7.20 and selling at 7.00 earns 13.49 on 3400 yuan", () => {
  const cost = usdFrom(3400, "cny", [{ id: "cny", rate: 7.2 }]);
  const proceeds = usdFrom(3400, "cny", [{ id: "cny", rate: 7.0 }]);
  assert.equal(round2(proceeds - cost), 13.49);
});

test("an unchanged ratio earns nothing, which is the honest answer", () => {
  const cost = usdFrom(3400, "cny", currencies);
  const proceeds = usdFrom(3400, "cny", currencies);
  assert.equal(proceeds - cost, 0);
});

// ── a missing ratio is never a number ────────────────────────────────────────

// A zero here would read as "worth nothing", which is a different and false claim.
test("a currency with no ratio values as unknown, never as zero", () => {
  assert.equal(usdFrom(1000, "xxx", currencies), null);
  assert.equal(fromUsd(1000, "xxx", currencies), null);
  assert.equal(crossRate("xxx", "cny", currencies), null);
});

test("a currency nobody has heard of is unknown too", () => {
  assert.equal(usdFrom(1000, "zzz", currencies), null);
  assert.equal(rateFor(currencies, "zzz"), null);
});

test("a non-numeric amount is unknown rather than NaN", () => {
  assert.equal(usdFrom("abc", "cny", currencies), null);
  assert.equal(usdFrom(null, "cny", currencies), null);
});

test("the unpriced currencies can be named, so the interface can say which", () => {
  assert.deepEqual(unpricedCurrencies(currencies), ["XXX"]);
});

// ── cross rates are derived, not invented ────────────────────────────────────

// The old model applied a spread on each leg and produced numbers nobody could check.
test("a cross rate is one ratio divided by the other, and checks by hand", () => {
  assert.equal(round2(crossRate("cny", "iqd", currencies)), 195.83);   // 1410 / 7.20
  assert.equal(crossRate("usd", "cny", currencies), 7.2);
  assert.equal(crossRate("cny", "usd", currencies), 1 / 7.2);
});

test("a cross rate round-trips", () => {
  const there = crossRate("cny", "iqd", currencies);
  const back = crossRate("iqd", "cny", currencies);
  assert.equal(round2(there * back), 1);
});

test("a currency against itself has no rate", () => {
  assert.equal(crossRate("cny", "cny", currencies), null);
});

// Converting through the cross rate must agree with converting through dollars.
test("converting directly matches converting through dollars", () => {
  const viaCross = 3400 * crossRate("cny", "iqd", currencies);
  const viaUsd = fromUsd(usdFrom(3400, "cny", currencies), "iqd", currencies);
  assert.equal(round2(viaCross), round2(viaUsd));
});

// ── history: the past is valued at the ratio of its day ──────────────────────

const history = [
  { curId: "cny", rate: 7.5, createdAt: "2026-01-01T00:00:00Z" },
  { curId: "cny", rate: 7.2, createdAt: "2026-06-01T00:00:00Z" },
  { curId: "cny", rate: 7.0, createdAt: "2026-08-01T00:00:00Z" },
];

test("an old trade is valued at the ratio that was in force then", () => {
  assert.equal(rateAsOf("cny", "2026-03-01", history, currencies), 7.5);
  assert.equal(rateAsOf("cny", "2026-07-01", history, currencies), 7.2);
  assert.equal(rateAsOf("cny", "2026-09-01", history, currencies), 7.0);
});

test("today's ratio does not rewrite what an old trade was worth", () => {
  assert.equal(round2(usdFromAsOf(3400, "cny", "2026-03-01", history, currencies)), 453.33);
  assert.equal(round2(usdFrom(3400, "cny", currencies)), 472.22);
});

test("a date before any record uses the oldest ratio known, not today's", () => {
  assert.equal(rateAsOf("cny", "2025-01-01", history, currencies), 7.5);
});

test("a currency with no history falls back to its current ratio", () => {
  assert.equal(rateAsOf("iqd", "2026-03-01", history, currencies), 1410);
});

test("an unreadable date does not produce a broken valuation", () => {
  assert.equal(rateAsOf("cny", "not a date", history, currencies), 7.2);
});

test("the reverse conversion also respects the date", () => {
  assert.equal(round2(fromUsdAsOf(100, "cny", "2026-03-01", history, currencies)), 750);
});

// ── reading the old pair while the migration has not been run ────────────────

// The application must behave identically before and after the column arrives, or the change
// half-lands and every figure moves for the wrong reason.
test("a currency still carrying only the old pair reads at its midpoint", () => {
  assert.equal(rateOf({ id: "cny", buyRate: 7.1, sellRate: 7.3 }), 7.2);
});

test("only one side of the old pair is still usable", () => {
  assert.equal(rateOf({ id: "cny", buyRate: 7.1, sellRate: null }), 7.1);
  assert.equal(rateOf({ id: "cny", buyRate: null, sellRate: 7.3 }), 7.3);
});

test("the single ratio wins over the old pair once it is set", () => {
  assert.equal(rateOf({ id: "cny", rate: 7.2, buyRate: 6.0, sellRate: 9.0 }), 7.2);
});

test("dollars are one whatever the row says", () => {
  assert.equal(rateOf({ id: "usd", rate: 999 }), 1);
});

// ── what an operator may type ────────────────────────────────────────────────

test("a good ratio is accepted and rounded to six places", () => {
  assert.deepEqual(validateRate("7.2"), { ok: true, rate: 7.2 });
  assert.deepEqual(validateRate(1410), { ok: true, rate: 1410 });
  assert.deepEqual(validateRate("7.1234567"), { ok: true, rate: 7.123457 });
});

test("a thousands separator is understood rather than refused", () => {
  assert.deepEqual(validateRate("1,410"), { ok: true, rate: 1410 });
});

test("an empty ratio clears it rather than failing", () => {
  assert.deepEqual(validateRate(""), { ok: true, rate: null });
});

// A zero or negative ratio would divide the whole system into nonsense.
test("zero and negative ratios are refused with a reason", () => {
  for (const bad of [0, -1, "0"]) {
    const r = validateRate(bad);
    assert.equal(r.ok, false);
    assert.notEqual(rateErrorText(r.code), r.code, "the operator must be told why");
  }
});

test("text and infinity are refused", () => {
  assert.equal(validateRate("abc").ok, false);
  assert.equal(validateRate(Infinity).ok, false);
});

test("the ratio is always stated the same way", () => {
  assert.equal(rateLabel("CNY"), "١ USD = CNY");
});

test("a currency can be found by id whatever the casing", () => {
  assert.equal(findCurrency(currencies, "CNY")?.code, "CNY");
});
