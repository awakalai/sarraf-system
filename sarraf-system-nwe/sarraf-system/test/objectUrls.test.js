import test from "node:test";
import assert from "node:assert/strict";
import { revokeAllUrls, revokeDroppedUrls } from "../src/services/objectUrls.js";

const spy = () => { const seen = []; const fn = (u) => seen.push(u); fn.seen = seen; return fn; };
const row = (id, url) => ({ id, url });

test("a removed row's image is released", () => {
  const revoke = spy();
  const dropped = revokeDroppedUrls(
    [row("a", "blob:1"), row("b", "blob:2")],
    [row("a", "blob:1")],
    revoke,
  );
  assert.deepEqual(dropped, ["blob:2"]);
  assert.deepEqual(revoke.seen, ["blob:2"]);
});

// Replacing a row's image is the other way a URL becomes garbage.
test("a replaced image releases the old one and keeps the new", () => {
  const revoke = spy();
  revokeDroppedUrls([row("a", "blob:old")], [row("a", "blob:new")], revoke);
  assert.deepEqual(revoke.seen, ["blob:old"]);
});

test("a row that did not change releases nothing", () => {
  const revoke = spy();
  revokeDroppedUrls([row("a", "blob:1")], [row("a", "blob:1")], revoke);
  assert.deepEqual(revoke.seen, []);
});

// The failure that would be worst: revoking a URL still on screen, blanking a live image.
test("a URL still present under another row is never revoked", () => {
  const revoke = spy();
  revokeDroppedUrls(
    [row("a", "blob:shared"), row("b", "blob:shared")],
    [row("b", "blob:shared")],
    revoke,
  );
  assert.deepEqual(revoke.seen, [], "a URL another row still uses must survive");
});

test("reordering rows releases nothing", () => {
  const revoke = spy();
  revokeDroppedUrls([row("a", "blob:1"), row("b", "blob:2")], [row("b", "blob:2"), row("a", "blob:1")], revoke);
  assert.deepEqual(revoke.seen, []);
});

test("clearing the list releases every image", () => {
  const revoke = spy();
  revokeDroppedUrls([row("a", "blob:1"), row("b", "blob:2")], [], revoke);
  assert.deepEqual(revoke.seen.sort(), ["blob:1", "blob:2"]);
});

test("unmounting releases everything still held", () => {
  const revoke = spy();
  revokeAllUrls([row("a", "blob:1"), row("b", "blob:2")], revoke);
  assert.equal(revoke.seen.length, 2);
});

// Only URLs this app minted; a remote or signed URL is not ours to revoke.
test("a remote or signed URL is left alone", () => {
  const revoke = spy();
  revokeDroppedUrls(
    [row("a", "https://storage.example/receipt.jpg"), row("b", "blob:mine")],
    [],
    revoke,
  );
  assert.deepEqual(revoke.seen, ["blob:mine"]);
});

test("rows without an image are handled without error", () => {
  const revoke = spy();
  revokeDroppedUrls([{ id: "a" }, null, row("b", "blob:1")], [{ id: "a" }], revoke);
  assert.deepEqual(revoke.seen, ["blob:1"]);
});

test("empty and missing lists are not an error", () => {
  const revoke = spy();
  assert.deepEqual(revokeDroppedUrls(null, null, revoke), []);
  assert.deepEqual(revokeDroppedUrls([], [row("a", "blob:1")], revoke), []);
});

// A revoke that throws must not take the state update down with it.
test("a failing revoke does not stop the rest being released", () => {
  const seen = [];
  const revoke = (u) => { seen.push(u); if (u === "blob:1") throw new Error("already revoked"); };
  const dropped = revokeDroppedUrls([row("a", "blob:1"), row("b", "blob:2")], [], revoke);
  assert.equal(seen.length, 2);
  assert.equal(dropped.length, 2);
});
