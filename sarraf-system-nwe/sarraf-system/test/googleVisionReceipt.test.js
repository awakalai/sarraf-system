import test from "node:test";
import assert from "node:assert/strict";
import { parseGoogleVisionReceipt } from "../api/_google-vision-receipt.js";

test("Google Vision fallback extracts only explicit receipt signals", () => {
  const parsed = parseGoogleVisionReceipt(`Alipay\nTransaction Amount: -1,262.78 CNY\nInternational Card Fee: 37.88\nOrder No. 20260810123456\nStatus: Payment successful`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.amount, -1262.78);
  assert.equal(parsed.fee, 37.88);
  assert.equal(parsed.currency, "CNY");
  assert.equal(parsed.platform, "Alipay");
  assert.equal(parsed.refNo, "20260810123456");
  assert.ok(parsed.confidence < 0.8);
});

test("Google Vision fallback does not fabricate values from unrelated text", () => {
  const parsed = parseGoogleVisionReceipt("Welcome to ZEMAN\nBalance dashboard\nNo transaction selected");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.amount, null);
  assert.equal(parsed.currency, null);
  assert.equal(parsed.refNo, null);
});
