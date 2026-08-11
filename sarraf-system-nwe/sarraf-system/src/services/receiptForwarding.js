/**
 * Receipt forwarding (§8) — client bindings.
 *
 * The server decides who may receive a document and refuses the wrong party, so nothing here
 * re-implements that rule. What this layer adds is the vocabulary the UI needs: which receipts
 * are eligible, what "skipped" means for each one, and the difference between sent, delivered
 * and seen — which §8.12 requires to stay three separate facts.
 */

const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export const forwardCommandKey = (subject = "batch") =>
  `receipt-forward:${String(subject).slice(0, 80)}:${id()}`;

/** Only these two states may leave; everything else is evidence still under decision. */
export const FORWARDABLE_STATES = Object.freeze(["accepted", "finalized"]);

/** Which role a flow sends to. Naming the other party is refused by the server. */
export const recipientRoleFor = (flow) =>
  flow === "customer_buys_from_zeman" ? "customer"
    : flow === "customer_sells_to_zeman" ? "partner"
      : null;

export const SKIP_REASON = Object.freeze({
  not_found: "نەدۆزرایەوە",
  needs_manual_review: "هێشتا لە پشکنیندایە",
  parsed: "هێشتا پشتڕاست نەکراوەتەوە",
  validated: "هێشتا پەسەند نەکراوە",
  submitted: "هێشتا پەسەند نەکراوە",
  rejected: "ڕەتکراوەتەوە",
  duplicate: "دووبارەیە",
  currency_mismatch: "دراوەکەی یەک ناگرێتەوە",
  tamper_suspected: "گومانی دەستکاری",
  forwarded: "پێشتر نێردراوە",
  delivered: "پێشتر گەیشتووە",
  seen: "پێشتر بینراوە",
  recipient_must_be_partner: "ئەم فیشە بۆ هاوبەش دەنێردرێت، نەک کڕیار",
  recipient_must_be_customer: "ئەم فیشە بۆ کڕیار دەنێردرێت، نەک هاوبەش",
});

export const skipReasonText = (reason) => SKIP_REASON[reason] || reason;

export const DELIVERY_TEXT = Object.freeze({
  queued: "لە ڕیزدایە",
  sent: "نێردرا",
  delivered: "گەیشت",
  seen: "بینرا",
  failed_retryable: "نەگەیشت — دووبارە هەوڵ دەدرێتەوە",
  failed_terminal: "نەگەیشت",
});
export const deliveryText = (status) => DELIVERY_TEXT[status] || status;

/** Documents an operator may forward right now, and why the rest cannot go. */
export function partitionForForwarding(documents, recipientRole = null) {
  const eligible = [];
  const blocked = [];
  for (const d of documents || []) {
    if (!FORWARDABLE_STATES.includes(d.state)) {
      blocked.push({ ...d, blockedBy: d.state });
      continue;
    }
    const wants = recipientRoleFor(d.flow);
    if (recipientRole && wants && wants !== recipientRole) {
      blocked.push({ ...d, blockedBy: wants === "partner" ? "recipient_must_be_partner" : "recipient_must_be_customer" });
      continue;
    }
    eligible.push(d);
  }
  return { eligible, blocked };
}

export async function forwardReceipts(client, { documentIds, toActorId, transactionId = null, reason, commandKey }) {
  const ids = [...new Set((documentIds || []).filter(Boolean))];
  if (!ids.length) throw new Error("هیچ فیشێک هەڵنەبژێردراوە");
  if (!toActorId) throw new Error("وەرگر پێویستە");
  const why = String(reason ?? "").normalize("NFKC").trim();
  if (why.length < 8) throw new Error("هۆکار دەبێت لانیکەم ٨ پیت بێت");

  const { data, error } = await client.rpc("sarraf_forward_receipts", {
    p_document_ids: ids,
    p_to_actor_id: toActorId,
    p_transaction_id: transactionId,
    p_reason: why,
    p_command_key: commandKey || forwardCommandKey(toActorId),
  });
  if (error) throw error;
  return {
    forwarded: Number(data?.forwarded) || 0,
    skipped: (data?.skipped || []).map((s) => ({ id: s.id, reason: s.reason, text: skipReasonText(s.reason) })),
    toActorId: data?.to_actor_id || toActorId,
    toRole: data?.to_role || null,
    replayed: data?.replayed === true,
  };
}

/** A recipient's own forwarded receipts — figures and status, never the internal trail. */
export async function loadForwardedToMe(client, limit = 100) {
  const { data, error } = await client.rpc("sarraf_my_forwarded_receipts", { p_limit: limit });
  if (error) throw error;
  return (data || []).map((r) => ({
    documentId: r.document_id,
    deliveryStatus: r.delivery_status,
    forwardedAt: r.forwarded_at,
    seenAt: r.seen_at,
    storagePath: r.storage_path,
    currency: r.currency,
    gross: r.gross_amount == null ? null : Number(r.gross_amount),
    fee: r.fee_amount == null ? null : Number(r.fee_amount),
    net: r.net_amount == null ? null : Number(r.net_amount),
    refNo: r.ref_no,
    txDate: r.tx_date,
    transactionId: r.transaction_id,
  }));
}

export async function markDelivered(client, documentId) {
  const { data, error } = await client.rpc("sarraf_receipt_mark_delivered", { p_document_id: documentId });
  if (error) throw error;
  return data;
}

export async function markSeen(client, documentId) {
  const { data, error } = await client.rpc("sarraf_receipt_mark_seen", { p_document_id: documentId });
  if (error) throw error;
  return data;
}

export async function loadForwardingReconciliation(client) {
  const { data, error } = await client.rpc("sarraf_forwarding_reconciliation");
  if (error) throw error;
  return {
    forwarded: Number(data?.forwarded) || 0,
    sent: Number(data?.sent) || 0,
    delivered: Number(data?.delivered) || 0,
    seen: Number(data?.seen) || 0,
    failed: Number(data?.failed) || 0,
  };
}

/**
 * Totals per currency for a recipient's portal. Currencies are never combined, and a receipt
 * whose figures were never read contributes nothing rather than a zero that looks like a value.
 */
export function forwardedTotals(rows) {
  const out = {};
  for (const r of rows || []) {
    if (!r.currency || r.net == null) continue;
    const b = out[r.currency] || (out[r.currency] = { gross: 0, fee: 0, net: 0, count: 0 });
    b.gross += r.gross || 0;
    b.fee += r.fee || 0;
    b.net += r.net;
    b.count += 1;
  }
  return out;
}
