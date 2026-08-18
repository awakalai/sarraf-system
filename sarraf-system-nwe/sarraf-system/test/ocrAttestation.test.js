import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// The reader's digest, lifted out of api/read-receipt.js so the two cannot drift apart without
// this file failing. The database computes the same thing in sarraf_extraction_digest; if the
// two ever disagree, every attested receipt is refused, so the agreement is checked here rather
// than discovered in production.
const source = readFileSync(new URL("../api/read-receipt.js", import.meta.url), "utf8");
const sql = readFileSync(
  new URL("../supabase/migrations/202608180007_ocr_attestation.sql", import.meta.url), "utf8");

const sha256Hex = (v) => createHash("sha256").update(v).digest("hex");

function extractionDigest(fields) {
  const amount = (v) => {
    if (v === null || v === undefined || v === "") return "";
    const n = Number(v);
    if (!Number.isFinite(n)) return "";
    let s = n.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
    if (s === "-0") s = "0";
    return s;
  };
  const text = (v) => String(v ?? "").trim();
  return sha256Hex([
    amount(fields.amount), amount(fields.fee), amount(fields.net_amount),
    text(fields.currency).toUpperCase(), text(fields.ref_no), text(fields.merchant_order_no),
    text(fields.tx_date), text(fields.receiver), text(fields.sender),
  ].join("|"));
}

const reading = {
  amount: 1200, fee: 0, net_amount: 1200, currency: "CNY",
  ref_no: "REF-9001", merchant_order_no: "ORD-77001", tx_date: "2026-08-01",
  receiver: "ئەحمەد", sender: "من",
};

// ── the two implementations must stay the same implementation ────────────────

test("the reader and the database digest the same nine fields, in the same order", () => {
  const order = ["amount", "fee", "net_amount", "currency", "ref_no",
    "merchant_order_no", "tx_date", "receiver", "sender"];
  const inSql = [...sql.matchAll(/p_extraction->>'([a-z_]+)'/g)].map((m) => m[1]);
  // Each field appears once in the SQL digest, in this order.
  assert.deepEqual([...new Set(inSql)], order,
    "the database digests a different set or order of fields than the reader");
  const inJs = [...source.matchAll(/fields\.([a-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(inJs)], order,
    "the reader digests a different set or order of fields than the database");
});

test("the database normalises amounts with trim_scale, as the reader does", () => {
  assert.match(sql, /trim_scale\(nullif\(p_extraction->>'amount',''\)::numeric\)/);
  assert.match(source, /toFixed\(10\)\.replace\(\/0\+\$\/, ""\)/);
});

test("the currency is the only field either side case-folds", () => {
  assert.match(sql, /upper\(coalesce\(btrim\(p_extraction->>'currency'\), ''\)\)/);
  assert.match(source, /text\(fields\.currency\)\.toUpperCase\(\)/);
  // A payee's name is part of the reading and must not be folded.
  assert.doesNotMatch(sql, /upper\(coalesce\(btrim\(p_extraction->>'receiver'\)/);
});

// ── what the digest is for ───────────────────────────────────────────────────

// The owner's report: "1200 came to me, the image says so. How can they edit it and make it
// more?" Removing the edit control was a screen. This is the rule.
test("changing the amount changes the digest", () => {
  assert.notEqual(extractionDigest(reading), extractionDigest({ ...reading, amount: 12000 }));
});

test("every field is part of the digest, so none of them can be quietly changed", () => {
  const base = extractionDigest(reading);
  const changes = {
    amount: 1, fee: 1, net_amount: 1, currency: "USD", ref_no: "X",
    merchant_order_no: "X", tx_date: "2026-01-01", receiver: "X", sender: "X",
  };
  for (const [field, value] of Object.entries(changes)) {
    assert.notEqual(extractionDigest({ ...reading, [field]: value }), base,
      `${field} can be changed without the digest noticing`);
  }
});

test("the same amount written differently is the same amount", () => {
  const base = extractionDigest(reading);
  for (const amount of [1200, "1200", "1200.00", 1200.0, "1200.000000"]) {
    assert.equal(extractionDigest({ ...reading, amount }), base, `${amount} digested differently`);
  }
});

// 1200 and 12000 must never collapse to the same thing — the first attempt at this trimmed
// trailing zeros as text, which turned both into "12".
test("trailing zeros in the whole number are not trimmed away", () => {
  assert.notEqual(extractionDigest({ ...reading, amount: 1200 }),
    extractionDigest({ ...reading, amount: 12000 }));
  assert.notEqual(extractionDigest({ ...reading, amount: 100 }),
    extractionDigest({ ...reading, amount: 1000 }));
});

test("a missing figure is empty, not a zero", () => {
  assert.notEqual(extractionDigest({ ...reading, fee: null }), extractionDigest({ ...reading, fee: 0 }));
});

test("surrounding spaces are not part of a name", () => {
  assert.equal(extractionDigest({ ...reading, receiver: "  ئەحمەد  " }), extractionDigest(reading));
});

test("the digest is a sha-256 in hex, as the database column demands", () => {
  assert.match(extractionDigest(reading), /^[a-f0-9]{64}$/);
  assert.match(sql, /extraction_digest text not null[\s\S]*?check \(extraction_digest ~ '\^\[a-f0-9\]\{64\}\$'\)/);
});

// ── the reading is used once, by the person it was issued to ─────────────────

test("every way a reading can be wrong is refused by name", () => {
  for (const refusal of [
    /already been used for another receipt/,
    /has expired/,
    /belongs to someone else/,
    /is of a different image/,
    /do not match what the reader read/,
    /was not issued by the receipt reader/,
  ]) {
    assert.match(sql, refusal, `the database does not refuse: ${refusal}`);
  }
});

test("no signed-in session can write an attestation", () => {
  assert.match(sql, /revoke all on function public\.sarraf_record_ocr_attestation[\s\S]*?authenticated/);
});

test("an attestation is never deleted", () => {
  assert.match(sql, /before delete on public\.ocr_attestations/);
});

// A mismatched attestation is tampering under any policy; only an absent one is a policy question.
test("requiring an attestation is a switch, but refusing a false one is not", () => {
  assert.match(sql, /add column if not exists require_attestation boolean not null default false/);
  assert.match(sql, /if coalesce\(v_require, false\) then[\s\S]*?carries no reading/);
});

test("only receipts that will count towards money are checked", () => {
  assert.match(sql, /if coalesce\(new\.status, ''\) <> 'ok' or not coalesce\(new\.counted, true\) then\s*\n\s*return new;/);
});
