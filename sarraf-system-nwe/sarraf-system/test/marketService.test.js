import test from "node:test";
import assert from "node:assert/strict";
import { getMarketSnapshot, normalizeProvider, resetMarketCache } from "../api/_market-service.js";

const jsonResponse = (body) => ({ ok:true, text:async () => JSON.stringify(body) });

test("normalizes only the supported global instruments with explicit units", () => {
  const rows = normalizeProvider({ rates:{ CNY:7.2, EUR:.8, GBP:.5 }, gold:2400, observedAt:"2026-08-10T00:00:00Z" }, "2026-08-10T01:00:00Z");
  assert.deepEqual(rows.map(r => r.id), ["USD/CNY","EUR/USD","GBP/USD","XAU/USD"]);
  assert.equal(rows[1].value, 1.25);
  assert.equal(rows[3].unit, "USD per troy ounce");
  assert.ok(rows.every(r => r.classification === "global" && r.freshness === "live"));
});

test("rejects malformed, zero, negative and non-finite values without fabrication", () => {
  const rows = normalizeProvider({ rates:{ CNY:0, EUR:-1, GBP:Infinity }, gold:"bad", observedAt:"bad" });
  assert.ok(rows.every(r => r.value === null && r.availability === "unavailable"));
  assert.ok(rows.every(r => r.previousValue === null && r.history.length === 0));
});

test("deduplicates concurrent refreshes and serves bounded cache hits", async () => {
  resetMarketCache(); let calls = 0;
  const fetchImpl = async () => { calls++; await new Promise(r => setTimeout(r,5)); return jsonResponse([{quote:"CNY",rate:7.2,date:"2026-08-10"},{quote:"EUR",rate:.8,date:"2026-08-10"},{quote:"GBP",rate:.7,date:"2026-08-10"}]); };
  const [a,b] = await Promise.all([getMarketSnapshot({fetchImpl,env:{},now:Date.parse("2026-08-10T01:00:00Z")}), getMarketSnapshot({fetchImpl,env:{},now:Date.parse("2026-08-10T01:00:00Z")})]);
  assert.equal(calls,1); assert.equal(a.retrievedAt,b.retrievedAt);
  const cached = await getMarketSnapshot({fetchImpl,env:{},now:Date.parse("2026-08-10T01:01:00Z")});
  assert.equal(calls,1); assert.ok(cached.instruments.every(i => i.cache === "hit"));
});

test("returns partial data when optional gold provider is not configured", async () => {
  resetMarketCache();
  const result = await getMarketSnapshot({fetchImpl:async()=>jsonResponse([{quote:"CNY",rate:7,date:"2026-08-10"},{quote:"EUR",rate:.9,date:"2026-08-10"},{quote:"GBP",rate:.8,date:"2026-08-10"}]),env:{},now:Date.parse("2026-08-10T01:00:00Z")});
  assert.equal(result.status,"partial");
  assert.equal(result.instruments.find(i=>i.id==="XAU/USD").availability,"unavailable");
});
