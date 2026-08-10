const foldDigits = (value) => String(value ?? "")
  .replace(/[٠-٩]/g, (digit) => "٠١٢٣٤٥٦٧٨٩".indexOf(digit))
  .replace(/[۰-۹]/g, (digit) => "۰۱۲۳۴۵۶۷۸۹".indexOf(digit));

export const normalizeMatchText = (value) => foldDigits(value)
  .normalize("NFKC")
  .toLocaleLowerCase("en")
  .replace(/[يى]/g, "ی")
  .replace(/ك/g, "ک")
  .replace(/[^\p{L}\p{N}]+/gu, "")
  .slice(0, 160);

const dateHours = (left, right) => {
  const a = Date.parse(left || "");
  const b = Date.parse(right || "");
  return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) / 3_600_000 : null;
};

/** Deterministic preview scorer. Authorization and final scoring are repeated by the RPC. */
export function scoreReceiptCandidate(receipt, transaction) {
  if (!receipt || !transaction || receipt.tenantId !== transaction.tenantId) return null;
  const reasons = [];
  const conflicts = [];
  let score = 0;
  const receiptOrder = normalizeMatchText(receipt.orderNo);
  const merchantOrder = normalizeMatchText(receipt.merchantOrderNo);
  const txOrder = normalizeMatchText(transaction.orderNo ?? transaction.code);
  const txMerchantOrder = normalizeMatchText(transaction.merchantOrderNo);

  if (receiptOrder && receiptOrder === txOrder) { score += 55; reasons.push({ signal: "exact_order_no", weight: 55 }); }
  if (merchantOrder && txMerchantOrder && merchantOrder === txMerchantOrder) { score += 50; reasons.push({ signal: "exact_merchant_order_no", weight: 50 }); }

  const receiptCurrency = String(receipt.currency || "").toUpperCase();
  const txCurrency = String(transaction.currency || "").toUpperCase();
  if (receiptCurrency && receiptCurrency === txCurrency) { score += 15; reasons.push({ signal: "currency", weight: 15 }); }
  else { score -= 45; conflicts.push({ signal: "currency_mismatch", weight: -45 }); }

  const expected = Number(receipt.netAmount ?? receipt.amount);
  const actual = Number(transaction.amount);
  if (Number.isFinite(expected) && Number.isFinite(actual)) {
    const tolerance = Math.max(0.01, Math.abs(expected) * 0.001);
    const delta = Math.abs(expected - actual);
    if (delta <= tolerance) { score += 20; reasons.push({ signal: "amount", weight: 20, delta, tolerance }); }
    else { score -= 20; conflicts.push({ signal: "amount_mismatch", weight: -20, delta, tolerance }); }
  }

  const hours = dateHours(receipt.date, transaction.date);
  if (hours != null) {
    if (hours <= 24) { score += 8; reasons.push({ signal: "date_24h", weight: 8, hours }); }
    else if (hours <= 72) { score += 4; reasons.push({ signal: "date_72h", weight: 4, hours }); }
    else { score -= 8; conflicts.push({ signal: "date_far", weight: -8, hours }); }
  }

  const payee = normalizeMatchText(receipt.payee);
  const counterparty = normalizeMatchText(transaction.counterparty);
  if (payee && counterparty && (payee === counterparty || (payee.length >= 5 && counterparty.length >= 5 && (payee.includes(counterparty) || counterparty.includes(payee))))) {
    score += 7; reasons.push({ signal: "payee", weight: 7 });
  }
  if (receipt.customerId && receipt.customerId === transaction.customerId) { score += 10; reasons.push({ signal: "customer", weight: 10 }); }
  else if (receipt.customerId && transaction.customerId) { score -= 20; conflicts.push({ signal: "customer_mismatch", weight: -20 }); }
  if (receipt.partnerId && receipt.partnerId === transaction.partnerId) { score += 8; reasons.push({ signal: "partner", weight: 8 }); }
  else if (receipt.partnerId && transaction.partnerId) { score -= 12; conflicts.push({ signal: "partner_mismatch", weight: -12 }); }

  return { score: Math.max(0, Math.min(100, score)), reasons, conflicts };
}
