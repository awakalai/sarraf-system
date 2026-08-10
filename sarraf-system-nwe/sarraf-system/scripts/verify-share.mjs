import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const manifests = await Promise.all(["public/manifest.json", "app-files/public/manifest.json"].map(async (path) => JSON.parse(await readFile(path, "utf8"))));
assert.deepEqual(manifests[0].share_target, manifests[1].share_target);
assert.deepEqual(manifests[0].share_target.params.files[0].accept, ["image/jpeg", "image/png", "image/webp"]);

const workers = await Promise.all(["public/sw.js", "app-files/public/sw.js"].map((path) => readFile(path, "utf8")));
assert.equal(workers[0], workers[1], "mirrored workers differ");
assert.match(workers[0], /request\.formData\(\)/, "multipart POST is not parsed");
assert.match(workers[0], /form\.getAll\("receipts"\)/, "multiple-file field is not consumed");
const postHandler = workers[0].slice(workers[0].indexOf('if (event.request.method === "POST"'), workers[0].indexOf('if (event.request.method === "GET"'));
assert.doesNotMatch(postHandler, /caches\./, "share payload must not enter Cache API");

const source = await readFile("public/share-handoff-store.js", "utf8");
const context = { self: {}, crypto: webcrypto, Uint8Array, Array, Object, String, Date, Promise };
vm.runInNewContext(source, context);
const store = context.self.ZemanShareStore;
const file = (bytes, type, name = "receipt") => {
  const blob = new Blob([Uint8Array.from(bytes)], { type });
  Object.defineProperty(blob, "name", { value: name });
  return blob;
};
const jpeg = file([0xff, 0xd8, 0xff, 1], "image/jpeg", "../unsafe.jpg");
const png = file([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png");
const webp = file([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], "image/webp");
assert.equal((await store.validate([jpeg, png, webp])).accepted.length, 3);
assert.equal((await store.validate([file([0x89, 0x50], "image/jpeg")])).rejected[0].code, "signature");
assert.equal((await store.validate([file([1], "image/gif")])).rejected[0].code, "type");
assert.equal((await store.validate([file([], "image/png")])).rejected[0].code, "empty");
const oversized = file([1], "image/jpeg"); Object.defineProperty(oversized, "size", { value: store.MAX_FILE_BYTES + 1 });
assert.equal((await store.validate([oversized])).rejected[0].code, "oversize");
assert.equal((await store.validate([jpeg, jpeg])).rejected[0].code, "duplicate");
assert.equal((await store.validate([])).rejected[0].code, "missing");
assert.equal((await store.validate(Array(12).fill(png))).accepted.length, 1, "duplicates must not bypass count/duplicate limits");
assert.equal(store.EXPIRY_MS, 900000); assert.equal(store.MAX_FILES, 10); assert.equal(store.MAX_FILE_BYTES, 10485760);

const multipart = new FormData(); multipart.append("receipts", jpeg, "receipt.jpg");
const parsed = await new Request("https://zeman.invalid/receipt-share", { method: "POST", body: multipart }).formData();
assert.equal(parsed.getAll("receipts").length, 1, "multipart multiple-file field parsing failed");

for (const path of ["src/App.jsx", "src/services/sharedReceiptHandoff.js"]) {
  const text = await readFile(path, "utf8");
  assert.doesNotMatch(text, /onFiles\([^\n]+"whatsapp"/, "share source must remain generic");
}
const app = await readFile("src/App.jsx", "utf8");
assert.match(app, /await onFiles\(checked\.accepted, "share"\)/);
assert.match(app, /const send = async \(\) =>/, "explicit existing submission action was removed");
assert.doesNotMatch(source, /localStorage|caches\.|console\.|location|URLSearchParams/, "staged blobs leaked to a forbidden channel");
assert.match(workers[0], /IDENTITY_ASSETS/); assert.match(workers[0], /IDENTITY_CACHE/);
console.log("Phase E PWA share contract, validation, mirrors, and security invariants are valid.");
