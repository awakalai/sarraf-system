import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  FORWARDABLE_STATES, recipientRoleFor, skipReasonText, deliveryText,
  partitionForForwarding, forwardReceipts, loadForwardedToMe,
  markSeen, loadForwardingReconciliation, forwardedTotals, forwardCommandKey,
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

test("only a finalized receipt may be forwarded", () => {
  assert.deepEqual(FORWARDABLE_STATES, ["finalized"]);
  const { eligible, blocked } = partitionForForwarding([
    { id: "accepted", state: "accepted" },
    { id: "finalized", state: "finalized", flow: "customer_buys_from_zeman" },
  ]);
  assert.deepEqual(eligible.map((row) => row.id), ["finalized"]);
  assert.equal(blocked[0].blockedBy, "accepted");
});

for (const state of ["submitted", "parsed", "needs_manual_review", "validated", "accepted",
  "duplicate", "rejected", "tamper_suspected", "currency_mismatch", "forwarded", "seen"]) {
  test(`a ${state} receipt is never eligible to forward`, () => {
    const { eligible, blocked } = partitionForForwarding([{ id: "d1", state }]);
    assert.equal(eligible.length, 0);
    assert.equal(blocked[0].blockedBy, state);
  });
}

test("flow labels still explain the server-derived destination", () => {
  assert.equal(recipientRoleFor("customer_buys_from_zeman"), "customer");
  assert.equal(recipientRoleFor("customer_sells_to_zeman"), "partner");
  assert.equal(recipientRoleFor("unknown"), null);
});

test("a customer's sale receipt is delivered to the exact custody partner", () => {
  const { eligible, blocked } = partitionForForwarding([
    { id: "sale", state: "finalized", flow: "customer_sells_to_zeman", partnerId: "p-1" },
  ]);
  assert.deepEqual(eligible.map((row) => row.id), ["sale"]);
  assert.equal(blocked.length, 0);
});

test("a customer-sale receipt cannot leave without its exact custody partner", () => {
  const { eligible, blocked } = partitionForForwarding([
    { id: "sale", state: "finalized", flow: "customer_sells_to_zeman", partnerId: null },
  ]);
  assert.equal(eligible.length, 0);
  assert.equal(blocked[0].blockedBy, "recipient_must_be_partner");
});

test("partitioning is empty-safe and never mutates source rows", () => {
  assert.deepEqual(partitionForForwarding(null), { eligible: [], blocked: [] });
  const rows = [{ id: "d1", state: "rejected" }];
  partitionForForwarding(rows);
  assert.equal("blockedBy" in rows[0], false);
});

test("forwarding refuses an empty selection and a short reason locally", async () => {
  const client = stubClient();
  await assert.rejects(() => forwardReceipts(client, { documentIds: [], reason: "handing over" }));
  await assert.rejects(() => forwardReceipts(client, { documentIds: ["d1"], reason: "short" }));
  assert.equal(client.calls.length, 0);
});

test("the canonical forwarding command sends no client-selected recipient", async () => {
  const client = stubClient({
    sarraf_forward_receipts_v2: {
      data: {
        forwarded: 2,
        destinations: [
          { document_id: "d1", to_actor_id: "customer-1", to_role: "customer", delivery_status: "delivered" },
          { document_id: "d2", to_actor_id: "partner-1", to_role: "partner", delivery_status: "delivered" },
        ],
        replayed: false,
      },
      error: null,
    },
  });
  const result = await forwardReceipts(client, {
    documentIds: ["d1", "d1", "d2", null],
    reason: "handing verified evidence over",
  });
  const call = client.calls[0];
  assert.equal(call.fn, "sarraf_forward_receipts_v2");
  assert.deepEqual(call.args.p_document_ids, ["d1", "d2"]);
  assert.deepEqual(Object.keys(call.args).sort(), ["p_command_key", "p_document_ids", "p_reason"]);
  assert.equal(result.destinations[0].toActorId, "customer-1");
  assert.equal(result.destinations[1].toRole, "partner");
});

test("forward retries are idempotent and different batches have different keys", async () => {
  const client = stubClient({ sarraf_forward_receipts_v2: { data: { forwarded: 1, replayed: true }, error: null } });
  const result = await forwardReceipts(client, { documentIds: ["d1"], reason: "finalized evidence handoff" });
  assert.ok(client.calls[0].args.p_command_key);
  assert.equal(result.replayed, true);
  assert.notEqual(forwardCommandKey("assigned"), forwardCommandKey("assigned"));
});

test("a server refusal is surfaced, never reported as success", async () => {
  const client = stubClient({
    sarraf_forward_receipts_v2: { data: null, error: { message: "exact recipient has not been assigned" } },
  });
  await assert.rejects(() => forwardReceipts(client, {
    documentIds: ["d1"], reason: "finalized evidence handoff",
  }));
});

