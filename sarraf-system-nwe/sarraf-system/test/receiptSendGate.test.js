import test from "node:test";
import assert from "node:assert/strict";
import {
  arithmeticObjection, sendableSet, unsendableReceipts, validateReceiptArithmetic,
} from "../src/services/receiptValidation.js";

// The owner's report, after sending eleven receipts:
//
//   "8 are fine and confirmed, 3 said they needed review — but there was no way whatsoever for
//    me to review them. I gave up and deleted the three. Now when I try to send the 8, why does
//    it still say that?"
//
// Three faults, and the first is the one that trapped them: the rule that decided a row was
// fine and the rule that decided a row could be sent were not the same rule.

// ── the two rules must be one rule ───────────────────────────────────────────

// A receipt with no order amount was never arithmetic-checked when its status was decided, so
// it showed green with no review flag and no edit control — and was then refused by the send
// gate, which checks every row. The screen marked nothing, so there was nothing to click.
test("a receipt refused by the gate is a receipt the screen marked", () => {
  const receipt = { id: "r1", amount: 2400, fee: 0, orderAmount: null, netAmount: 2375 };
  const objection = arithmeticObjection(receipt);
  assert.notEqual(objection, null, "the gate refuses this receipt");
  assert.deepEqual(unsendableReceipts([receipt]).map((x) => x.id), ["r1"]);
});

test("the objection names the figures, so a person can see what disagrees", () => {
  const objection = arithmeticObjection({ amount: 2400, fee: 0, netAmount: 2375 });
  assert.match(objection.reason, /2,375\.00/);
  assert.match(objection.reason, /2,400\.00/);
  assert.ok(objection.issues.includes("net_amount_mismatch"));
});

test("a receipt whose figures agree raises no objection", () => {
  assert.equal(arithmeticObjection({ amount: 2400, fee: 25, netAmount: 2375 }), null);
  assert.equal(arithmeticObjection({ amount: 1000, fee: 0, netAmount: 1000 }), null);
  assert.equal(arithmeticObjection({ amount: 1000, fee: 3, orderAmount: 997, netAmount: 997 }), null);
});

// A receipt the reader could not put a number on is evidence, not arithmetic. It is refused a
// place in the totals, but it must not be reported as a sum that does not add up.
test("a receipt with no amount at all is not called a mismatch", () => {
  const objection = arithmeticObjection({ amount: null, fee: null, netAmount: null });
  assert.notEqual(objection, null);
  assert.ok(objection.issues.includes("invalid_gross_amount"));
  assert.doesNotMatch(objection.reason, /یەک ناگرنەوە/);
});

test("rounding-sized differences are not mismatches", () => {
  assert.equal(arithmeticObjection({ amount: 1000, fee: 0.01, netAmount: 999.99 }), null);
  assert.equal(arithmeticObjection({ amount: 2520.41, fee: 73.41, netAmount: 2447.00 }), null);
});

// ── a batch is never held hostage by a receipt nobody can resolve ────────────

// The uploader supplies evidence; the operator reviews it. A receipt the uploader is not
// allowed to correct must therefore travel with the batch, marked, and count towards nothing —
// exactly as a rejected receipt already does. Holding the whole batch is how eleven receipts
// became three deletions.
test("what an uploader cannot resolve travels as evidence, counted towards nothing", () => {
  const rows = [
    { id: "ok1", status: "ok", amount: 1000, fee: 0, netAmount: 1000 },
    { id: "ok2", status: "ok", amount: 500, fee: 0, netAmount: 500 },
    { id: "bad", status: "ok", amount: 2400, fee: 0, netAmount: 2375 },
  ];
  const set = sendableSet(rows, { mayResolve: false });
  assert.deepEqual(set.counted.map((r) => r.id), ["ok1", "ok2"]);
  assert.deepEqual(set.evidence.map((r) => r.id), ["bad"], "it is still sent");
  assert.equal(set.blocked, false, "the batch is not held");
  assert.equal(set.evidence[0].counted, false);
  assert.equal(set.evidence[0].status, "error");
  assert.match(set.evidence[0].reject_reason, /2,375\.00/);
});

// Staff can correct a reading through the reviewed path, so for them the refusal is useful:
// it stops a batch whose figures they are able to put right.
test("staff are stopped, because staff can put it right", () => {
  const rows = [{ id: "bad", status: "ok", amount: 2400, fee: 0, netAmount: 2375 }];
  const set = sendableSet(rows, { mayResolve: true });
  assert.equal(set.blocked, true);
  assert.deepEqual(set.objections.map((o) => o.id), ["bad"]);
});

test("a batch with nothing wrong is never blocked, for anyone", () => {
  const rows = [{ id: "ok1", status: "ok", amount: 1000, fee: 0, netAmount: 1000 }];
  for (const mayResolve of [true, false]) {
    const set = sendableSet(rows, { mayResolve });
    assert.equal(set.blocked, false);
    assert.deepEqual(set.counted.map((r) => r.id), ["ok1"]);
    assert.deepEqual(set.evidence, []);
  }
});

// Everything that was already rejected stays rejected and stays sent.
test("receipts already rejected keep their own reason", () => {
  const rows = [
    { id: "dup", status: "dup", counted: false, reject_reason: "دووبارەیە" },
    { id: "ok1", status: "ok", amount: 1000, fee: 0, netAmount: 1000 },
  ];
  const set = sendableSet(rows, { mayResolve: false });
  assert.deepEqual(set.counted.map((r) => r.id), ["ok1"]);
  assert.deepEqual(set.evidence.map((r) => r.id), ["dup"]);
  assert.equal(set.evidence[0].reject_reason, "دووبارەیە", "its own reason is not overwritten");
});

test("an empty batch is empty, not blocked", () => {
  const set = sendableSet([], { mayResolve: false });
  assert.equal(set.blocked, false);
  assert.deepEqual(set.counted, []);
  assert.deepEqual(set.evidence, []);
});

// ── the original gate still holds ────────────────────────────────────────────

test("the arithmetic itself is unchanged", () => {
  assert.equal(validateReceiptArithmetic({ amount: 1000, fee: 3, orderAmount: 997, netAmount: 997 }).valid, true);
  assert.equal(validateReceiptArithmetic({ amount: 1000, fee: 3, orderAmount: 900, netAmount: 997 }).valid, false);
  assert.equal(validateReceiptArithmetic({ amount: 1000, fee: 2000 }).valid, false);
});
