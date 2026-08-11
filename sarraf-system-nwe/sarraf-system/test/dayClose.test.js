import test from "node:test";
import assert from "node:assert/strict";
import {
  DIFF_EPSILON, REASON_MIN, differenceByCurrency, differingLines,
  dayCloseMessage, hasDifference, lineHasDifference, validateDayClose,
} from "../src/services/dayClose.js";

const line = (over = {}) => ({ cur: "iqd", code: "IQD", expected: 1000, counted: 1000, diff: 0, ...over });

test("a clean count needs no reason", () => {
  const r = validateDayClose({ lines: [line(), line({ cur: "usd", code: "USD" })], note: "" });
  assert.equal(r.ok, true);
  assert.equal(r.reasonRequired, false);
});

// The defect: a safe short by 400,000 could be closed in silence, and nobody could ever
// find out why.
test("a difference cannot be closed without a reason", () => {
  const r = validateDayClose({ lines: [line({ counted: 600, diff: -400 })], note: "" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "reason_required");
  assert.notEqual(dayCloseMessage(r.code), r.code, "the operator must be told why");
});

test("a reason shorter than the minimum is still refused", () => {
  const r = validateDayClose({ lines: [line({ counted: 600, diff: -400 })], note: "کەم" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "reason_required");
});

test("whitespace is not a reason", () => {
  const r = validateDayClose({ lines: [line({ counted: 600, diff: -400 })], note: "          " });
  assert.equal(r.ok, false);
});

test("a real reason lets the close through", () => {
  const r = validateDayClose({
    lines: [line({ counted: 600, diff: -400 })],
    note: "خەرجی تۆمار نەکراو بۆ گواستنەوە",
  });
  assert.equal(r.ok, true);
  assert.equal(r.reasonRequired, true);
});

test("an overage needs a reason just as a shortage does", () => {
  assert.equal(validateDayClose({ lines: [line({ counted: 1400, diff: 400 })], note: "" }).ok, false);
});

test("a close with nothing counted is refused", () => {
  const r = validateDayClose({ lines: [line({ counted: null, diff: 0 })], note: "" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "nothing_counted");
});

test("no lines at all is refused rather than treated as a clean day", () => {
  assert.equal(validateDayClose({ lines: [], note: "" }).ok, false);
  assert.equal(validateDayClose({}).ok, false);
});

// Rounding must not masquerade as a discrepancy and demand an explanation for nothing.
test("a rounding-sized difference is not a difference", () => {
  assert.equal(lineHasDifference(line({ diff: DIFF_EPSILON / 2 })), false);
  assert.equal(validateDayClose({ lines: [line({ diff: DIFF_EPSILON / 2 })], note: "" }).ok, true);
});

test("a difference just above the threshold does count", () => {
  assert.equal(lineHasDifference(line({ diff: DIFF_EPSILON * 10 })), true);
});

test("a non-numeric difference is treated as none, not as NaN", () => {
  assert.equal(lineHasDifference(line({ diff: "not a number" })), false);
  assert.equal(hasDifference([line({ diff: null }), line({ diff: undefined })]), false);
});

test("one differing currency among many is enough to require a reason", () => {
  const lines = [line(), line({ cur: "usd", code: "USD" }), line({ cur: "cny", code: "CNY", diff: -5 })];
  assert.equal(hasDifference(lines), true);
  assert.equal(differingLines(lines).length, 1);
});

// Currencies are never added together; each is reported on its own.
test("differences are reported per currency, never summed across them", () => {
  const out = differenceByCurrency([
    line({ code: "IQD", diff: -400 }),
    line({ code: "IQD", diff: -100 }),
    line({ code: "USD", diff: 20 }),
    line({ code: "CNY", diff: 0 }),
  ]);
  assert.deepEqual(out, { IQD: -500, USD: 20 });
});

test("the reason minimum matches what the database asks for", () => {
  assert.equal(REASON_MIN, 8);
});
