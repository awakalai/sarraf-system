import test from "node:test";
import assert from "node:assert/strict";
import { createHandoffContractModel, safeSharedFilename, SHARE_HANDOFF, sharedReceiptMessage, validateClaimedSharedFiles } from "../src/services/sharedReceiptHandoff.js";

test("handoffs are consumed once and concurrent claims cannot overwrite each other", () => {
  const model = createHandoffContractModel();
  model.stage("a", 100); model.stage("b", 100);
  const leaseA = model.claim("a", "tenant:user", 1);
  const leaseB = model.claim("b", "tenant:user", 1);
  assert.match(leaseA, /^a:/); assert.match(leaseB, /^b:/);
  assert.equal(model.claim("a", "tenant:user", 1), "consumed");
  assert.equal(model.finish("a", "wrong"), false);
  assert.equal(model.finish("a", leaseA), true);
  assert.equal(model.claim("a", "tenant:user", 1), "missing");
  assert.equal(model.has("b"), true);
});

test("expiry cleanup and owner binding prevent cross-user leakage", () => {
  const model = createHandoffContractModel();
  model.stage("expired", 10); model.stage("owned", 100);
  assert.equal(model.claim("expired", "one", 10), "expired");
  model.claim("owned", "one", 1);
  assert.equal(model.claim("owned", "two", 2), "forbidden");
  model.stage("abandoned", 5); model.cleanup(5);
  assert.equal(model.has("abandoned"), false);
});

test("shared contract uses generic attribution and conservative centralized limits", () => {
  assert.equal(SHARE_HANDOFF.source, "share");
  assert.equal(SHARE_HANDOFF.maxFiles, 10);
  assert.equal(SHARE_HANDOFF.maxFileBytes, 10 * 1024 * 1024);
  assert.equal(SHARE_HANDOFF.expiryMs, 15 * 60 * 1000);
  assert.equal(safeSharedFilename("../bad\0name.jpg"), ".._bad_name.jpg");
  assert.doesNotMatch(sharedReceiptMessage("ready"), /WhatsApp/i);
});

test("share import contract does not persist or link financial records", () => {
  const model = createHandoffContractModel();
  assert.equal("ingestReceiptBatch" in model, false);
  assert.equal("linkTransaction" in model, false);
  assert.equal("approveReceipt" in model, false);
});

test("application revalidates signatures and duplicate bytes before OCR", async () => {
  const image = (bytes, type, name) => { const blob = new Blob([Uint8Array.from(bytes)], { type }); Object.defineProperty(blob, "name", { value: name }); return blob; };
  const jpeg = image([0xff, 0xd8, 0xff, 1], "image/jpeg", "ok.jpg");
  const mismatch = image([0x89, 0x50, 0x4e, 0x47], "image/jpeg", "lie.jpg");
  const result = await validateClaimedSharedFiles([jpeg, jpeg, mismatch]);
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.rejected.map((item) => item.code), ["duplicate", "signature"]);
});
