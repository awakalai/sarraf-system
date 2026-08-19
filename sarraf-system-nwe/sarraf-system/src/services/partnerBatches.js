/**
 * The details of an indirect trade, as the partner holding the money reads them.
 *
 * Task A. A seller transfers yuan by WeChat or Alipay straight to a partner rather than to the
 * house, and uploads the receipt as proof. The admin reviews the batch and makes a transaction
 * from it, naming the partner the money was placed with — and from that moment the details of
 * those receipts belong to that partner as much as to the house.
 *
 * Every figure here is read from the server. There is no arithmetic in this file, deliberately:
 * the totals a partner is shown and the totals the house acts on have to be the same numbers,
 * and the only way to guarantee that is for there to be one place that computes them.
 */

const clean = (v) => String(v ?? "").normalize("NFKC").trim();

/** The wallets, named as a person names them rather than as a receipt spells them. */
export const PLATFORM_KU = Object.freeze({
  wechat: "ویچات",
  alipay: "ئەلیپەی",
  bank: "بانک",
  other: "ڕێگەی تر",
  unknown: "دیارینەکراو",
});

export const PLATFORM_EN = Object.freeze({
  wechat: "WeChat",
  alipay: "Alipay",
  bank: "Bank",
  other: "Other",
  unknown: "Unknown",
});

export const platformName = (key, lang = "ku") =>
  (lang === "ku" ? PLATFORM_KU : PLATFORM_EN)[key] || key || "—";

/** The details of one batch: every receipt, and the totals grouped as the owner asked for them. */
export async function loadBatchDetail(client, batchId) {
  if (!clean(batchId)) throw new Error("کۆمەڵەیەک پێویستە");
  const { data, error } = await client.rpc("sarraf_partner_batch_detail", { p_batch_id: batchId });
  if (error) throw error;
  return data || null;
}

/**
 * What has been placed with a partner, across every batch.
 *
 * partnerId is honoured for staff and ignored for a partner, which is the server's rule and not
 * this file's — repeating the check here would only mean two places to keep in step.
 */
export async function loadHoldings(client, partnerId = null) {
  const { data, error } = await client.rpc("sarraf_partner_holdings", {
    p_partner_id: partnerId || null,
  });
  if (error) throw error;
  return data || { batches: [], by_currency: [], batch_count: 0 };
}

/**
 * The rows as a table a person can read, in the columns the owner named.
 *
 * The caller turns these into CSV through csvSafe.toCsv, which is what keeps a recipient's name
 * beginning with `=` from becoming a formula in someone's spreadsheet.
 */
export function detailRows(detail, { lang = "ku" } = {}) {
  return (detail?.rows || []).map((r) => ({
    "وەرگر": r.receiver || "—",
    "بەروار": (r.tx_date || "").toString().slice(0, 10) || "—",
    "پلاتفۆرم": platformName(r.platform, lang),
    "دراو": r.currency,
    "بڕ (بە فی)": r.amount,
    "فی": r.fee,
    "بڕ (بێ فی)": r.net_amount,
    // The distinction the owner asked to see on every row, in words rather than as a number a
    // reader has to compare against zero themselves.
    "دۆخی فی": r.has_fee ? "بە فی" : "بێ فی",
    "ژمارەی ئاماژە": r.ref_no || r.merchant_order_no || "—",
    "دۆخ": r.counted ? "ژمێردراوە" : (r.reject_reason || "ژمێرنەکراوە"),
  }));
}

/** Is this batch an indirect trade, and whose is the money? Null partner means it is not. */
export function holder(detail) {
  if (!detail?.is_indirect) return null;
  return { id: detail.partner_id, name: detail.partner_name || detail.partner_id };
}
