const safeMessage = (stage) => ({
  storage: "وێنەکە هەڵنەگیرا — Image upload failed.",
  finalize: "فیشەکان تۆمار نەکران — Receipt ingestion failed.",
  verify: "دۆخی ناردن نادیارە؛ هەمان ناردن دووبارە بکە — Submission status is unknown; retry safely.",
  cleanup: "پاککردنەوە تەواو نەبوو — Upload cleanup is incomplete.",
}[stage] || "ناردن سەرکەوتوو نەبوو — Submission failed.");

const commandId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export const createReceiptIngestionCommand = () => {
  const batchId = commandId();
  return { batchId, idempotencyKey: `receipt-ingest:${batchId}` };
};

export const receiptObjectPath = (batchId, receiptId) => `ingest/${batchId}/${receiptId}.jpg`;

export class ReceiptIngestionError extends Error {
  constructor(stage, cause, outcomeUnknown = false) {
    super(safeMessage(stage));
    this.name = "ReceiptIngestionError";
    this.stage = stage;
    this.outcomeUnknown = outcomeUnknown;
    this.cause = cause;
  }
}

/**
 * Stage only the command's exact objects, then atomically commit relational rows through the RPC.
 * Storage cannot participate in the SQL transaction; exact-path compensation is used on a known failure.
 */
export async function ingestReceiptBatch({ supabase, command, rows, makeBatch, makeReceipt, onPath }) {
  const paths = [];
  let rpcAttempted = false;
  const cleanup = async () => {
    if (!paths.length) return;
    const { error } = await supabase.storage.from("receipts").remove([...new Set(paths)]);
    if (error) throw new ReceiptIngestionError("cleanup", error, true);
  };

  try {
    const receipts = [];
    for (const row of rows) {
      let path = row.stagedPath || null;
      if (!path && row.blob) {
        path = receiptObjectPath(command.batchId, row.id);
        const { error } = await supabase.storage.from("receipts").upload(path, row.blob, {
          contentType: "image/jpeg", upsert: false,
        });
        if (error && !/already exists|duplicate/i.test(String(error.message || ""))) {
          throw new ReceiptIngestionError("storage", error);
        }
        onPath?.(row.id, path);
      }
      if (!path) throw new ReceiptIngestionError("storage", new Error("missing image"));
      paths.push(path);
      receipts.push(makeReceipt(row, path));
    }

    rpcAttempted = true;
    const { data, error } = await supabase.rpc("sarraf_ingest_receipt_batch", {
      p_batch: makeBatch(), p_receipts: receipts, p_command_key: command.idempotencyKey,
    });
    if (error) throw new ReceiptIngestionError("finalize", error);
    return { committed: true, data, paths };
  } catch (error) {
    const failure = error instanceof ReceiptIngestionError ? error : new ReceiptIngestionError("finalize", error);
    if (rpcAttempted) {
      const probe = await supabase.from("receipt_batches").select("id").eq("id", command.batchId).maybeSingle();
      if (!probe.error && probe.data?.id) return { committed: true, data: probe.data, paths };
      if (probe.error) throw new ReceiptIngestionError("verify", failure, true);
    }
    await cleanup();
    throw failure;
  }
}
