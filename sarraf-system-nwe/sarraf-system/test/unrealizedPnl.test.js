import test from "node:test";
import assert from "node:assert/strict";
import {
  profitSummary, unrealizedForCurrency, unrealizedPnl, unrealizedReasonText,
} from "../src/services/unrealizedPnl.js";

// 1000 CNY bought for 140 USD → a cost basis of 0.14 USD per CNY.
const bought = (over = {}) => ({
  id: "t1", type: "buy", curId: "cny", againstId: "usd", amount: 1000,
  buyTotal: 140, date: "2026-08-01T10:00:00Z", ...over,
});
const sold = (over = {}) => ({
  id: "t2", type: "sell", curId: "cny", againstId: "usd", amount: 400,
  date: "2026-08-05T10:00:00Z", ...over,
});

const rates = (map) => (id) => map[id] ?? null;

test("an empty position has nothing unrealized", () => {
  const r = unrealizedForCurrency({ txs: [], curId: "cny", marketUsdRate: rates({ cny: 0.14 }) });
  assert.equal(r.qty, 0);
  assert.equal(r.unrealizedUsd, 0);
});

test("a position worth more than it cost shows a gain", () => {
  const r = unrealizedForCurrency({ txs: [bought()], curId: "cny", marketUsdRate: rates({ cny: 0.15 }) });
  assert.equal(r.qty, 1000);
  assert.equal(r.costUsd, 140);
  assert.equal(r.marketUsd, 150);
  assert.equal(Math.round(r.unrealizedUsd * 100) / 100, 10);
});

test("a position worth less than it cost shows a loss, not zero", () => {
  const r = unrealizedForCurrency({ txs: [bought()], curId: "cny", marketUsdRate: rates({ cny: 0.13 }) });
  assert.equal(Math.round(r.unrealizedUsd * 100) / 100, -10);
});

test("selling part of a position leaves only the remainder unrealized", () => {
  const r = unrealizedForCurrency({
    txs: [bought(), sold()], curId: "cny", marketUsdRate: rates({ cny: 0.15 }),
  });
  assert.equal(r.qty, 600);
  assert.equal(Math.round(r.costUsd * 100) / 100, 84);   // 600 × 0.14
  assert.equal(Math.round(r.unrealizedUsd * 100) / 100, 6);
});

// A missing rate must read as "not known", never as "has not moved".
test("a currency with no rate is unknown, not zero", () => {
  const r = unrealizedForCurrency({ txs: [bought()], curId: "cny", marketUsdRate: rates({}) });
  assert.equal(r.unrealizedUsd, null);
  assert.equal(r.reason, "no_rate");
  assert.notEqual(unrealizedReasonText(r.reason), r.reason);
});

test("a zero or negative rate is refused rather than used", () => {
  for (const rate of [0, -1]) {
    const r = unrealizedForCurrency({ txs: [bought()], curId: "cny", marketUsdRate: () => rate });
    assert.equal(r.unrealizedUsd, null, `rate ${rate} must not be used`);
  }
});

// A pool whose cost was never fully recorded cannot be compared against anything.
test("a position with an incomplete cost basis reports why, not a number", () => {
  const r = unrealizedForCurrency({
    txs: [bought({ buyTotal: null })], curId: "cny",
    usdCostOf: () => null, marketUsdRate: rates({ cny: 0.15 }),
  });
  assert.equal(r.unrealizedUsd, null);
  assert.equal(r.reason, "cost_unknown");
  assert.equal(r.qty, 1000, "the quantity is still known and still reported");
});

test("the cost snapshot function is used when the transaction has none", () => {
  const r = unrealizedForCurrency({
    txs: [bought({ buyTotal: null })], curId: "cny",
    usdCostOf: () => 140, marketUsdRate: rates({ cny: 0.15 }),
  });
  assert.equal(Math.round(r.unrealizedUsd * 100) / 100, 10);
});

// ── across currencies ────────────────────────────────────────────────────────

const currencies = [{ id: "cny" }, { id: "iqd" }, { id: "usd" }];

