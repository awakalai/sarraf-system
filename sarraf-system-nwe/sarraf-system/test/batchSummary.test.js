import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CALCULATION, STALE_SUMMARY, currencyRows, hasMoved, isEmpty, isPendingRate, isStale,
  loadBatchSummary, moneyOf, versionOf,
} from "../src/services/batchSummary.js";

// §4.13, the locked example, as the database returns it.
const locked = {
  batch_id: "b-1",
  summary_version: "v-aaa",
  receipt_set_version: "rs-aaa",
  rate_version: "rv-aaa",
  calculation_status: "ok",
  currencies: [{
    currency_code: "CNY",
    count: 2,
    equation_holds: true,
    native: {
      gross_total: { amount_decimal: "2520.41", currency_code: "CNY" },
      fee_total: { amount_decimal: "73.41", currency_code: "CNY" },
      net_total: { amount_decimal: "2447.00", currency_code: "CNY" },
      order_total: { amount_decimal: "2447.00", currency_code: "CNY" },
    },
    usd: {
      status: "ok",
      gross_total: {
        amount_decimal: "350.06", currency_code: "USD", unrounded: "350.0569444444444444",
        source_amount: { amount_decimal: "2520.41", currency_code: "CNY" },
      },
      fee_total: { amount_decimal: "10.20", currency_code: "USD", source_amount: { amount_decimal: "73.41", currency_code: "CNY" } },
      net_total: { amount_decimal: "339.86", currency_code: "USD", source_amount: { amount_decimal: "2447.00", currency_code: "CNY" } },
      order_total: { amount_decimal: "339.86", currency_code: "USD", source_amount: { amount_decimal: "2447.00", currency_code: "CNY" } },
    },
    rate: {
      status: "ok", rate_id: "cny", rate_value: "7.20000000",
      rate_convention: "1 USD = 7.2 CNY", inverse_value: "0.1388888889", rate_version: "rv-aaa",
    },
  }],
};

// ── nothing is calculated here ───────────────────────────────────────────────

