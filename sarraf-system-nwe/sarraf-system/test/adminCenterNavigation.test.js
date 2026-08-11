import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

const adminPages = [
  "action-inbox",
  "approvals",
  "close",
  "insights",
  "integrity",
  "audit",
  "export-audit",
  "backup",
];

test("the sidebar exposes one admin center instead of hiding admin features", () => {
  assert.match(app, /\["admin-center", navSectionLabel\("ناوەندی بەڕێوەبردن"/);
  assert.match(app, /function AdminCenterHub/);
  for (const page of adminPages) {
    assert.match(app, new RegExp(`\\["${page}"`), `${page} is missing from the admin center`);
  }
});

test("every admin center destination remains mounted and keeps the center navigation active", () => {
  assert.match(app, /id === "admin-center" \? ADMIN_CENTER_PAGE_IDS\.has\(page\)/);
  assert.match(app, /ADMIN_CENTER_PAGE_IDS\.has\(page\) && page !== "admin-center"/);
  for (const page of adminPages) {
    assert.match(app, new RegExp(`page === "${page}"`), `${page} route is no longer mounted`);
  }
});
