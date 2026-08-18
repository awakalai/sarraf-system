import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  TRANSACTION_BUSINESS_FLOW,
  isOwnerCashboxFlow,
  normalizeTransactionBusinessFlow,
  receiptRecipientRoleForTransaction,
  transactionBusinessFlowOf,
} from "../src/services/transactionFlow.js";

test("Type A is inferred only from an assigned partner", () => {
  const tx = normalizeTransactionBusinessFlow({
    id: "a", type: "buy", direct: false, ownMoney: false, partnerId: "p-1",
  });
  assert.equal(tx.businessFlow, TRANSACTION_BUSINESS_FLOW.PARTNER_CUSTODY);
  assert.equal(receiptRecipientRoleForTransaction(tx), "partner");
});

test("Type B is the existing paired direct trade and is owner-only", () => {
  const buy = normalizeTransactionBusinessFlow({
    id: "b-buy", type: "buy", direct: true, ownMoney: true, partnerId: null,
    pairId: "pair-b", directRole: "buy",
  });
  const sell = normalizeTransactionBusinessFlow({
    id: "b-sell", type: "sell", direct: true, ownMoney: true, partnerId: null,
    pairId: "pair-b", directRole: "sell",
  });
  assert.equal(buy.businessFlow, TRANSACTION_BUSINESS_FLOW.OWNER_CASHBOX);
  assert.equal(sell.businessFlow, TRANSACTION_BUSINESS_FLOW.OWNER_CASHBOX);
  assert.equal(isOwnerCashboxFlow(buy), true);
  assert.equal(receiptRecipientRoleForTransaction(buy), null);
});

test("Type C preserves the ordinary transaction behaviour", () => {
  const tx = normalizeTransactionBusinessFlow({
    id: "c", type: "buy", direct: false, ownMoney: false, partnerId: null,
  });
  assert.equal(tx.businessFlow, TRANSACTION_BUSINESS_FLOW.STANDARD);
  assert.equal(isOwnerCashboxFlow(tx), false);
});

test("legacy rows derive the same A/B/C label without a migration-only field", () => {
  assert.equal(transactionBusinessFlowOf({ direct: true }), "owner_cashbox");
  assert.equal(transactionBusinessFlowOf({ direct: false, partner_id: "p" }), "partner_custody");
  assert.equal(transactionBusinessFlowOf({}), "standard");
});

test("the client refuses contradictory or incomplete flow signals before RPC", () => {
  assert.throws(() => normalizeTransactionBusinessFlow({
    type: "buy", direct: false, ownMoney: false, partnerId: "p", businessFlow: "standard",
  }), /یەک ناگرێتەوە/);
  assert.throws(() => normalizeTransactionBusinessFlow({
    type: "buy", direct: true, ownMoney: false, pairId: "pair", directRole: "buy",
  }), /پارەی خاوەن/);
  assert.throws(() => normalizeTransactionBusinessFlow({
    type: "sell", direct: true, ownMoney: true, pairId: "pair", directRole: "buy",
  }), /پێکەوە نەبەستراون/);
});

test("the additive database contract enforces A/B/C and structured receipt routing", () => {
  const sql = fs.readFileSync(new URL(
    "../supabase/migrations/202608180001_transaction_business_flows.sql", import.meta.url,
  ), "utf8");
  for (const required of [
    "business_flow", "partner_custody", "owner_cashbox", "standard",
    "enforce_transaction_business_flow", "assert_owner_cashbox_pair",
    "create_transaction_receipt_assignment", "receipt_extractions add column if not exists platform",
    "has_fee boolean", "customer_sells_to_zeman", "v_to:=v_a.partner_id",
    "receipt_custody_ledger", "security_invoker=true",
    "normalize_receipt_intake_business_fields", "enforce_receipt_batch_transaction_flow",
    "a receipt batch cannot create one half of an owner-cashbox trade",
    "Type A receipt requires recipient, date, WeChat/Alipay platform, and fee status",
    "v_receipt_batch_structured_details", "v_partner_trade_custody",
  ]) assert.match(sql, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(sql, /drop\s+(?:table|column)\b|delete\s+from\b/i,
    "the migration must not remove a table, field, or row");
});
