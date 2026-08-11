/**
 * Durable, upload-first receipt intake (§5).
 *
 * The old order was: read the image, hold everything in React state, write only when the user
 * pressed send. An OCR failure, a dropped connection or a reload in between lost the receipt
 * and told the customer the submission had failed, with nothing kept.
 *
 * The order here is inverted. A slot is claimed, the bytes are stored, and only then is the
 * receipt read. From the moment storage confirms, a later failure can degrade the reading but
 * can no longer lose the evidence — which is the whole point.
 */

const newId = () =>
  (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
    .replace(/[^A-Za-z0-9-]/g, "").slice(0, 60);

export const RECEIPT_FLOWS = Object.freeze({
  customerSells: "customer_sells_to_zeman",
  customerBuys: "customer_buys_from_zeman",
});

/** Progress a caller can render honestly: each value is a fact about the server, not a guess. */
export const INTAKE_STAGE = Object.freeze({
  claiming: "claiming",
  uploading: "uploading",
  stored: "stored",
  reading: "reading",
  done: "done",
  readFailed: "read_failed",
  uploadFailed: "upload_failed",
});

export class ReceiptIntakeError extends Error {
  constructor(stage, cause, evidenceKept) {
    super(
      evidenceKept
        ? "وێنەکە بە سەلامەتی گەیشت، بەڵام خوێندنەوەکە سەرکەوتوو نەبوو — فیشەکە ون نەبووە"
        : "وێنەکە نەگەیشت — تکایە دووبارە هەوڵ بدەوە"
    );
    this.name = "ReceiptIntakeError";
    this.stage = stage;
    this.cause = cause;
    // The distinction the customer actually needs: is my receipt safe or not?
    this.evidenceKept = evidenceKept;
    this.code = cause?.code || null;
  }
}

/**
 * Runs one image through intake. `readImage` is called only after the bytes are stored, and
 * its failure never removes what was stored.
 *
 * @returns {Promise<{documentId: string, state: string, storagePath: string, extraction: object|null}>}
 */
export async function intakeReceipt({
  client, blob, mediaType = "image/jpeg", flow, customerId = null, partnerId = null,
  transactionId = null, batchId = null, expectedCurrency = null,
  sha256 = null, readImage = null, documentId = null, onStage = () => {},
}) {
  const id = documentId || newId();
  let path = null;

  // 1. Claim the slot. The server decides whether this uploader may supply this flow at all,
  //    and hands back the one path the bytes are allowed to go to.
  onStage(INTAKE_STAGE.claiming, { documentId: id });
  const claim = await client.rpc("sarraf_receipt_intake_begin", {
    p_document_id: id,
    p_flow: flow,
    p_customer_id: customerId,
    p_partner_id: partnerId,
    p_transaction_id: transactionId,
    p_batch_id: batchId,
    p_expected_currency: expectedCurrency,
    p_mime_type: mediaType,
  });
  if (claim.error) throw new ReceiptIntakeError("claim", claim.error, false);
  path = claim.data?.storage_path;
  if (!path) throw new ReceiptIntakeError("claim", new Error("no storage path returned"), false);

  // 2. Store the bytes.
  onStage(INTAKE_STAGE.uploading, { documentId: id, storagePath: path });
  const upload = await client.storage.from("receipts").upload(path, blob, {
    contentType: mediaType, upsert: true,
  });
  if (upload.error && !/already exists|duplicate/i.test(String(upload.error.message || ""))) {
    throw new ReceiptIntakeError("upload", upload.error, false);
  }

  // 3. Confirm storage. Past this line the receipt cannot be lost.
  const stored = await client.rpc("sarraf_receipt_intake_stored", {
    p_document_id: id,
    p_image_sha256: sha256,
    p_byte_size: blob?.size ?? null,
  });
  if (stored.error) throw new ReceiptIntakeError("store", stored.error, false);
  onStage(INTAKE_STAGE.stored, { documentId: id, storagePath: path });

  if (typeof readImage !== "function") {
    return { documentId: id, state: stored.data?.state || "ocr_pending", storagePath: path, extraction: null };
  }

  // 4. Read it. A failure here is recorded against a receipt the server already holds.
  onStage(INTAKE_STAGE.reading, { documentId: id });
  let extraction = null;
  let readError = null;
  try {
    extraction = await readImage();
  } catch (e) {
    readError = e;
  }

  const record = await client.rpc("sarraf_receipt_intake_extracted", {
    p_document_id: id,
    p_ok: !readError && !!extraction,
    p_extraction: readError
      ? { error: String(readError?.code || readError?.message || "ocr_failed").slice(0, 80) }
      : toExtractionPayload(extraction),
    p_provider: extraction?._meta?.provider || null,
    p_model: extraction?._meta?.model || null,
  });
  if (record.error) throw new ReceiptIntakeError("record", record.error, true);

  if (readError) {
    onStage(INTAKE_STAGE.readFailed, { documentId: id, state: record.data?.state });
    // Deliberately not thrown: the evidence is safe and the receipt is recoverable, so this
    // is a degraded success rather than a failure the customer should be alarmed by.
    return { documentId: id, state: record.data?.state || "ocr_failed_retryable",
             storagePath: path, extraction: null, readError };
  }

  onStage(INTAKE_STAGE.done, { documentId: id, state: record.data?.state });
  return { documentId: id, state: record.data?.state, storagePath: path, extraction };
}

/** Map the reader's output onto the columns the extraction table records. */
export function toExtractionPayload(d) {
  if (!d || typeof d !== "object") return {};
  const str = (v) => (v == null || v === "" ? null : String(v));
  const netFromParts = () => {
    const gross = Number(d.amount), fee = Number(d.fee);
    if (!Number.isFinite(gross)) return null;
    return Math.max(0, Math.abs(gross) - (Number.isFinite(fee) ? Math.abs(fee) : 0));
  };
  return {
    grossAmount: str(d.amount != null ? Math.abs(Number(d.amount)) : null),
    orderAmount: str(d.orderAmount != null ? Math.abs(Number(d.orderAmount)) : null),
    feeAmount: str(d.fee != null ? Math.abs(Number(d.fee)) : null),
    // The reader does not classify fee treatment; recording "unknown" is honest, and a
    // guessed treatment would silently change what the equation is checked against.
    feeTreatment: d.orderAmount != null ? "added_on_top" : "unknown",
    netAmount: str(d.netAmount != null ? Math.abs(Number(d.netAmount)) : netFromParts()),
    currency: str(d.currency),
    refNo: str(d.refNo),
    merchantOrderNo: str(d.merchantOrderNo),
    payee: str(d.receiver || d.merchantName),
    txDate: str(d.txDate),
    txTime: str(d.txTime),
    confidence: str(d.confidence),
  };
}

/** An uploader's own receipts and where each one has got to. */
export async function loadMyIntakes(client, limit = 50) {
  const { data, error } = await client.rpc("sarraf_my_receipt_intakes", { p_limit: limit });
  if (error) throw error;
  return (data || []).map((r) => ({
    id: r.id,
    state: r.state,
    flow: r.flow,
    receivedAt: r.received_at,
    ocrAttempts: r.ocr_attempts ?? 0,
    reason: r.rule_reason,
  }));
}

/** Plain-language status for an uploader; never internal detail, never a false failure. */
export function intakeStatusText(state) {
  return {
    created: "ئامادەکردن...",
    uploading: "ناردنی وێنە...",
    uploaded: "وێنە گەیشت ✓",
    ocr_pending: "وێنە گەیشت — خوێندنەوە چاوەڕوانە",
    ocr_processing: "دەخوێندرێتەوە...",
    ocr_failed_retryable: "وێنە گەیشت — خوێندنەوە دووبارە هەوڵ دەدرێتەوە",
    parsed: "خوێندرایەوە",
    needs_manual_review: "لە پشکنینی ئەدمین",
    currency_mismatch: "دراوەکە لەگەڵ مامەڵەکە یەک ناگرێتەوە — لە پشکنیندایە",
    duplicate: "دووبارەیە",
    tamper_suspected: "گومانی دەستکاری — لە پشکنیندایە",
    validated: "پشتڕاستکرا",
    submitted: "نێردرا",
    matched: "بەستراوە",
    accepted: "پەسەندکرا ✓",
    rejected: "ڕەتکرایەوە",
    finalized: "تەواوکرا ✓",
    forwarded: "بۆ تۆ نێردرا",
    delivered: "گەیشت ✓",
    seen: "بینرا ✓",
    upload_failed_retryable: "وێنە نەگەیشت — دووبارە هەوڵ بدە",
    failed_terminal: "سەرکەوتوو نەبوو",
    cancelled: "هەڵوەشێنرایەوە",
  }[state] || state;
}
