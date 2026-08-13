import test from "node:test";
import assert from "node:assert/strict";
import {
  DEBT_EVENT_KU, OFFSET_REASON_MIN, VOUCHER_KIND_KU, WRITE_OFF_REASON_MIN,
  loadDebtHistory, loadVoucherRegister, offsetAmount, offsetCommandKey, offsetObjection,
  offsetDebts, writeOffCommandKey, writeOffDebt,
} from "../src/services/debtRegister.js";

const stub = (answer = { data: { ok: true }, error: null }) => {
  const calls = [];
  return { calls, rpc: (fn, args) => (calls.push({ fn, args }), Promise.resolve(answer)) };
};

const owesUs = {
  id: "d-1", currency: "CNY", status: "open", outstanding_principal: 800,
  debtor_type: "customer", debtor_id: "c-1", creditor_type: "zeman", creditor_id: null,
};
const weOwe = {
  id: "d-2", currency: "CNY", status: "open", outstanding_principal: 300,
  debtor_type: "zeman", debtor_id: null, creditor_type: "customer", creditor_id: "c-1",
};

// ── what may be netted ───────────────────────────────────────────────────────

test("two debts between the same two parties, facing opposite ways, may be netted", () => {
  assert.equal(offsetObjection(owesUs, weOwe), null);
  assert.equal(offsetObjection(weOwe, owesUs), null, "the order does not matter");
});

test("only the smaller of the two balances cancels", () => {
  assert.equal(offsetAmount(owesUs, weOwe), 300);
  assert.equal(offsetAmount(weOwe, owesUs), 300);
});

// Netting across currencies would be a conversion at a rate nobody stated.
test("two currencies are never netted against each other", () => {
  assert.match(offsetObjection(owesUs, { ...weOwe, currency: "USD" }), /هەمان دراو/);
});

test("two debts pointing the same way are not a netting", () => {
  assert.match(offsetObjection(owesUs, { ...owesUs, id: "d-3" }), /پێچەوانە/);
});

test("a debt is never netted against itself", () => {
  assert.match(offsetObjection(owesUs, owesUs), /لەگەڵ خۆی/);
});

test("a closed debt is not netted", () => {
  for (const status of ["settled", "written_off", "void"]) {
    assert.match(offsetObjection({ ...owesUs, status }, weOwe), /داخراو/, status);
  }
});

// The books here are ZEMAN's. Two outside parties owing each other has no entry in them.
test("netting between two outside parties is refused", () => {
  const a = { ...owesUs, creditor_type: "partner", creditor_id: "p-1" };
  const b = { ...weOwe, debtor_type: "partner", debtor_id: "p-1" };
  assert.match(offsetObjection(a, b), /زیمان/);
});

// The screen holds debts in one shape and the database returns them in another. Both must
// reach the same verdict, or the button and the command would disagree.
test("the same verdict is reached whichever shape the debt arrives in", () => {
  const asScreen = (d) => ({
    id: d.id, currency: d.currency, status: d.status,
    debtorType: d.debtor_type, debtorId: d.debtor_id,
    creditorType: d.creditor_type, creditorId: d.creditor_id,
    outstanding: d.outstanding_principal,
  });
  assert.equal(offsetObjection(asScreen(owesUs), asScreen(weOwe)), null);
  assert.equal(offsetAmount(asScreen(owesUs), asScreen(weOwe)), 300);
  assert.match(offsetObjection(asScreen(owesUs), asScreen({ ...weOwe, currency: "USD" })), /هەمان دراو/);
});

test("nothing to net produces no amount rather than a zero", () => {
  assert.equal(offsetAmount({ ...owesUs, outstanding_principal: 0 }, weOwe), null);
  assert.equal(offsetAmount(null, weOwe), null);
});

// ── the netting command ──────────────────────────────────────────────────────

test("a netting carries both debts, the reason and a command key", async () => {
  const c = stub();
  const { commandKey } = await offsetDebts(c, {
    leftDebtId: "d-1", rightDebtId: "d-2", reason: "both sides agreed to net these",
  });
  assert.equal(c.calls[0].fn, "sarraf_offset_debts");
  assert.equal(c.calls[0].args.p_left_debt_id, "d-1");
  assert.equal(c.calls[0].args.p_right_debt_id, "d-2");
  assert.equal(c.calls[0].args.p_amount, null, "no amount means net as much as will cancel");
  assert.ok(commandKey.startsWith("debt-offset:"), "a retry must not net twice");
});

