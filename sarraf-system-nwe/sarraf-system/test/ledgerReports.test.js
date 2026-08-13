import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_KIND_KU, accountRows, defaultRange, entryBalance, entryCorrection,
  loadGeneralLedger, loadProfitAndLoss, profitRows,
} from "../src/services/ledgerReports.js";

const stub = (data) => {
  const calls = [];
  return { calls, rpc: (fn, args) => (calls.push({ fn, args }), Promise.resolve({ data, error: null })) };
};

const report = {
  from: "2026-08-01", to: "2026-08-31",
  by_currency: [
    { currency: "CNY", income: 1080, expense: 200, net: 880 },
    { currency: "USD", income: 50, expense: 0, net: 50 },
  ],
  realized: [
    { currency: "CNY", income: 1080, expense: 200, net: 520 },
    { currency: "USD", income: 50, expense: 0, net: 50 },
  ],
  unrealized: [{ currency: "CNY", amount: 360 }],
  by_account: [
    { account_id: "acc-4000", account_code: "4000", account_name: "قازانجی ئاڵوگۆڕ", account_kind: "income", currency: "CNY", amount: 720, line_count: 3 },
    { account_id: "acc-4900", account_code: "4900", account_name: "قازانجی گۆڕانی نرخ", account_kind: "income", currency: "CNY", amount: 360, line_count: 1 },
    { account_id: "acc-5200", account_code: "5200", account_name: "خەرجیی کارگێڕی", account_kind: "expense", currency: "CNY", amount: 200, line_count: 2 },
  ],
};

// ── realized and unrealized are never added ──────────────────────────────────

// §13.F.3. A rate that moved today says nothing about what a completed trade earned, and a
// business that adds the two talks itself into a profit it has not made.
test("what trading earned and what the rate moved are separate columns", () => {
  const [cny] = profitRows(report);
  assert.equal(cny.currency, "CNY");
  assert.equal(cny.realized, 520);
  assert.equal(cny.unrealized, 360);
  assert.notEqual(cny.realized, cny.realized + cny.unrealized);
});

test("a currency with no revaluation shows nothing rather than a zero it earned", () => {
  const usd = profitRows(report).find((r) => r.currency === "USD");
  assert.equal(usd.realized, 50);
  assert.equal(usd.unrealized, 0);
});

test("currencies are listed apart and in a settled order", () => {
  assert.deepEqual(profitRows(report).map((r) => r.currency), ["CNY", "USD"]);
});

test("a currency that only ever revalued still appears", () => {
  const rows = profitRows({ by_currency: [], realized: [], unrealized: [{ currency: "IQD", amount: 12 }] });
  assert.deepEqual(rows.map((r) => r.currency), ["IQD"]);
  assert.equal(rows[0].unrealized, 12);
});

test("an empty report is an empty list, not a failure", () => {
  assert.deepEqual(profitRows(null), []);
  assert.deepEqual(profitRows({}), []);
});

// ── a figure can be opened ───────────────────────────────────────────────────

test("the accounts behind a currency's figure can be read", () => {
  const rows = accountRows(report, "CNY");
  assert.deepEqual(rows.map((r) => r.code), ["4000", "4900", "5200"]);
  assert.equal(rows[0].name, "قازانجی ئاڵوگۆڕ");
  assert.equal(rows[2].kind, "expense");
});

test("asking for one currency does not return another's accounts", () => {
  assert.equal(accountRows(report, "USD").length, 0);
  assert.equal(accountRows(report).length, 3);
});

test("every kind of account has a name in Kurdish", () => {
  for (const k of ["asset", "liability", "equity", "income", "expense"]) {
    assert.ok(ACCOUNT_KIND_KU[k], `${k} has no Kurdish name`);
  }
});

// ── the ledger ───────────────────────────────────────────────────────────────

const entry = {
  id: "je-1", business_date: "2026-08-01", source_type: "transaction",
  lines: [
    { line_no: 1, account_id: "acc-1000", side: "debit", currency: "CNY", amount: 720 },
    { line_no: 2, account_id: "acc-4000", side: "credit", currency: "CNY", amount: 720 },
  ],
};

// A reader must be able to see for themselves that an entry balances, not be told it does.
test("both sides of an entry are shown and add up", () => {
  const b = entryBalance(entry);
  assert.equal(b.debit, 720);
  assert.equal(b.credit, 720);
  assert.equal(b.balanced, true);
});

test("an entry that does not balance says so", () => {
  const bad = { lines: [{ side: "debit", amount: 720 }, { side: "credit", amount: 700 }] };
  assert.equal(entryBalance(bad).balanced, false);
});

test("a rounding-sized difference is not an imbalance", () => {
  const near = { lines: [{ side: "debit", amount: 720.001 }, { side: "credit", amount: 720 }] };
  assert.equal(entryBalance(near).balanced, true);
});

// §1.3: history is corrected by posting the opposite. Both ends of that must be visible.
test("a correction and the entry it corrects both say so", () => {
  assert.deepEqual(entryCorrection({ reversal_of: "je-1" }), { kind: "reverses", of: "je-1" });
  assert.deepEqual(entryCorrection({ reversed_by: "je-2" }), { kind: "reversed", by: "je-2" });
  assert.equal(entryCorrection(entry), null);
});

// ── the calls ────────────────────────────────────────────────────────────────

test("the profit and loss is asked for with its range and filters", async () => {
  const c = stub(report);
  await loadProfitAndLoss(c, { from: "2026-08-01", to: "2026-08-31", currency: "cny", partyId: "cus" });
  assert.equal(c.calls[0].fn, "sarraf_profit_and_loss");
  assert.equal(c.calls[0].args.p_currency, "CNY");
  assert.equal(c.calls[0].args.p_party_id, "cus");
});

test("a range ending before it starts never reaches the server", async () => {
  const c = stub(report);
  await assert.rejects(() => loadProfitAndLoss(c, { from: "2026-12-31", to: "2026-01-01" }));
  assert.equal(c.calls.length, 0);
});

test("a date that is not a date is sent as no date at all", async () => {
  const c = stub(report);
  await loadProfitAndLoss(c, { from: "last tuesday" });
  assert.equal(c.calls[0].args.p_from, null);
});

// §12: an export or a listing is bounded. A ledger screen that fetches everything is a screen
// nobody can open on a phone.
test("the ledger is asked for in bounded pages", async () => {
  const c = stub({ entries: [], total: 0 });
  await loadGeneralLedger(c, { limit: 99999, offset: -5 });
  assert.equal(c.calls[0].args.p_limit, 500);
  assert.equal(c.calls[0].args.p_offset, 0);
});

test("the ledger carries its filters through", async () => {
  const c = stub({ entries: [], total: 0 });
  await loadGeneralLedger(c, { accountId: "acc-4000", search: "  income ", transactionId: "tx-1" });
  assert.equal(c.calls[0].args.p_account_id, "acc-4000");
  assert.equal(c.calls[0].args.p_search, "income");
  assert.equal(c.calls[0].args.p_transaction_id, "tx-1");
});

test("a refusal is raised, never returned as an empty ledger", async () => {
  const c = { rpc: () => Promise.resolve({ data: null, error: { message: "not an administrator" } }) };
  await assert.rejects(() => loadGeneralLedger(c), (e) => e.message === "not an administrator");
  await assert.rejects(() => loadProfitAndLoss(c), (e) => e.message === "not an administrator");
});

test("the month so far is what is meant when nothing is said", () => {
  const r = defaultRange(new Date("2026-08-13T12:00:00Z"));
  assert.equal(r.from, "2026-08-01");
  assert.equal(r.to, "2026-08-13");
});