test("recipient selection is absent from both service and forwarding UI", () => {
  const service = fs.readFileSync(new URL("../src/services/receiptForwarding.js", import.meta.url), "utf8");
  const component = fs.readFileSync(new URL("../src/components/receipts/ReceiptForwardingCenter.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(service, /p_to_actor_id|p_transaction_id/);
  assert.doesNotMatch(component, /setToActorId|pickRecipient|<select/);
});

test("forwarding statuses and skip reasons remain readable", () => {
  assert.equal(new Set([deliveryText("sent"), deliveryText("delivered"), deliveryText("seen")]).size, 3);
  assert.notEqual(deliveryText("failed_retryable"), deliveryText("delivered"));
  for (const reason of ["not_found", "needs_manual_review", "parsed", "validated", "submitted",
    "rejected", "duplicate", "currency_mismatch", "tamper_suspected", "forwarded", "delivered", "seen"]) {
    assert.notEqual(skipReasonText(reason), reason);
  }
});

test("only the assigned recipient can mark a forwarded receipt seen", async () => {
  const client = stubClient();
  await markSeen(client, "d1");
  assert.equal(client.calls[0].fn, "sarraf_receipt_mark_seen_v2");
  assert.deepEqual(client.calls[0].args, { p_document_id: "d1" });
  const refused = stubClient({ sarraf_receipt_mark_seen_v2: { data: null, error: { message: "not assigned" } } });
  await assert.rejects(() => markSeen(refused, "d1"));
});

test("a recipient's rows preserve nulls and numeric values", async () => {
  const client = stubClient({
    sarraf_my_forwarded_receipts_v2: {
      data: [
        {
          document_id: "d1", delivery_status: "delivered", gross_amount: "2520.41",
          order_amount: "2447", fee_amount: "73.41", net_amount: "2447", currency: "CNY",
          merchant_order_no: "MO-1", payee: "Partner Account", platform: "wechat", has_fee: true,
          rate_value: "7.20", rate_convention: "1_USD_EQUALS_X_CURRENCY",
          rate_date: "2026-08-12", rate_version: "3", gross_usd: "350.06", fee_usd: "10.20", net_usd: "339.86",
        },
        { document_id: "d2", delivery_status: "delivered", gross_amount: null, fee_amount: null, net_amount: null, currency: null },
      ],
      error: null,
    },
  });
  const rows = await loadForwardedToMe(client, 25);
  assert.equal(rows[0].net, 2447);
  assert.equal(typeof rows[0].net, "number");
  assert.equal(rows[0].orderAmount, 2447);
  assert.equal(rows[0].merchantOrderNo, "MO-1");
  assert.equal(rows[0].payee, "Partner Account");
  assert.equal(rows[0].platform, "wechat");
  assert.equal(rows[0].hasFee, true);
  assert.deepEqual(
    [rows[0].grossUsd, rows[0].feeUsd, rows[0].netUsd, rows[0].rateValue, rows[0].rateVersion],
    [350.06, 10.2, 339.86, 7.2, 3],
  );
  assert.equal(rows[0].rateConvention, "1_USD_EQUALS_X_CURRENCY");
  assert.equal(rows[1].net, null);
  assert.equal(rows[1].netUsd, null);
  assert.equal(client.calls[0].fn, "sarraf_my_forwarded_receipts_v2");
  assert.equal(client.calls[0].args.p_limit, 25);
});

test("currencies are totalled separately and unread receipts contribute nothing", () => {
  const totals = forwardedTotals([
    { currency: "CNY", gross: 1000, fee: 3, net: 997 },
    { currency: "CNY", gross: 500, fee: 1, net: 499 },
    { currency: "USD", gross: 200, fee: 0, net: 200 },
    { currency: "CNY", gross: null, fee: null, net: null },
  ]);
  assert.equal(totals.CNY.net, 1496);
  assert.equal(totals.CNY.count, 2);
  assert.equal(totals.USD.net, 200);
  assert.deepEqual(forwardedTotals(null), {});
});

test("reconciliation keeps delivery facts apart and defaults missing counts to zero", async () => {
  const client = stubClient({
    sarraf_forwarding_reconciliation: {
      data: { forwarded: 10, sent: 4, delivered: 6, seen: 2, failed: 0 }, error: null,
    },
  });
  const result = await loadForwardingReconciliation(client);
  assert.deepEqual(result, { forwarded: 10, sent: 4, delivered: 6, seen: 2, failed: 0 });
  const empty = stubClient({ sarraf_forwarding_reconciliation: { data: {}, error: null } });
  const defaults = await loadForwardingReconciliation(empty);
  for (const value of Object.values(defaults)) assert.equal(Number.isFinite(value), true);
});
