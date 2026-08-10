import test from "node:test";
import assert from "node:assert/strict";
import { classifyReceiptSet, receiptIdentity, validateReceiptArithmetic } from "../src/services/receiptValidation.js";
import { verifiedFishReceipts } from "./fixtures/verified-fish-receipts.js";

test("all supplied receipt calculations reconcile to the visible gross, fee, and net values", () => {
  const classified = classifyReceiptSet(verifiedFishReceipts);
  assert.deepEqual(classified.filter((item) => !item.validation.valid), []);
  assert.equal(classified.reduce((sum, item) => sum + (item.duplicate ? 0 : item.validation.gross), 0), 13622.65);
  assert.equal(classified.reduce((sum, item) => sum + (item.duplicate ? 0 : item.validation.fee), 0), 367.65);
  assert.equal(classified.reduce((sum, item) => sum + (item.duplicate ? 0 : item.validation.netAmount), 0), 13255.00);
});

test("the ten supplied images resolve to nine unique transactions", () => {
  const classified = classifyReceiptSet(verifiedFishReceipts);
  assert.equal(classified.filter((item) => !item.duplicate).length, 9);
  assert.deepEqual(classified.filter((item) => item.duplicate).map((item) => [item.id, item.duplicateOf]), [["r10", "r5"]]);
});

test("same amount does not create a false duplicate when order numbers differ", () => {
  const sameAmount = verifiedFishReceipts.filter((item) => item.amount === 1261.75);
  assert.equal(new Set(sameAmount.map(receiptIdentity)).size, 3);
  assert.equal(classifyReceiptSet(sameAmount).filter((item) => item.duplicate).length, 0);
});

test("mismatched arithmetic is held for review", () => {
  const result = validateReceiptArithmetic({ amount: 100, fee: 3, orderAmount: 90, netAmount: 90 });
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues, ["gross_order_fee_mismatch"]);
});