test("a netting with a bare reason never reaches the server", async () => {
  const c = stub();
  await assert.rejects(() => offsetDebts(c, { leftDebtId: "d-1", rightDebtId: "d-2", reason: "ok" }));
  assert.equal(c.calls.length, 0);
});

test("a netting of one debt against itself never reaches the server", async () => {
  const c = stub();
  await assert.rejects(() => offsetDebts(c, { leftDebtId: "d-1", rightDebtId: "d-1", reason: "a long enough reason" }));
  assert.equal(c.calls.length, 0);
});

test("a negative or zero netting amount is refused", async () => {
  const c = stub();
  for (const amount of [0, -5]) {
    await assert.rejects(() => offsetDebts(c, {
      leftDebtId: "d-1", rightDebtId: "d-2", amount, reason: "a long enough reason",
    }));
  }
  assert.equal(c.calls.length, 0);
});

// ── writing off ──────────────────────────────────────────────────────────────

// Giving up money asks for more explanation than receiving it.
test("writing off demands a longer reason than netting does", () => {
  assert.ok(WRITE_OFF_REASON_MIN > OFFSET_REASON_MIN);
});

test("a write-off with too short a reason never reaches the server", async () => {
  const c = stub();
  await assert.rejects(() => writeOffDebt(c, { debtId: "d-1", reason: "no money" }));
  assert.equal(c.calls.length, 0);
});

test("a write-off carries the debt, the reason and a command key", async () => {
  const c = stub();
  const { commandKey } = await writeOffDebt(c, {
    debtId: "d-1", reason: "the customer has closed and cannot be reached",
  });
  assert.equal(c.calls[0].fn, "sarraf_write_off_debt");
  assert.equal(c.calls[0].args.p_debt_id, "d-1");
  assert.equal(c.calls[0].args.p_amount, null, "no amount means the whole of what is left");
  assert.ok(commandKey.startsWith("debt-write-off:"));
});

test("part of a debt can be written off", async () => {
  const c = stub();
  await writeOffDebt(c, { debtId: "d-1", amount: 250, reason: "only this much is unrecoverable" });
  assert.equal(c.calls[0].args.p_amount, 250);
});

test("a refusal from the server is raised, never swallowed", async () => {
  const c = stub({ data: null, error: { message: "only the system owner may write off a debt" } });
  await assert.rejects(() => writeOffDebt(c, { debtId: "d-1", reason: "a perfectly long reason here" }));
});

// ── the register ─────────────────────────────────────────────────────────────

test("the register is asked for by party and date", async () => {
  const c = stub({ data: [{ reference: "V-2026-000001" }], error: null });
  const rows = await loadVoucherRegister(c, { partyId: "c-1", from: "2026-01-01", to: "2026-12-31" });
  assert.equal(c.calls[0].fn, "sarraf_voucher_register");
  assert.equal(c.calls[0].args.p_party_id, "c-1");
  assert.equal(rows[0].reference, "V-2026-000001");
});

test("an empty register is a list, not a failure", async () => {
  const c = stub({ data: null, error: null });
  assert.deepEqual(await loadVoucherRegister(c), []);
});

test("a debt's history is asked for by debt", async () => {
  const c = stub({ data: { debt_id: "d-1", events: [] }, error: null });
  const h = await loadDebtHistory(c, "d-1");
  assert.equal(c.calls[0].args.p_debt_id, "d-1");
  assert.equal(h.debt_id, "d-1");
});

test("asking for the history of no debt never reaches the server", async () => {
  const c = stub();
  await assert.rejects(() => loadDebtHistory(c, ""));
  assert.equal(c.calls.length, 0);
});

// ── the words on the screen ──────────────────────────────────────────────────

test("every kind of voucher and every kind of debt event has a name in Kurdish", () => {
  for (const k of ["debt_opened", "debt_settlement", "debt_offset", "debt_write_off",
    "vault_deposit", "vault_withdrawal", "office_payment", "partner_settlement", "reversal"]) {
    assert.ok(VOUCHER_KIND_KU[k], `${k} has no Kurdish name`);
  }
  for (const k of ["opened", "settled", "offset", "written_off", "voided", "reinstated"]) {
    assert.ok(DEBT_EVENT_KU[k], `${k} has no Kurdish name`);
  }
});

test("two nettings of the same pair get different keys", () => {
  assert.notEqual(offsetCommandKey("d-1", "d-2"), offsetCommandKey("d-1", "d-2"));
  assert.notEqual(writeOffCommandKey("d-1"), writeOffCommandKey("d-1"));
});
