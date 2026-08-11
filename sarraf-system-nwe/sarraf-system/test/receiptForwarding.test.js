import test from "node:test";
import assert from "node:assert/strict";
import {
  FORWARDABLE_STATES, recipientRoleFor, skipReasonText, deliveryText,
  partitionForForwarding, forwardReceipts, loadForwardedToMe,
  markDelivered, markSeen, loadForwardingReconciliation, forwardedTotals,
  forwardCommandKey,
} from "../src/services/receiptForwarding.js";

const stubClient = (rpc = {}) => {
  const calls = [];
  return {
    calls,
    rpc(fn, args) {
      calls.push({ fn, args });
      if (typeof rpc[fn] === "function") return Promise.resolve(rpc[fn](args));
      if (rpc[fn]) return Promise.resolve(rpc[fn]);
      return Promise.resolve({ data: {}, error: null });
    },
  };
};

// ---- eligibility ------------------------------------------------------------

test("only accepted and finalized receipts may be forwarded", () => {
  assert.deepEqual([...FORWARDABLE_STATES].sort(), ["accepted", "finalized"]);
});

// The states that must never reach a portal. Each one is evidence still under decision,
// and a customer seeing a duplicate or a tampered receipt is the failure §8.5 exists to stop.
for (const state of ["submitted", "parsed", "needs_manual_review", "validated",
                     "duplicate", "rejected", "tamper_suspected", "currency_mismatch"]) {
  test(`a ${state} receipt is never eligible to forward`, () => {
    const { eligible, blocked } = partitionForForwarding([{ id: "d1", state, flow: "customer_buys_from_zeman" }]);
    assert.equal(eligible.length, 0, `${state} must not be forwardable`);
    assert.equal(blocked[0].blockedBy, state);
  });
}

test("a receipt already forwarded is blocked rather than sent twice", () => {
  const { eligible, blocked } = partitionForForwarding([
    { id: "d1", state: "forwarded", flow: "customer_buys_from_zeman" },
    { id: "d2", state: "seen", flow: "customer_buys_from_zeman" },
  ]);
  assert.equal(eligible.length, 0);
  assert.deepEqual(blocked.map((b) => b.blockedBy), ["forwarded", "seen"]);
});

test("each flow names its own recipient", () => {
  assert.equal(recipientRoleFor("customer_buys_from_zeman"), "customer");
  assert.equal(recipientRoleFor("customer_sells_to_zeman"), "partner");
  assert.equal(recipientRoleFor("something_else"), null);
});

// The mis-delivery this guards against: a customer's own payment evidence must go to the
// partner taking custody, not back to the customer who sent it.
test("a sell-flow receipt is blocked when the chosen recipient is a customer", () => {
  const { eligible, blocked } = partitionForForwarding(
    [{ id: "d1", state: "accepted", flow: "customer_sells_to_zeman" }], "customer");
  assert.equal(eligible.length, 0);
  assert.equal(blocked[0].blockedBy, "recipient_must_be_partner");
});

test("a buy-flow receipt is blocked when the chosen recipient is a partner", () => {
  const { eligible, blocked } = partitionForForwarding(
    [{ id: "d1", state: "accepted", flow: "customer_buys_from_zeman" }], "partner");
  assert.equal(eligible.length, 0);
  assert.equal(blocked[0].blockedBy, "recipient_must_be_customer");
});

test("the right recipient passes", () => {
  const { eligible } = partitionForForwarding(
    [{ id: "d1", state: "accepted", flow: "customer_sells_to_zeman" },
     { id: "d2", state: "finalized", flow: "customer_sells_to_zeman" }], "partner");
  assert.deepEqual(eligible.map((d) => d.id), ["d1", "d2"]);
});

test("with no recipient chosen yet, state alone decides", () => {
  const { eligible, blocked } = partitionForForwarding([
    { id: "d1", state: "accepted", flow: "customer_sells_to_zeman" },
    { id: "d2", state: "accepted", flow: "customer_buys_from_zeman" },
    { id: "d3", state: "rejected", flow: "customer_buys_from_zeman" },
  ]);
  assert.deepEqual(eligible.map((d) => d.id), ["d1", "d2"]);
  assert.deepEqual(blocked.map((d) => d.id), ["d3"]);
});

test("an empty or missing list is not an error", () => {
  assert.deepEqual(partitionForForwarding(null), { eligible: [], blocked: [] });
  assert.deepEqual(partitionForForwarding([]), { eligible: [], blocked: [] });
});

test("partitioning does not mutate the documents it is given", () => {
  const docs = [{ id: "d1", state: "rejected", flow: "customer_buys_from_zeman" }];
  partitionForForwarding(docs, "customer");
  assert.equal("blockedBy" in docs[0], false);
});

