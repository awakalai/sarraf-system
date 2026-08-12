/**
 * Admin receipt review (§11.12, §11.13).
 *
 * Reads the durable intake introduced in phase 4: the document, every version of its
 * extraction, and its state history. The original reading is never overwritten — a correction
 * is a new version — so the workspace can always show what the OCR actually said alongside
 * what a human decided it meant.
 */

const upper = (v) => String(v ?? "").trim().toUpperCase();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

export const RECEIPT_REVIEW_STATES = [
  "needs_manual_review", "parsed", "validated", "submitted",
  "duplicate", "currency_mismatch", "tamper_suspected",
];

export async function loadReviewQueue(client, { states = RECEIPT_REVIEW_STATES, limit = 100 } = {}) {
  const { data, error } = await client
    .from("receipt_documents")
    .select("*")
    .in("state", states)
    .order("received_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(mapDocument);
}

const mapDocument = (d) => ({
  id: d.id,
  flow: d.flow,
  state: d.state,
  batchId: d.batch_id,
  transactionId: d.transaction_id,
  uploaderId: d.uploader_id,
  customerId: d.customer_id,
  partnerId: d.partner_id,
  storagePath: d.storage_path,
  imageHash: d.image_sha256,
  expectedCurrency: d.expected_currency,
  receivedAt: d.received_at,
  ocrAttempts: d.ocr_attempts ?? 0,
  lastErrorCode: d.last_error_code,
  counted: !!d.counted,
  ruleCode: d.rule_code,
  ruleReason: d.rule_reason,
});

export async function loadDocumentDetail(client, documentId) {
  const [doc, extractions, transitions] = await Promise.all([
    client.from("receipt_documents").select("*").eq("id", documentId).maybeSingle(),
    client.from("receipt_extractions").select("*").eq("document_id", documentId).order("version"),
    client.from("receipt_state_transitions").select("*").eq("document_id", documentId).order("created_at"),
  ]);
  if (doc.error) throw doc.error;
  if (extractions.error) throw extractions.error;
  if (transitions.error) throw transitions.error;
  if (!doc.data) throw new Error("receipt document not found");

  const versions = (extractions.data || []).map((e) => ({
    version: e.version,
    isOriginal: !!e.is_original,
    provider: e.provider,
    model: e.model,
    grossAmount: num(e.gross_amount),
    orderAmount: num(e.order_amount),
    feeAmount: num(e.fee_amount),
    feeTreatment: e.fee_treatment,
    netAmount: num(e.net_amount),
    currency: e.currency,
    refNo: e.ref_no,
    merchantOrderNo: e.merchant_order_no,
    payee: e.payee,
    txDate: e.tx_date,
    txTime: e.tx_time,
    confidence: num(e.confidence),
    correctedBy: e.corrected_by,
    correctionReason: e.correction_reason,
    correctedAt: e.corrected_at,
    raw: e.raw || {},
  }));

  return {
    document: mapDocument(doc.data),
    original: versions.find((v) => v.isOriginal) || versions[0] || null,
    current: versions[versions.length - 1] || null,
    versions,
    history: (transitions.data || []).map((t) => ({
      from: t.from_state, to: t.to_state, actorId: t.actor_id,
      reason: t.reason, at: t.created_at,
    })),
  };
}

/**
 * What a correction changed, field by field, so a reviewer sees the difference rather than
 * having to compare two blocks of numbers by eye.
 */
export function diffVersions(before, after) {
  if (!before || !after) return [];
  const fields = [
    ["grossAmount", "کۆی گشتی"], ["orderAmount", "بڕی بنەڕەتی"], ["feeAmount", "فی"],
    ["feeTreatment", "شێوازی فی"], ["netAmount", "نەت"], ["currency", "دراو"],
    ["refNo", "ژمارەی مامەڵە"], ["merchantOrderNo", "ژمارەی فرۆشیار"],
    ["payee", "وەرگر"], ["txDate", "بەروار"], ["txTime", "کات"],
  ];
  return fields
    .filter(([k]) => String(before[k] ?? "") !== String(after[k] ?? ""))
    .map(([k, label]) => ({ field: k, label, before: before[k] ?? null, after: after[k] ?? null }));
}

/**
 * The arithmetic a reviewer must be able to see at a glance, computed from the receipt's own
 * fee treatment rather than assumed. Returns null where the receipt does not state enough.
 */
export function reviewEquation(v) {
  if (!v) return null;
  const gross = v.grossAmount, order = v.orderAmount, fee = v.feeAmount ?? 0;
  const treatment = v.feeTreatment || "unknown";
  const minor = (x) => (x == null ? null : Math.round(x * 100));

  let expectedGross = null;
  if (order != null) {
    if (treatment === "added_on_top") expectedGross = order + fee;
    else if (treatment === "included_in_total") expectedGross = order;
    else if (treatment === "deducted_from_principal") expectedGross = order;
    else if (treatment === "no_fee") expectedGross = order;
  }
  const g = minor(gross), e = minor(expectedGross);
  return {
    treatment,
    gross, order, fee,
    net: v.netAmount,
    expectedGross,
    // One minor unit of tolerance; the comparison is in integers, never floats.
    reconciles: g == null || e == null ? null : Math.abs(g - e) <= 1,
    currency: upper(v.currency) || null,
  };
}

/** Move a document through the state machine. The database rejects an illegal transition. */
export async function transitionDocument(client, { documentId, toState, reason }) {
  const patch = { state: toState };
  if (toState === "rejected") {
    if (!reason || String(reason).trim().length < 8) {
      throw new Error("ڕەتکردنەوە پێویستی بە هۆکارێکی ٨ پیتی هەیە");
    }
    patch.rule_code = "manual_reject";
    patch.rule_reason = String(reason).trim().slice(0, 700);
  }
  const { error } = await client.from("receipt_documents").update(patch).eq("id", documentId);
  if (error) throw error;
  return { documentId, state: toState };
}

/**
 * Record a correction as a NEW extraction version. The original stays readable; the database
 * refuses an in-place edit and refuses a correction with no author or reason.
 */
export async function correctExtraction(client, { documentId, base, changes, reason, correctedBy }) {
  const why = String(reason ?? "").trim();
  if (why.length < 8) throw new Error("هۆکاری ڕاستکردنەوە دەبێت لانیکەم ٨ پیت بێت");
  if (!base) throw new Error("وەشانی بنەڕەتی نەدۆزرایەوە");
  if (!changes || Object.keys(changes).length === 0) throw new Error("هیچ گۆڕانکارییەک نییە");

  const { error } = await client.from("receipt_extractions").insert({
    document_id: documentId,
    version: (base.version || 0) + 1,
    is_original: false,
    gross_amount: changes.grossAmount ?? base.grossAmount,
    order_amount: changes.orderAmount ?? base.orderAmount,
    fee_amount: changes.feeAmount ?? base.feeAmount,
    fee_treatment: changes.feeTreatment ?? base.feeTreatment,
    net_amount: changes.netAmount ?? base.netAmount,
    currency: upper(changes.currency ?? base.currency) || null,
    ref_no: changes.refNo ?? base.refNo,
    merchant_order_no: changes.merchantOrderNo ?? base.merchantOrderNo,
    payee: changes.payee ?? base.payee,
    tx_date: changes.txDate ?? base.txDate,
    tx_time: changes.txTime ?? base.txTime,
    corrected_by: correctedBy,
    correction_reason: why,
    corrected_at: new Date().toISOString(),
  });
  if (error) throw error;
  return { documentId, version: (base.version || 0) + 1 };
}

/**
 * How the review queue stands (§11.13): how many are accepted, waiting, rejected, duplicate.
 *
 * Counts of documents — never money. §4.14 puts the totals of a batch in exactly one place, the
 * server's `sarraf_batch_summary`, so that the reviewer and the person who sent the receipts
 * cannot be shown two different answers. This function used to add up amounts per currency as
 * well; that made a second, browser-side set of figures which nothing displayed and which would
 * one day have been displayed. It is gone, and the count of accepted documents per currency
 * stays only so the footer can say what the queue holds.
 */
export function reviewTotals(documents, extractionByDoc = {}) {
  const out = { accepted: 0, pending: 0, rejected: 0, duplicate: 0, byCurrency: {} };
  for (const d of documents || []) {
    if (d.state === "rejected") { out.rejected += 1; continue; }
    if (d.state === "duplicate") { out.duplicate += 1; continue; }
    const counted = d.counted || ["accepted", "finalized", "forwarded", "delivered", "seen"].includes(d.state);
    if (!counted) { out.pending += 1; continue; }
    out.accepted += 1;
    const cur = upper(extractionByDoc[d.id]?.currency);
    if (!cur) continue;
    out.byCurrency[cur] = { count: (out.byCurrency[cur]?.count || 0) + 1 };
  }
  return out;
}
