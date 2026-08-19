import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  detailRows, holder, loadBatchDetail, loadHoldings, platformName,
} from "../src/services/partnerBatches.js";

const detail = {
  batch_id: "b-1",
  is_indirect: true,
  partner_id: "part-a",
  partner_name: "هاوبەشی یەکەم",
  rows: [
    { ref_no: "PA-1", receiver: "ئەحمەد", tx_date: "2026-08-10", platform: "wechat",
      currency: "CNY", amount: 1000, fee: 0, net_amount: 1000, has_fee: false, counted: true },
    { ref_no: "PA-2", receiver: "ئەحمەد", tx_date: "2026-08-11", platform: "alipay",
      currency: "CNY", amount: 500, fee: 5, net_amount: 495, has_fee: true, counted: true },
  ],
  totals: [{ currency: "CNY", n: 2, with_fee: 1500, without_fee: 1495, fee: 5 }],
};

test("a wallet is named the way a person names it", () => {
  assert.equal(platformName("wechat", "ku"), "ویچات");
  assert.equal(platformName("alipay", "ku"), "ئەلیپەی");
  assert.equal(platformName("wechat", "en"), "WeChat");
});

test("a platform nobody recognised is shown as it came rather than dropped", () => {
  assert.equal(platformName("paypal", "ku"), "paypal");
  assert.equal(platformName(null, "ku"), "—");
});

test("the table carries the four things the owner asked to see", () => {
  const [first] = detailRows(detail);
  assert.equal(first["وەرگر"], "ئەحمەد");
  assert.equal(first["بەروار"], "2026-08-10");
  assert.equal(first["پلاتفۆرم"], "ویچات");
  assert.equal(first["دۆخی فی"], "بێ فی");
});

test("a receipt that carries a fee says so in words, not as a number to compare", () => {
  const rows = detailRows(detail);
  assert.equal(rows[1]["دۆخی فی"], "بە فی");
  assert.equal(rows[1]["فی"], 5);
});

test("both totals travel with every row: with the fee and without it", () => {
  const rows = detailRows(detail);
  assert.equal(rows[0]["بڕ (بە فی)"], 1000);
  assert.equal(rows[0]["بڕ (بێ فی)"], 1000);
  assert.equal(rows[1]["بڕ (بە فی)"], 500);
  assert.equal(rows[1]["بڕ (بێ فی)"], 495);
});

test("a missing date reads as a dash rather than as the word null", () => {
  const [row] = detailRows({ rows: [{ receiver: null, tx_date: null, platform: "unknown" }] });
  assert.equal(row["بەروار"], "—");
  assert.equal(row["وەرگر"], "—");
});

test("a rejected row says why instead of claiming to be counted", () => {
  const [row] = detailRows({ rows: [{ counted: false, reject_reason: "ژمارەکان یەک ناگرنەوە" }] });
  assert.equal(row["دۆخ"], "ژمارەکان یەک ناگرنەوە");
});

test("the holder of the money is named when the trade is indirect", () => {
  assert.deepEqual(holder(detail), { id: "part-a", name: "هاوبەشی یەکەم" });
});

test("a direct trade has no holder, and does not invent one", () => {
  assert.equal(holder({ is_indirect: false, partner_id: null }), null);
  assert.equal(holder(null), null);
});

test("a batch is required before the server is asked about one", async () => {
  await assert.rejects(() => loadBatchDetail({}, ""), /کۆمەڵەیەک پێویستە/);
});

test("the batch detail is read from the server, and a refusal is passed on", async () => {
  const client = { rpc: async (fn, args) => {
    assert.equal(fn, "sarraf_partner_batch_detail");
    assert.deepEqual(args, { p_batch_id: "b-1" });
    return { data: detail, error: null };
  } };
  assert.equal((await loadBatchDetail(client, "b-1")).partner_id, "part-a");

  const failing = { rpc: async () => ({ data: null, error: new Error("42501") }) };
  await assert.rejects(() => loadBatchDetail(failing, "b-1"), /42501/);
});

test("holdings default to an empty list rather than to null", async () => {
  const client = { rpc: async () => ({ data: null, error: null }) };
  const held = await loadHoldings(client);
  assert.deepEqual(held.batches, []);
  assert.equal(held.batch_count, 0);
});

test("an empty partner id is sent as null, so the server picks the caller", async () => {
  const client = { rpc: async (_fn, args) => {
    assert.equal(args.p_partner_id, null);
    return { data: {}, error: null };
  } };
  await loadHoldings(client, "");
});

// The totals a partner is shown and the totals the house acts on have to be the same numbers.
// The only way to guarantee that is for one place to compute them, so this file must not.
test("no total in this module is computed here", () => {
  const source = readFileSync(new URL("../src/services/partnerBatches.js", import.meta.url), "utf8");
  const body = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["reduce(", "+=", "Math.round", "toFixed"]) {
    assert.ok(!body.includes(forbidden), `${forbidden} appears in a module that must not add up`);
  }
});
