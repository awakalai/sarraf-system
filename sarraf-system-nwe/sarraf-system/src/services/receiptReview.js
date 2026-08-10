const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const reason = (value) => String(value || "").normalize("NFKC").trim().slice(0, 500);

export const RECEIPT_DECISIONS = Object.freeze(["accept", "reject", "correction"]);

export function createReceiptReviewCommand(kind, batchId, txId = "none") {
  if (![...RECEIPT_DECISIONS, "finalize", "policy"].includes(kind)) throw new Error("invalid receipt review command");
  const prefix = kind === "policy" ? "receipt-policy" : kind === "finalize" ? "receipt-finalize" : "receipt-decision";
  return `${prefix}:${String(batchId || "policy").slice(0, 80)}:${String(txId || "none").slice(0, 80)}:${id()}`;
}

export async function loadReceiptPolicy(client) {
  const { data, error } = await client.rpc("sarraf_receipt_policy");
  if (error) throw error;
  return {
    min_match_score: Number(data?.min_match_score) || 0,
    require_reason_below: Number(data?.require_reason_below) || 0,
    allow_reject: data?.allow_reject !== false,
    allow_correction: data?.allow_correction !== false,
    require_finalization: data?.require_finalization !== false,
    require_separate_finalizer: data?.require_separate_finalizer !== false,
    version: Number(data?.version) || 0,
    updated_at: data?.updated_at || null,
  };
}

export async function reviewReceiptBatch(client, { batchId, decision, txId = null, reviewReason = "", commandKey }) {
  if (!RECEIPT_DECISIONS.includes(decision)) throw new Error("invalid receipt decision");
  if (!batchId) throw new Error("receipt batch is required");
  if (decision === "accept" && !txId) throw new Error("transaction is required");
  const why = reason(reviewReason);
  if (decision !== "accept" && why.length < 8) throw new Error("an 8-character reason is required");
  const key = commandKey || createReceiptReviewCommand(decision, batchId, txId);
  const { data, error } = await client.rpc("sarraf_review_receipt_batch", {
    p_batch_id: batchId,
    p_decision: decision,
    p_tx_id: txId,
    p_reason: why || null,
    p_command_key: key,
  });
  if (error) throw error;
  return { result: data, commandKey: key };
}

export async function finalizeReceiptBatch(client, { batchId, finalizationReason, ownerOverride = false, commandKey }) {
  const why = reason(finalizationReason);
  if (!batchId) throw new Error("receipt batch is required");
  if (why.length < 8) throw new Error("an 8-character finalization reason is required");
  const key = commandKey || createReceiptReviewCommand("finalize", batchId);
  const { data, error } = await client.rpc("sarraf_finalize_receipt_batch", {
    p_batch_id: batchId,
    p_reason: why,
    p_owner_override: !!ownerOverride,
    p_command_key: key,
  });
  if (error) throw error;
  return { result: data, commandKey: key };
}

export async function updateReceiptPolicy(client, { policy, updateReason, commandKey }) {
  const why = reason(updateReason);
  if (why.length < 12) throw new Error("a 12-character policy reason is required");
  const key = commandKey || createReceiptReviewCommand("policy", "policy");
  const { data, error } = await client.rpc("sarraf_update_receipt_policy", {
    p_policy: policy,
    p_reason: why,
    p_command_key: key,
  });
  if (error) throw error;
  return { result: data, commandKey: key };
}
