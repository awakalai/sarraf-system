import test from "node:test";
import assert from "node:assert/strict";
import { convertReceiptBatchToTransaction } from "../src/services/receiptOperations.js";

const stub = ({ convert, finish } = {}) => {
  const calls = [];
  return {
    calls,
    rpc(fn, args) {
      calls.push({ fn, args });
      if (fn === "sarraf_convert_receipt_batch_to_transaction") {
        return Promise.resolve(convert ?? { data: { transactions: [{ id: "tx-1" }] }, error: null });
      }
      if (fn === "sarraf_convert_receipt_batch_finish") {
        return Promise.resolve(finish ?? { data: { ledger_rows: 2 }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
};

const args = {
  batchId: "b-1",
  receiptIds: ["r-1", "r-2"],
  transaction: { id: "tx-1", type: "buy", cur_id: "cny", amount: 3400 },
  reason: "converting the accepted receipts",
};

// The owner's report: a yuan receipt becomes a purchase, so yuan must go up and dollars down.
test("the money movement is confirmed after the conversion", async () => {
  const c = stub();
  const out = await convertReceiptBatchToTransaction(c, args);
  assert.deepEqual(c.calls.map((x) => x.fn),
    ["sarraf_convert_receipt_batch_to_transaction", "sarraf_convert_receipt_batch_finish"]);
  assert.equal(c.calls[1].args.p_tx_id, "tx-1");
  assert.equal(out.ledger_confirmed, true);
  assert.equal(out.ledger_rows, 2);
});

test("the transaction id is found whichever shape the server answers in", async () => {
  for (const data of [
    { transactions: [{ id: "tx-9" }] },
    { transaction: { id: "tx-9" } },
    { tx_id: "tx-9" },
  ]) {
    const c = stub({ convert: { data, error: null } });
    await convertReceiptBatchToTransaction(c, args);
    assert.equal(c.calls[1]?.args.p_tx_id, "tx-9", `shape ${JSON.stringify(data)} was not understood`);
  }
});

// A conversion that queued for approval has no transaction yet; there is nothing to move.
test("an approval-queued conversion does not try to move money", async () => {
  const c = stub({ convert: { data: { approval_required: true, approval_id: "ap-1" }, error: null } });
  const out = await convertReceiptBatchToTransaction(c, args);
  assert.equal(c.calls.length, 1, "no movement should be attempted");
  assert.equal(out.approval_required, true);
});

// The conversion has already committed by this point. Losing it because the confirmation call
// failed would be worse than the failure itself.
test("a failed confirmation reports itself without discarding the conversion", async () => {
  const c = stub({ finish: { data: null, error: { message: "connection lost" } } });
  const out = await convertReceiptBatchToTransaction(c, args);
  assert.equal(out.ledger_confirmed, false);
  assert.equal(out.transactions[0].id, "tx-1", "the conversion result survives");
  assert.match(out.ledger_error, /connection lost/);
});

test("a refused conversion is raised, never reported as done", async () => {
  const c = stub({ convert: { data: null, error: { message: "receipt batch is not verified for conversion" } } });
  await assert.rejects(() => convertReceiptBatchToTransaction(c, args));
});

// ── what the command refuses before it ever reaches the server ────────────────

test("a conversion with no receipts is refused locally", async () => {
  const c = stub();
  await assert.rejects(() => convertReceiptBatchToTransaction(c, { ...args, receiptIds: [] }));
  assert.equal(c.calls.length, 0);
});

test("a conversion with no batch is refused", async () => {
  const c = stub();
  await assert.rejects(() => convertReceiptBatchToTransaction(c, { ...args, batchId: "" }));
  assert.equal(c.calls.length, 0);
});

test("a reason shorter than the server's minimum is refused locally", async () => {
  const c = stub();
  await assert.rejects(() => convertReceiptBatchToTransaction(c, { ...args, reason: "ok" }));
  assert.equal(c.calls.length, 0);
});

test("a conversion always carries a command key, so a retry cannot convert twice", async () => {
  const c = stub();
  await convertReceiptBatchToTransaction(c, args);
  assert.ok(c.calls[0].args.p_command_key, "the conversion must be idempotent");
});