// ---- the command ------------------------------------------------------------

test("forwarding refuses an empty selection before touching the server", async () => {
  const c = stubClient();
  await assert.rejects(() => forwardReceipts(c, { documentIds: [], toActorId: "u1", reason: "handing over" }));
  assert.equal(c.calls.length, 0, "nothing may be sent for an empty selection");
});

test("forwarding refuses without a recipient", async () => {
  const c = stubClient();
  await assert.rejects(() => forwardReceipts(c, { documentIds: ["d1"], toActorId: "", reason: "handing over" }));
  assert.equal(c.calls.length, 0);
});

// The server enforces the same minimum; refusing here keeps a doomed round trip from
// looking like a server fault to the operator.
test("a reason shorter than the server's minimum is refused locally", async () => {
  const c = stubClient();
  await assert.rejects(() => forwardReceipts(c, { documentIds: ["d1"], toActorId: "u1", reason: "ok" }));
  assert.equal(c.calls.length, 0);
});

test("duplicate ids in the selection are sent once", async () => {
  const c = stubClient({ sarraf_forward_receipts: { data: { forwarded: 2, skipped: [] }, error: null } });
  await forwardReceipts(c, { documentIds: ["d1", "d1", "d2", null], toActorId: "u1", reason: "handing custody over" });
  assert.deepEqual(c.calls[0].args.p_document_ids, ["d1", "d2"]);
});

test("a command key is always supplied so a retry cannot forward twice", async () => {
  const c = stubClient({ sarraf_forward_receipts: { data: { forwarded: 1, skipped: [] }, error: null } });
  await forwardReceipts(c, { documentIds: ["d1"], toActorId: "u1", reason: "handing custody over" });
  assert.ok(c.calls[0].args.p_command_key, "the command must carry an idempotency key");
});

test("two batches never share a command key", () => {
  assert.notEqual(forwardCommandKey("u1"), forwardCommandKey("u1"));
});

test("skipped receipts come back named, not silently dropped", async () => {
  const c = stubClient({
    sarraf_forward_receipts: {
      data: { forwarded: 1, skipped: [{ id: "d2", reason: "duplicate" }, { id: "d3", reason: "rejected" }],
              to_actor_id: "u1", to_role: "customer", replayed: false },
      error: null,
    },
  });
  const r = await forwardReceipts(c, { documentIds: ["d1", "d2", "d3"], toActorId: "u1", reason: "publishing evidence" });
  assert.equal(r.forwarded, 1);
  assert.equal(r.skipped.length, 2);
  assert.equal(r.skipped[0].text, "دووبارەیە");
  assert.equal(r.skipped[1].text, "ڕەتکراوەتەوە");
  assert.equal(r.toRole, "customer");
});

test("a replay is reported as a replay, not as fresh work", async () => {
  const c = stubClient({ sarraf_forward_receipts: { data: { forwarded: 2, skipped: [], replayed: true }, error: null } });
  const r = await forwardReceipts(c, { documentIds: ["d1", "d2"], toActorId: "u1", reason: "handing custody over" });
  assert.equal(r.replayed, true);
});

test("a server refusal is surfaced, never reported as success", async () => {
  const c = stubClient({ sarraf_forward_receipts: { data: null, error: { message: "only an administrator may forward receipts" } } });
  await assert.rejects(() => forwardReceipts(c, { documentIds: ["d1"], toActorId: "u1", reason: "handing custody over" }));
});

test("every skip reason the server can return has plain-language text", () => {
  for (const reason of ["not_found", "needs_manual_review", "parsed", "validated", "submitted",
                        "rejected", "duplicate", "currency_mismatch", "tamper_suspected",
                        "forwarded", "delivered", "seen",
                        "recipient_must_be_partner", "recipient_must_be_customer"]) {
    assert.notEqual(skipReasonText(reason), reason, `${reason} needs readable text`);
  }
});

test("an unknown reason still reads as something rather than blank", () => {
  assert.equal(skipReasonText("some_new_state"), "some_new_state");
});

// ---- delivery ---------------------------------------------------------------

// §8.12: a send is not a delivery and a delivery is not a reading. Collapsing them is how a
// dispute ends with "we sent it" against "I never saw it" and no record to settle it.
test("sent, delivered and seen read as three different things", () => {
  const s = deliveryText("sent"), d = deliveryText("delivered"), n = deliveryText("seen");
  assert.equal(new Set([s, d, n]).size, 3);
});

