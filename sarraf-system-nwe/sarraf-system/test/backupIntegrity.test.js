import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_FORMAT, VERDICT, canonicalJson, checksumOf, rehearseRestore,
  rowCounts, sealBackup, verdictText,
} from "../src/services/backupIntegrity.js";

const tables = () => ({
  txs: [{ id: "t1", amount: 100, cur: "IQD" }, { id: "t2", amount: 250, cur: "USD" }],
  app_users: [{ id: "u1", name: "کڕیار" }],
  ledger: [],
});

const sealed = async (t = tables()) => sealBackup({ tables: t, takenAt: "2026-08-13T10:00:00Z", takenBy: "u-owner" });

test("canonical form is independent of key order", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
  );
});

test("canonical form does not reorder arrays, because row order is data", () => {
  assert.notEqual(canonicalJson([{ a: 1 }, { a: 2 }]), canonicalJson([{ a: 2 }, { a: 1 }]));
});

test("the same data exported twice checksums the same", async () => {
  const a = await sealBackup({ tables: tables(), takenAt: "2026-08-13T10:00:00Z" });
  const b = await sealBackup({ tables: tables(), takenAt: "2026-08-14T22:31:00Z" });
  assert.equal(a.integrity.checksum, b.integrity.checksum,
    "a different export time must not change the checksum of identical data");
});

test("a single changed value changes the checksum", async () => {
  const t = tables();
  const before = await checksumOf(t);
  t.txs[0].amount = 101;
  assert.notEqual(await checksumOf(t), before);
});

test("an export carries its counts and its checksum", async () => {
  const b = await sealed();
  assert.equal(b.format, BACKUP_FORMAT);
  assert.deepEqual(b.counts, { txs: 2, app_users: 1, ledger: 0 });
  assert.equal(b.integrity.algorithm, "SHA-256");
  assert.equal(typeof b.integrity.checksum, "string");
});

test("counting an empty table gives 0, not a missing key", () => {
  assert.deepEqual(rowCounts({ a: [], b: null }), { a: 0, b: 0 });
});

// The rehearsal is the point: a backup nobody has read back is a backup nobody has tested.
test("a sealed export reads back as intact", async () => {
  const r = await rehearseRestore(JSON.stringify(await sealed()));
  assert.equal(r.verdict, VERDICT.ok);
  assert.equal(r.takenAt, "2026-08-13T10:00:00Z");
});

test("a tampered export is reported as corrupt, not accepted", async () => {
  const b = await sealed();
  b.tables.txs[0].amount = 999999;      // someone edited the file
  const r = await rehearseRestore(JSON.stringify(b));
  assert.equal(r.verdict, VERDICT.corrupt);
  assert.notEqual(r.checksum, r.expected);
});

test("a deleted row is caught even though the file still parses", async () => {
  const b = await sealed();
  b.tables.txs.pop();
  assert.equal((await rehearseRestore(JSON.stringify(b))).verdict, VERDICT.corrupt);
});

test("editing the stated checksum does not make a bad file pass", async () => {
  const b = await sealed();
  b.tables.txs[0].amount = 1;
  b.integrity.checksum = await checksumOf({ pretend: true });
  assert.equal((await rehearseRestore(JSON.stringify(b))).verdict, VERDICT.corrupt);
});

test("a file that is not JSON is reported, not thrown", async () => {
  assert.equal((await rehearseRestore("not json at all")).verdict, VERDICT.unreadable);
});

test("someone else's JSON file is refused", async () => {
  assert.equal((await rehearseRestore(JSON.stringify({ hello: "world" }))).verdict, VERDICT.wrongFormat);
});

test("an older export with no checksum says so rather than claiming to be verified", async () => {
  const b = await sealed();
  delete b.integrity;
  assert.equal((await rehearseRestore(JSON.stringify(b))).verdict, VERDICT.noChecksum);
});

// A drifted backup is old, not broken — and the difference is exactly what an operator needs.
test("an intact but stale export is reported as drifted, with what moved", async () => {
  const b = await sealed();
  const r = await rehearseRestore(JSON.stringify(b), { txs: 7, app_users: 1, ledger: 0 });
  assert.equal(r.verdict, VERDICT.drifted);
  assert.deepEqual(r.drift, [{ table: "txs", inFile: 2, inDatabase: 7 }]);
});

test("a drifted export is never reported as corrupt", async () => {
  const r = await rehearseRestore(JSON.stringify(await sealed()), { txs: 7 });
  assert.notEqual(r.verdict, VERDICT.corrupt);
  assert.equal(r.checksum, r.expected, "the file is still intact");
});

test("an export that matches the live database passes the rehearsal", async () => {
  const r = await rehearseRestore(JSON.stringify(await sealed()), { txs: 2, app_users: 1, ledger: 0 });
  assert.equal(r.verdict, VERDICT.ok);
  assert.deepEqual(r.drift, []);
});

test("a table the export never covered is not counted as drift", async () => {
  const r = await rehearseRestore(JSON.stringify(await sealed()),
    { txs: 2, app_users: 1, ledger: 0, some_new_table: 4000 });
  assert.equal(r.verdict, VERDICT.ok);
});

test("every verdict reads as something an operator can act on", () => {
  for (const v of Object.values(VERDICT)) {
    assert.notEqual(verdictText(v), v, `${v} needs plain-language text`);
  }
});
