import test from "node:test";
import assert from "node:assert/strict";
import { portalRouteFromHash, separatedCurrencySummary } from "../src/components/portal/portalModel.js";

test("portal deep links cannot cross roles or enter unknown routes", () => {
  const allowed = ["home", "activity", "documents", "account"];
  assert.equal(portalRouteFromHash("#/portal/customer/activity", "customer", allowed, "home"), "activity");
  assert.equal(portalRouteFromHash("#/portal/partner/activity", "customer", allowed, "home"), "home");
  assert.equal(portalRouteFromHash("#/portal/customer/admin", "customer", allowed, "home"), "home");
});

test("multi-currency summaries stay separated", () => {
  assert.deepEqual(separatedCurrencySummary({ usd: 100 }, { usd: 25 }), { currencyIds: ["usd"], currencyId: "usd", amount: 75 });
  assert.deepEqual(separatedCurrencySummary({ usd: 100, cny: 700 }, {}), { currencyIds: ["usd", "cny"], currencyId: null, amount: null });
});
