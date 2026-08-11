import test from "node:test";
import assert from "node:assert/strict";
import {
  intakeReceipt, toExtractionPayload, intakeStatusText, INTAKE_STAGE, ReceiptIntakeError,
} from "../src/services/receiptIntake.js";

const stubClient = ({ rpc = {}, uploadError = null } = {}) => {
  const calls = { rpc: [], uploads: [] };
  return {
    calls,
    rpc(fn, args) {
      calls.rpc.push({ fn, args });
      if (rpc[fn]) return Promise.resolve(rpc[fn]);
      if (fn === "sarraf_receipt_intake_begin")
        return Promise.resolve({ data: { document_id: args.p_document_id, storage_path: `ingest/x/${args.p_document_id}.jpg` }, error: null });
      if (fn === "sarraf_receipt_intake_stored")
        return Promise.resolve({ data: { state: "ocr_pending" }, error: null });
      if (fn === "sarraf_receipt_intake_extracted")
        return Promise.resolve({ data: { state: "validated" }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    storage: {
      from() {
        return { upload(path, blob) { calls.uploads.push({ path, blob }); return Promise.resolve({ error: uploadError }); } };
      },
    },
  };
};

const blob = { size: 1234 };

test("the image is stored before the reader is ever called", async () => {
  const c = stubClient();
  const order = [];
  await intakeReceipt({
    client: c, blob, flow: "customer_sells_to_zeman", customerId: "c1", sha256: "a".repeat(64),
    readImage: async () => { order.push("read"); return { amount: 100, currency: "CNY" }; },
    onStage: (s) => order.push(s),
  });
  const storedAt = order.indexOf(INTAKE_STAGE.stored);
  const readAt = order.indexOf("read");
  assert.ok(storedAt >= 0 && readAt > storedAt,
    `the read must follow storage; order was ${order.join(" > ")}`);
});

// The defect the whole design exists to prevent.
test("a failed reading does not lose the receipt", async () => {
  const c = stubClient({ rpc: { sarraf_receipt_intake_extracted: { data: { state: "ocr_failed_retryable" }, error: null } } });
  const result = await intakeReceipt({
    client: c, blob, flow: "customer_sells_to_zeman", customerId: "c1",
    readImage: async () => { throw new Error("provider timeout"); },
  });
  assert.equal(c.calls.uploads.length, 1, "the image must still have been uploaded");
  assert.equal(result.state, "ocr_failed_retryable");
  assert.ok(result.readError, "the read failure is reported");
  assert.equal(result.documentId.length > 0, true, "the receipt keeps its identity");
});

test("a read failure is recorded against the server's copy, not swallowed", async () => {
  const c = stubClient();
  await intakeReceipt({
    client: c, blob, flow: "customer_sells_to_zeman", customerId: "c1",
    readImage: async () => { const e = new Error("boom"); e.code = "provider_429"; throw e; },
  });
  const record = c.calls.rpc.find((r) => r.fn === "sarraf_receipt_intake_extracted");
  assert.equal(record.args.p_ok, false);
  assert.equal(record.args.p_extraction.error, "provider_429");
});

test("an upload failure is reported as evidence NOT kept", async () => {
  const c = stubClient({ uploadError: { message: "network down" } });
  await assert.rejects(
    () => intakeReceipt({ client: c, blob, flow: "customer_sells_to_zeman", customerId: "c1" }),
    (e) => e instanceof ReceiptIntakeError && e.evidenceKept === false && e.stage === "upload"
  );
});

test("a refused claim never uploads anything", async () => {
  const c = stubClient({ rpc: { sarraf_receipt_intake_begin: { data: null, error: { code: "42501", message: "not authorized" } } } });
  await assert.rejects(
    () => intakeReceipt({ client: c, blob, flow: "customer_buys_from_zeman", customerId: "c1" }),
    (e) => e.stage === "claim" && e.evidenceKept === false
  );
  assert.equal(c.calls.uploads.length, 0, "nothing may be stored for a refused claim");
});

test("the same document id is reused so a retry cannot duplicate the receipt", async () => {
  const c = stubClient();
  const args = { client: c, blob, flow: "customer_sells_to_zeman", customerId: "c1", documentId: "doc-fixed" };
  await intakeReceipt({ ...args, readImage: async () => ({ amount: 1, currency: "CNY" }) });
  await intakeReceipt({ ...args, readImage: async () => ({ amount: 1, currency: "CNY" }) });
  const claims = c.calls.rpc.filter((r) => r.fn === "sarraf_receipt_intake_begin");
  assert.equal(claims.length, 2);
  assert.equal(claims[0].args.p_document_id, claims[1].args.p_document_id);
  assert.equal(c.calls.uploads[0].path, c.calls.uploads[1].path, "a retry writes to the same path");
});

test("the expected currency is sent so the server can refuse a mismatch", async () => {
  const c = stubClient();
  await intakeReceipt({
    client: c, blob, flow: "customer_sells_to_zeman", customerId: "c1", expectedCurrency: "CNY",
    readImage: async () => ({ amount: 1, currency: "CNY" }),
  });
  assert.equal(c.calls.rpc[0].args.p_expected_currency, "CNY");
});

test("the reader's output maps onto the extraction columns", () => {
  const p = toExtractionPayload({
    amount: -2520.41, fee: 73.41, orderAmount: 2447, netAmount: 2447,
    currency: "cny", refNo: "ORD-1", merchantOrderNo: "M-1", receiver: "Shop",
    txDate: "2026-08-04", txTime: "20:33:55", confidence: 0.91,
  });
  assert.equal(p.grossAmount, "2520.41", "a displayed minus sign is a direction, not a negative amount");
  assert.equal(p.orderAmount, "2447");
  assert.equal(p.feeAmount, "73.41");
  assert.equal(p.feeTreatment, "added_on_top");
  assert.equal(p.payee, "Shop");
  assert.equal(p.confidence, "0.91");
});

test("fee treatment is recorded as unknown rather than guessed", () => {
  const p = toExtractionPayload({ amount: 1258.66, fee: 36.66, currency: "CNY" });
  assert.equal(p.feeTreatment, "unknown",
    "without an order amount the treatment is not knowable and must not be invented");
  assert.equal(p.netAmount, "1222", "net still derives from gross minus fee");
});

test("an uploader is never told a stored receipt failed", () => {
  assert.match(intakeStatusText("ocr_failed_retryable"), /گەیشت/);
  assert.match(intakeStatusText("ocr_pending"), /گەیشت/);
  assert.match(intakeStatusText("upload_failed_retryable"), /نەگەیشت/);
  // Every state must have plain-language text; a raw enum must never reach a customer.
  for (const s of ["created", "uploaded", "validated", "accepted", "rejected", "delivered", "seen"]) {
    assert.notEqual(intakeStatusText(s), s, `state ${s} has no human text`);
  }
});

// The durable intake and the later ingest must resolve to ONE storage path per receipt.
// If these ever diverge, every image would be stored twice and the ingest would attach a
// different object than the one the reading was made from.
test("durable intake and ingest agree on the storage path", async () => {
  const { receiptObjectPath } = await import("../src/services/receiptIngestion.js");
  const fs = await import("node:fs");
  const sql = fs.readFileSync(
    new URL("../supabase/migrations/202608120007_receipt_intake_commands.sql", import.meta.url), "utf8");

  // The server builds: ingest/<batch>/<document>.jpg
  assert.match(sql, /format\('ingest\/%s\/%s\.jpg'/);
  assert.equal(receiptObjectPath("batch-1", "doc-1"), "ingest/batch-1/doc-1.jpg");

  // And the client passes the row id as the document id, and the ingest batch id as the batch.
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /documentId: id,/);
  assert.match(app, /batchId: receiptCommandRef\.current\?\.batchId/);
  // The batch command must be created before the intake runs, otherwise the two sides would
  // compute different batch ids and store the same image twice.
  const created = app.indexOf("receiptCommandRef.current ||= createReceiptIngestionCommand()");
  const called = app.indexOf("await durableIntake(");
  assert.ok(created > 0 && called > 0, "both the command creation and the intake call must exist");
  assert.ok(created < called,
    "the batch command must be created before durableIntake runs");
});

test("a deployment ahead of its migration falls back instead of refusing receipts", async () => {
  const fs = await import("node:fs");
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /PGRST202/, "a missing intake command must degrade to the legacy path");
  assert.match(app, /if \(notDeployed\) return \{ stored: false \}/);
  // But a genuine refusal must still surface.
  assert.match(app, /throw e;/);
});
