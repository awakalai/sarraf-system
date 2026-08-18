import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const portal = fs.readFileSync(new URL("../src/components/portal/PortalFoundation.jsx", import.meta.url), "utf8");

test("customer and partner evidence enters a reviewable batch before any transaction exists", () => {
  assert.match(app, /ReceiptUploader customerId=\{user\.id\}[\s\S]{0,220}direction="in"[\s\S]{0,120}\bsimple\b/);
  assert.match(app, /ReceiptUploader partnerId=\{user\.id\}[\s\S]{0,180}direction="out" allowDirection/);
  assert.doesNotMatch(app, /ReceiptUploader transactionId=/);
  assert.match(app, /createReceiptIngestionCommand\(\)/);
  assert.doesNotMatch(app, /readReceiptAI/);
});

test("global operational search is rendered only for the real admin shell", () => {
  // OperationalPalette is lazy-loaded, so the admin gate and the element are separated by a
  // Suspense boundary. Assert the gate still guards it rather than one exact source shape.
  assert.match(app, /!portalUser && isAdmin &&[\s\S]{0,160}<OperationalPalette/);
  assert.doesNotMatch(app, /(?<!!portalUser && isAdmin &&[\s\S]{0,160})<OperationalPalette/);
});

test("healthy portal data status stays quiet while offline and stale states remain visible", () => {
  assert.match(portal, /if \(state === "live"\) return null/);
  assert.match(portal, /state = !online \? "offline" : refreshing \? "refreshing" : stale \? "stale" : "live"/);
});
