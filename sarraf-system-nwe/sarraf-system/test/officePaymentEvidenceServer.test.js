import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sniffEvidence } from "../api/office-payment-evidence.js";

test("office evidence attestation detects real supported signatures", () => {
  assert.equal(sniffEvidence(Buffer.from("%PDF-1.7\n", "ascii")), "application/pdf");
  assert.equal(sniffEvidence(Buffer.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
  assert.equal(sniffEvidence(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "image/png");
  assert.equal(sniffEvidence(Buffer.from("RIFF0000WEBP", "ascii")), "image/webp");
  assert.equal(sniffEvidence(Buffer.from("MZ executable", "ascii")), null);
});

test("the browser supplies identity only and the server attests protected bytes", () => {
  const source = fs.readFileSync(new URL("../api/office-payment-evidence.js", import.meta.url), "utf8");
  assert.match(source, /\["assignmentId", "storagePath", "commandKey"\]/);
  assert.match(source, /download\(body\.storagePath\)/);
  assert.match(source, /createHash\("sha256"\)\.update\(bytes\)/);
  assert.match(source, /p_file_size: bytes\.length/);
  assert.match(source, /p_media_type: mediaType/);
  assert.doesNotMatch(source, /body\.(?:sha|hash|mediaType|fileSize)/);
});
