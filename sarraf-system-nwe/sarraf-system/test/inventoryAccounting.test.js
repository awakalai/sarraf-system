import test from "node:test";
import assert from "node:assert/strict";
import { computeInventoryPosition, investorProfitShare } from "../src/services/inventoryAccounting.js";

const buy = (id, amount, buyTotal, date, extra = {}) => ({ id, type: "buy", curId: "cny", amount, buyTotal, date, ...extra });
const sell = (id, amount, date, extra = {}) => ({ id, type: "sell", curId: "cny", amount, date, ...extra });
const position = (txs, opts = {}) => computeInventoryPosition({ txs, curId: "cny", ...opts });

test("weighted average cost is the pool's cost over its quantity", () => {
  // 1,000 CNY at 0.14 USD and 1,000 at 0.16 USD => 2,000 CNY costing 300 USD => 0.15 USD each.
  const p = position([
    buy("t1", 1000, 140, "2026-08-01T10:00:00Z"),
    buy("t2", 1000, 160, "2026-08-02T10:00:00Z"),
  ]);
  assert.equal(p.qty, 2000);
  assert.equal(p.costUsd, 300);
  assert.equal(p.avgRate, 0.15);
  assert.equal(p.costComplete, true);
});

test("a sale consumes cost at the average rate and leaves the rate unchanged", () => {
  const p = position([
    buy("t1", 1000, 140, "2026-08-01T10:00:00Z"),
    buy("t2", 1000, 160, "2026-08-02T10:00:00Z"),
    sell("t3", 500, "2026-08-03T10:00:00Z"),
  ]);
  assert.equal(p.qty, 1500);
  assert.ok(Math.abs(p.costUsd - 225) < 1e-9, `cost ${p.costUsd}`);
  assert.ok(Math.abs(p.avgRate - 0.15) < 1e-12);
});

test("selling the entire position returns the pool to a clean zero", () => {
  const p = position([
    buy("t1", 1000, 140, "2026-08-01T10:00:00Z"),
    sell("t2", 1000, "2026-08-02T10:00:00Z"),
  ]);
  assert.equal(p.qty, 0);
  assert.equal(p.costUsd, 0);
  assert.equal(p.avgRate, null, "an empty pool has no average rate to quote");
});

test("transactions are consumed in date order regardless of array order", () => {
  const ordered = position([
    buy("t1", 1000, 140, "2026-08-01T10:00:00Z"),
    buy("t2", 1000, 160, "2026-08-02T10:00:00Z"),
  ]);
  const shuffled = position([
    buy("t2", 1000, 160, "2026-08-02T10:00:00Z"),
    buy("t1", 1000, 140, "2026-08-01T10:00:00Z"),
  ]);
  assert.deepEqual(shuffled, ordered);
});

test("a buy with no usable cost snapshot suppresses the average rate rather than guessing", () => {
  const p = computeInventoryPosition({
    txs: [buy("t1", 1000, null, "2026-08-01T10:00:00Z", { total: 7000, againstId: "iqd" })],
    curId: "cny",
    usdCostOf: () => null,
  });
  assert.equal(p.costComplete, false);
  assert.equal(p.avgRate, null, "profit must not be derived from an unknown cost basis");
});

test("a missing snapshot falls back to the valuation function", () => {
  const p = computeInventoryPosition({
    txs: [buy("t1", 1000, null, "2026-08-01T10:00:00Z", { total: 7000, againstId: "iqd" })],
    curId: "cny",
    usdCostOf: () => 150,
  });
  assert.equal(p.costComplete, true);
  assert.equal(p.avgRate, 0.15);
});

// Regression: the previous implementation dropped the excess with Math.min and reported a
// clean position, so an oversell became a silent profit of null with nothing to explain it.
test("selling more than is held is reported, not silently swallowed", () => {
  const p = position([
    buy("t1", 1000, 140, "2026-08-01T10:00:00Z"),
    sell("t2", 1500, "2026-08-02T10:00:00Z"),
  ]);
  assert.equal(p.qty, 0);
  assert.equal(p.oversold, 500, "the 500 CNY sold beyond the position must be visible");
  assert.equal(p.costUsd, 0);
});

test("selling from an empty position is fully counted as oversold", () => {
  const p = position([sell("t1", 250, "2026-08-02T10:00:00Z")]);
  assert.equal(p.qty, 0);
  assert.equal(p.oversold, 250);
});

test("the as-of date excludes later transactions, so history stays reproducible", () => {
  const txs = [
    buy("t1", 1000, 140, "2026-08-01T10:00:00Z"),
    buy("t2", 1000, 160, "2026-08-05T10:00:00Z"),
  ];
  const asOf = position(txs, { asOfDate: "2026-08-03T00:00:00Z" });
  assert.equal(asOf.qty, 1000);
  assert.equal(asOf.avgRate, 0.14);
});

test("voided, direct and excluded transactions never enter the pool", () => {
  const p = position([
    buy("t1", 1000, 140, "2026-08-01T10:00:00Z"),
    buy("t2", 9999, 9999, "2026-08-01T11:00:00Z", { deleted: true }),
    buy("t3", 9999, 9999, "2026-08-01T12:00:00Z", { direct: true }),
    buy("t4", 9999, 9999, "2026-08-01T13:00:00Z"),
  ], { excludeTxId: "t4" });
  assert.equal(p.qty, 1000);
  assert.equal(p.avgRate, 0.14);
});

test("investor profit is weighted by capital and the agreed rate", () => {
  // 25,000 of 100,000 capital at a 40% rate over 1,000 profit => 1000 * 0.25 * 0.40 = 100.
  assert.equal(investorProfitShare({ capital: 25000, totalCapital: 100000, rate: 40, totalProfit: 1000 }), 100);
});

test("investors carry losses on the same weighting they earn profit", () => {
  assert.equal(investorProfitShare({ capital: 25000, totalCapital: 100000, rate: 40, totalProfit: -1000 }), -100);
});

test("no capital, no pool or no profit yields no share", () => {
  assert.equal(investorProfitShare({ capital: 0, totalCapital: 100000, rate: 40, totalProfit: 1000 }), 0);
  assert.equal(investorProfitShare({ capital: 25000, totalCapital: 0, rate: 40, totalProfit: 1000 }), 0);
  assert.equal(investorProfitShare({ capital: 25000, totalCapital: 100000, rate: 40, totalProfit: 0 }), 0);
});

test("shares across a full investor pool never exceed the profit being split", () => {
  const investors = [
    { capital: 50000, rate: 50 },
    { capital: 30000, rate: 40 },
    { capital: 20000, rate: 30 },
  ];
  const totalCapital = investors.reduce((s, i) => s + i.capital, 0);
  const profit = 10000;
  const distributed = investors.reduce(
    (s, i) => s + investorProfitShare({ ...i, totalCapital, totalProfit: profit }), 0);
  assert.ok(distributed <= profit, `distributed ${distributed} exceeds profit ${profit}`);
  assert.ok(Math.abs(distributed - 4300) < 1e-9, `expected 4300, got ${distributed}`);
});
