import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const portal = fs.readFileSync(new URL("../src/components/portal/PortalFoundation.jsx", import.meta.url), "utf8");

test("ordinary customer and partner portals use the simplified receipt intake", () => {
  assert.match(app, /ReceiptUploader customerId=[\s\S]{0,260}\bsimple\b/);
  assert.match(app, /ReceiptUploader partnerId=[\s\S]{0,260}\bsimple\b/);
  assert.match(app, /function ReceiptUploader\([^)]*simple = false/);
});

test("global operational search is rendered only for the real admin shell", () => {
  assert.match(app, /!portalUser && isAdmin && <OperationalPalette/);
});

test("healthy portal data status stays quiet while offline and stale states remain visible", () => {
  assert.match(portal, /if \(state === "live"\) return null/);
  assert.match(portal, /state = !online \? "offline" : refreshing \? "refreshing" : stale \? "stale" : "live"/);
});
