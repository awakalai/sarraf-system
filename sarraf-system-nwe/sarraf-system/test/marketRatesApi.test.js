import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/market-rates.js";
import { resetMarketCache } from "../api/_market-service.js";

// Minimal stand-in for the Vercel request/response pair.
const call = async (method = "GET", query = {}) => {
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await handler({ method, query }, res);
  return res;
};

test("a method other than GET is refused with Allow: GET", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await call(method);
    assert.equal(res.statusCode, 405, `${method} should be 405`);
    assert.equal(res.headers.allow, "GET");
    assert.equal(res.body.error, "method_not_allowed");
  }
});

// Regression for §10: rejecting unknown parameters meant a cache-buster appended by a
// browser, proxy or CDN turned an ordinary read into 400 unsupported_request.
test("a cache-busting parameter does not break the read", async () => {
  for (const query of [{}, undefined, { _: "1699123456" }, { t: "1" }, { v: "2", foo: "bar" }]) {
    const res = await call("GET", query);
    assert.notEqual(res.statusCode, 400,
      `query ${JSON.stringify(query)} must not be rejected as unsupported`);
    assert.ok([200, 503].includes(res.statusCode), `unexpected status ${res.statusCode}`);
  }
});

test("the response carries a stable schema whether or not upstream answered", async () => {
  const res = await call("GET");
  assert.equal(typeof res.body, "object");
  for (const key of ["schemaVersion", "status", "instruments", "ok", "provider", "rates", "metals"]) {
    assert.ok(key in res.body, `missing ${key} from the response contract`);
  }
  assert.ok(Array.isArray(res.body.instruments));
  // ok must agree with the status rather than being independently optimistic.
  assert.equal(res.body.ok, res.body.status !== "unavailable");
});

test("an unavailable upstream is reported as 503, never as a success", async () => {
  resetMarketCache();
  const res = await call("GET");
  if (res.body.status === "unavailable") {
    assert.equal(res.statusCode, 503, "an unavailable feed must not return 200");
    assert.equal(res.body.ok, false);
  } else {
    assert.equal(res.statusCode, 200);
  }
});

test("responses are cacheable but never marked as authoritative internal rates", async () => {
  const res = await call("GET");
  assert.match(res.headers["cache-control"] || "", /s-maxage=\d+/);
  // §4: this feed is reference data and must never be mistaken for the manual daily rate.
  assert.equal(res.body.referenceOnly, true);
});