// The requirement this file exists to keep: "the client only renders; no role and no component
// has a formula or a rate inversion of its own."
test("the reader contains no arithmetic on money at all", () => {
  const src = readFileSync(new URL("../src/services/batchSummary.js", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of [/\/\s*rate/i, /rate\s*[*/]/i, /\*\s*[a-z_]*amount/i, /amount[a-z_]*\s*[*/]/i]) {
    assert.equal(forbidden.test(code), false, `the reader performs arithmetic: ${forbidden}`);
  }
});

// A decimal string is the record. Turning it into a float and back would quietly change it.
test("a money figure reaches the screen exactly as the server stated it", () => {
  const m = moneyOf({ amount_decimal: "2447.00", currency_code: "CNY" });
  assert.equal(m.text, "2447.00", "the trailing zero is part of what the server said");
  assert.equal(m.currency, "CNY");
});

test("precision the browser cannot hold is still carried through", () => {
  const m = moneyOf({ amount_decimal: "350.05694444444444444444", currency_code: "USD" });
  assert.equal(m.text, "350.05694444444444444444");
});

test("a missing figure is nothing, not a zero", () => {
  assert.equal(moneyOf(null), null);
  assert.equal(moneyOf({}), null);
  assert.equal(moneyOf({ currency_code: "USD" }), null);
});

// ── what the screen is given ─────────────────────────────────────────────────

test("the locked example arrives intact", () => {
  const [cny] = currencyRows(locked);
  assert.equal(cny.native.gross.text, "2520.41");
  assert.equal(cny.native.fee.text, "73.41");
  assert.equal(cny.native.net.text, "2447.00");
  assert.equal(cny.usd.gross.text, "350.06");
  assert.equal(cny.usd.fee.text, "10.20");
  assert.equal(cny.usd.net.text, "339.86");
});

test("every dollar figure says which amount and which ratio produced it", () => {
  const [cny] = currencyRows(locked);
  assert.equal(cny.usd.gross.source.text, "2520.41");
  assert.equal(cny.usd.gross.source.currency, "CNY");
  assert.equal(cny.rate.convention, "1 USD = 7.2 CNY");
  assert.equal(cny.rate.value, "7.20000000");
});

// §4.10: the inverse exists only as something the server derived, never as a second rate.
test("the inverse ratio is carried, not computed", () => {
  assert.equal(currencyRows(locked)[0].rate.inverse, "0.1388888889");
  assert.equal(currencyRows({ ...locked, currencies: [{ ...locked.currencies[0], rate: { status: "ok" } }] })[0].rate.inverse, null);
});

// §4.18: a missing rate shows the native breakdown in full and no dollar figure whatsoever.
test("without a ratio there is no dollar figure, only a reason", () => {
  const [row] = currencyRows({
    calculation_status: "pending_rate",
    currencies: [{
      currency_code: "XXX", count: 1,
      native: { gross_total: { amount_decimal: "500", currency_code: "XXX" } },
      usd: { status: "pending_rate", reason: "no ratio has been set for this currency today" },
      rate: { status: "pending_rate" },
    }],
  });
  assert.equal(row.usd, null, "a dollar figure must not be invented");
  assert.equal(row.native.gross.text, "500", "the native breakdown is still shown in full");
  assert.match(row.usdPendingReason, /ratio/);
  assert.equal(row.rate, null);
});

test("currencies are listed apart and never merged", () => {
  const rows = currencyRows({
    currencies: [
      { currency_code: "CNY", native: { net_total: { amount_decimal: "2447.00", currency_code: "CNY" } } },
      { currency_code: "USD", native: { net_total: { amount_decimal: "200.00", currency_code: "USD" } } },
    ],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.currency), ["CNY", "USD"]);
});

test("a summary with nothing in it produces no rows rather than failing", () => {
  assert.deepEqual(currencyRows(null), []);
  assert.deepEqual(currencyRows({}), []);
  assert.equal(isEmpty({ calculation_status: CALCULATION.EMPTY }), true);
  assert.equal(isPendingRate({ calculation_status: CALCULATION.PENDING_RATE }), true);
});

// §4.13: gross must equal net plus fee, or no valuation of the batch means anything.
test("receipts that disagree with themselves are flagged", () => {
  assert.equal(currencyRows(locked)[0].equationHolds, true);
  assert.equal(currencyRows({ currencies: [{ currency_code: "CNY", equation_holds: false }] })[0].equationHolds, false);
});

// ── the version both sides quote ─────────────────────────────────────────────

test("the version is carried so it can be quoted back", () => {
  assert.equal(versionOf(locked), "v-aaa");
  assert.equal(versionOf(null), null);
});

test("a screen knows when the batch has moved beneath it", () => {
  assert.equal(hasMoved(locked, { ...locked, summary_version: "v-bbb" }), true);
  assert.equal(hasMoved(locked, locked), false);
  assert.equal(hasMoved(locked, null), false, "not knowing is not the same as having moved");
});

// ── the refusal ──────────────────────────────────────────────────────────────

test("a stale refusal is recognised however the transport reports it", () => {
  assert.equal(isStale({ code: "PT409" }), true);
  assert.equal(isStale({ status: 409 }), true);
  assert.equal(isStale({ message: `${STALE_SUMMARY}` }), true);
  assert.equal(isStale({ details: "stale_summary: the figures moved" }), true);
});

test("an unrelated failure is never reported as staleness", () => {
  assert.equal(isStale({ code: "42501", message: "not authorized" }), false);
  assert.equal(isStale({ message: "connection lost" }), false);
  assert.equal(isStale(null), false);
});

// ── the call ─────────────────────────────────────────────────────────────────

test("the summary is asked for by batch, through the one server function", async () => {
  const calls = [];
  const client = { rpc: (fn, args) => (calls.push([fn, args]), Promise.resolve({ data: locked, error: null })) };
  const out = await loadBatchSummary(client, "b-1");
  assert.deepEqual(calls, [["sarraf_batch_summary", { p_batch_id: "b-1" }]]);
  assert.equal(out.summary_version, "v-aaa");
});

test("a request with no batch never reaches the server", async () => {
  const client = { rpc: () => { throw new Error("should not be called"); } };
  await assert.rejects(() => loadBatchSummary(client, ""));
});

test("a refusal is raised, never returned as an empty summary", async () => {
  const client = { rpc: () => Promise.resolve({ data: null, error: { message: "not authorized" } }) };
  await assert.rejects(() => loadBatchSummary(client, "b-1"),
    (e) => e.message === "not authorized");
});
