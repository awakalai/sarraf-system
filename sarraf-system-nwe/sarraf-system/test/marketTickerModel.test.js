import test from "node:test";
import assert from "node:assert/strict";
import { buildMarketTickerRows, tickerHealth } from "../src/components/market/marketTickerModel.js";

test("builds the fixed colorful ticker order without fabricating unavailable rates", () => {
  const rows = buildMarketTickerRows(
    [{ code: "IQD", buyRate: 1495, sellRate: 1505, rateUpdated: "2026-08-10T09:00:00Z" }],
    { instruments: [{ id: "USD/CNY", value: 7.21, freshness: "live", source: "provider" }] },
    true,
  );
  assert.deepEqual(rows.map((row) => row.id), ["USD/IQD", "USD/CNY", "EUR/USD", "GBP/USD", "XAU/USD"]);
  assert.equal(rows[0].symbol, "$/ع.د");
  assert.equal(rows[0].buyRate, 1495);
  assert.equal(rows[1].value, 7.21);
  assert.equal(rows[2].value, null);
  assert.equal(rows[2].availability, "unavailable");
});

test("ticker health turns red for offline or fully unavailable data", () => {
  assert.equal(tickerHealth([], false), "offline");
  assert.equal(tickerHealth([{ availability: "unavailable", freshness: "unavailable" }], true), "unavailable");
  assert.equal(tickerHealth([{ availability: "available", freshness: "live" }], true), "live");
  assert.equal(tickerHealth([{ availability: "available", freshness: "stale" }], true), "stale");
});