test("each held currency is reported on its own", () => {
  const txs = [
    bought(),
    bought({ id: "t3", curId: "iqd", amount: 1_400_000, buyTotal: 1000 }),
  ];
  const r = unrealizedPnl({
    txs, currencies, marketUsdRate: rates({ cny: 0.15, iqd: 1 / 1400 }),
  });
  assert.equal(Object.keys(r.byCurrency).length, 2);
  assert.equal(Math.round(r.byCurrency.cny.unrealizedUsd), 10);
  assert.equal(r.complete, true);
});

test("a currency that is not held does not appear", () => {
  const r = unrealizedPnl({ txs: [bought()], currencies, marketUsdRate: rates({ cny: 0.15 }) });
  assert.equal("iqd" in r.byCurrency, false);
  assert.equal("usd" in r.byCurrency, false);
});

// A total over some positions and not others looks complete and is not.
test("one unvalued position withholds the total rather than understating it", () => {
  const txs = [
    bought(),
    bought({ id: "t3", curId: "iqd", amount: 1_400_000, buyTotal: 1000 }),
  ];
  const r = unrealizedPnl({ txs, currencies, marketUsdRate: rates({ cny: 0.15 }) });
  assert.equal(r.totalUsd, null, "a partial total must not be stated");
  assert.equal(r.complete, false);
  assert.deepEqual(r.unvalued, [{ curId: "iqd", reason: "no_rate" }]);
});

test("when everything can be valued the total is the sum of the positions", () => {
  const txs = [
    bought(),
    bought({ id: "t3", curId: "iqd", amount: 1_400_000, buyTotal: 1000 }),
  ];
  const r = unrealizedPnl({ txs, currencies, marketUsdRate: rates({ cny: 0.15, iqd: 1 / 1400 }) });
  const sum = Object.values(r.byCurrency).reduce((s, x) => s + x.unrealizedUsd, 0);
  assert.equal(Math.round(r.totalUsd * 1e6), Math.round(sum * 1e6));
});

test("no holdings at all is a complete total of zero", () => {
  const r = unrealizedPnl({ txs: [], currencies, marketUsdRate: rates({ cny: 0.15 }) });
  assert.equal(r.totalUsd, 0);
  assert.equal(r.complete, true);
});

// ── the two figures side by side ─────────────────────────────────────────────

// The whole point: a paper gain must never read as earnings.
test("realized and unrealized are reported apart, with no combined figure", () => {
  const unrealized = unrealizedPnl({ txs: [bought()], currencies, marketUsdRate: rates({ cny: 0.15 }) });
  const s = profitSummary({ realizedUsd: 500, unrealized });
  assert.equal(s.realizedUsd, 500);
  assert.equal(Math.round(s.unrealizedUsd), 10);
  assert.equal(s.combined, null, "there must be no single 'total profit' number");
});

test("an unvalued position is named in the summary rather than quietly dropped", () => {
  const txs = [bought(), bought({ id: "t3", curId: "iqd", amount: 1_400_000, buyTotal: 1000 })];
  const unrealized = unrealizedPnl({ txs, currencies, marketUsdRate: rates({ cny: 0.15 }) });
  const s = profitSummary({ realizedUsd: 500, unrealized });
  assert.equal(s.unrealizedUsd, null);
  assert.equal(s.unrealizedComplete, false);
  assert.equal(s.unvalued.length, 1);
  assert.equal(s.realizedUsd, 500, "realized profit is unaffected by an unvalued holding");
});

test("a missing realized figure is null rather than zero", () => {
  const s = profitSummary({ realizedUsd: undefined, unrealized: null });
  assert.equal(s.realizedUsd, null);
  assert.equal(s.unrealizedUsd, null);
});

// Valuing as of a past date must not reach forward into later purchases.
test("a position is valued as of a date, ignoring what was bought later", () => {
  const txs = [bought(), bought({ id: "t9", amount: 5000, buyTotal: 700, date: "2026-09-01T10:00:00Z" })];
  const r = unrealizedForCurrency({
    txs, curId: "cny", asOfDate: "2026-08-15T00:00:00Z", marketUsdRate: rates({ cny: 0.15 }),
  });
  assert.equal(r.qty, 1000, "a later purchase must not appear in an earlier valuation");
});
