import test from "node:test";
import assert from "node:assert/strict";
import { validateCommand } from "../api/receipt-ingestion.js";

const batchId = "12345678-1234-1234-1234-123456789abc";
const receipt = (overrides = {}) => ({
  id: "receipt-1",
  batch_id: batchId,
  amount: 100,
  fee: 2,
  currency: "CNY",
  status: "ok",
  image_path: `ingest/${batchId}/receipt-1.jpg`,
  ...overrides,
});
const command = (overrides = {}) => ({
  p_batch: { id: batchId, direction: "in", currency: "CNY" },
  p_receipts: [receipt()],
  p_command_key: `receipt-ingest:${batchId}`,
  ...overrides,
});

test("receipt recovery validates the same bounded identity and object path contract", () => {
  const parsed = validateCommand(command());
  assert.equal(parsed.batch.id, batchId);
  assert.equal(parsed.receipts[0].image_path, `ingest/${batchId}/receipt-1.jpg`);
  assert.equal(parsed.receipts[0].amount, 100);
  assert.equal(parsed.receipts[0].net_amount, 98);
});

test("receipt recovery derives net amount instead of trusting browser totals", () => {
  const parsed = validateCommand(command({ p_receipts: [receipt({ net_amount: 999999 })] }));
  assert.equal(parsed.receipts[0].net_amount, 98);
});

test("receipt recovery rejects mixed currencies before financial rows are written", () => {
  assert.throws(() => validateCommand(command({
    p_receipts: [receipt(), receipt({ id: "receipt-2", currency: "USD", image_path: `ingest/${batchId}/receipt-2.jpg` })],
  })), (error) => error.code === "mixed_currency" && error.status === 400);
});

test("receipt recovery rejects a path outside the exact command folder", () => {
  assert.throws(() => validateCommand(command({
    p_receipts: [receipt({ image_path: "someone-else/receipt-1.jpg" })],
  })), (error) => error.code === "invalid_path" && error.status === 400);
});
