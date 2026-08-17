import test from "node:test";
import assert from "node:assert/strict";
import { userFacingServiceError } from "../src/services/userFacingError.js";

test("service errors never expose raw schema or authorization details", () => {
  const missing = userFacingServiceError({ code: "PGRST202", message: "Could not find the function public.secret_rpc in the schema cache" }, "ku");
  const denied = userFacingServiceError({ code: "42501", message: "admin integrity checks are not authorized" }, "en");
  assert.doesNotMatch(missing, /secret_rpc|schema cache/i);
  assert.match(missing, /database/i);
  assert.equal(denied, "You do not have permission to view this area.");
});

test("service error copy follows the active interface language", () => {
  assert.match(userFacingServiceError(new Error("Failed to fetch"), "ar"), /الخادم/);
  assert.match(userFacingServiceError(new Error("unexpected"), "en"), /could not be loaded/);
});

// The owner, holding a card that said only "the receipt summary could not load":
// "پوختەی فیشەکان بار نەبوو چییە ؟!" — what is that? There was nothing else on the screen and
// nothing to report. A failure nobody can describe is a failure nobody can fix.
test("an unrecognised failure keeps the friendly line and adds what the server said", () => {
  const out = userFacingServiceError(
    { code: "42703", message: 'column r.merchant_order_no does not exist' }, "ku", "پوختەی فیشەکان بار نەبوو");
  assert.match(out, /پوختەی فیشەکان بار نەبوو/, "the person still gets a sentence they understand");
  assert.match(out, /42703/, "and the code, so it can be reported");
  assert.match(out, /merchant_order_no/, "and the reason, so it can be found");
});

test("the failures that have their own wording keep it, with nothing appended", () => {
  const missing = userFacingServiceError({ code: "PGRST202", message: "could not find the function" }, "ku");
  const denied = userFacingServiceError({ code: "42501", message: "not authorized" }, "ku");
  const offline = userFacingServiceError({ message: "Failed to fetch" }, "ku");
  for (const [name, text] of [["missing", missing], ["denied", denied], ["offline", offline]]) {
    assert.doesNotMatch(text, /—/, `${name} should not carry a technical tail`);
  }
});

test("a failure with nothing to say does not end in a dash", () => {
  const out = userFacingServiceError({}, "ku", "بار نەبوو");
  assert.equal(out, "بار نەبوو");
});

test("a very long database message is cut rather than filling the screen", () => {
  const out = userFacingServiceError({ message: "x".repeat(900) }, "ku", "بار نەبوو");
  assert.ok(out.length < 260, `the message is ${out.length} characters long`);
});
