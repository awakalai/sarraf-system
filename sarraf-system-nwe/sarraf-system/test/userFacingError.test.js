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