test("a failed delivery is never shown as delivered", () => {
  assert.notEqual(deliveryText("failed_terminal"), deliveryText("delivered"));
  assert.notEqual(deliveryText("failed_retryable"), deliveryText("delivered"));
});

test("marking delivered and seen call their own commands", async () => {
  const c = stubClient();
  await markDelivered(c, "d1");
  await markSeen(c, "d1");
  assert.deepEqual(c.calls.map((x) => x.fn),
    ["sarraf_receipt_mark_delivered", "sarraf_receipt_mark_seen"]);
  assert.equal(c.calls[0].args.p_document_id, "d1");
});

test("a refused acknowledgement is raised, not swallowed", async () => {
  const c = stubClient({ sarraf_receipt_mark_seen: { data: null, error: { message: "this receipt was not forwarded to you" } } });
  await assert.rejects(() => markSeen(c, "d1"));
});

// ---- the recipient's view ---------------------------------------------------

test("a recipient's rows arrive in the shape the portal renders", async () => {
  const c = stubClient({
    sarraf_my_forwarded_receipts: {
      data: [{ document_id: "d1", delivery_status: "sent", forwarded_at: "2026-08-01T10:00:00Z",
               seen_at: null, storage_path: "ingest/solo/d1.jpg", currency: "CNY",
               gross_amount: "1000.00", fee_amount: "3.00", net_amount: "997.00",
               ref_no: "R-1", tx_date: "2026-08-01", transaction_id: "t1" }],
      error: null,
    },
  });
  const [row] = await loadForwardedToMe(c);
  assert.equal(row.documentId, "d1");
  assert.equal(row.net, 997);
  assert.equal(typeof row.net, "number", "figures must be numbers, not strings");
  assert.equal(row.seenAt, null);
});

test("a receipt whose figures were never read comes back null, not zero", async () => {
  const c = stubClient({
    sarraf_my_forwarded_receipts: {
      data: [{ document_id: "d1", delivery_status: "sent", currency: null,
               gross_amount: null, fee_amount: null, net_amount: null }],
      error: null,
    },
  });
  const [row] = await loadForwardedToMe(c);
  assert.equal(row.net, null, "an unread figure must not become 0");
  assert.equal(row.gross, null);
});

test("the recipient's limit is passed through", async () => {
  const c = stubClient({ sarraf_my_forwarded_receipts: { data: [], error: null } });
  await loadForwardedToMe(c, 25);
  assert.equal(c.calls[0].args.p_limit, 25);
});

// ---- totals -----------------------------------------------------------------

test("currencies are totalled separately and never combined", () => {
  const t = forwardedTotals([
    { currency: "CNY", gross: 1000, fee: 3, net: 997 },
    { currency: "CNY", gross: 500, fee: 1, net: 499 },
    { currency: "USD", gross: 200, fee: 0, net: 200 },
  ]);
  assert.equal(t.CNY.net, 1496);
  assert.equal(t.CNY.count, 2);
  assert.equal(t.USD.net, 200);
  assert.equal(Object.keys(t).length, 2);
});

// A receipt still waiting to be read has no value yet. Counting it as 0 would show a total
// that is wrong in a way nobody can see.
test("an unread receipt contributes nothing to the totals", () => {
  const t = forwardedTotals([
    { currency: "CNY", gross: 1000, fee: 3, net: 997 },
    { currency: "CNY", gross: null, fee: null, net: null },
    { currency: null, gross: 50, fee: 0, net: 50 },
  ]);
  assert.equal(t.CNY.net, 997);
  assert.equal(t.CNY.count, 1, "the unread receipt must not be counted");
  assert.equal(Object.keys(t).length, 1);
});

test("totals of nothing are empty rather than an error", () => {
  assert.deepEqual(forwardedTotals(null), {});
  assert.deepEqual(forwardedTotals([]), {});
});

// ---- reconciliation ---------------------------------------------------------

test("reconciliation keeps the three counts apart", async () => {
  const c = stubClient({
    sarraf_forwarding_reconciliation: {
      data: { forwarded: 10, sent: 4, delivered: 6, seen: 2, failed: 0 }, error: null,
    },
  });
  const r = await loadForwardingReconciliation(c);
  assert.equal(r.forwarded, 10);
  assert.equal(r.sent, 4);
  assert.equal(r.delivered, 6);
  assert.equal(r.seen, 2);
});

test("a missing reconciliation field reads as zero rather than NaN", async () => {
  const c = stubClient({ sarraf_forwarding_reconciliation: { data: {}, error: null } });
  const r = await loadForwardingReconciliation(c);
  for (const v of Object.values(r)) assert.equal(Number.isFinite(v), true);
});
