const cleanIdentifier = (value) => String(value ?? "").normalize("NFKC").replace(/[^0-9A-Za-z]/g, "").toUpperCase();

const moneyUnits = (value, decimals = 2) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(Math.abs(number) * (10 ** decimals));
};

export function receiptIdentity(receipt) {
  const orderNo = cleanIdentifier(receipt?.orderNo ?? receipt?.refNo ?? receipt?.ref_no);
  const merchantOrderNo = cleanIdentifier(receipt?.merchantOrderNo ?? receipt?.merchant_order_no);
  const imageHash = cleanIdentifier(receipt?.imageHash ?? receipt?.hash ?? receipt?.image_hash);
  if (orderNo) return `order:${orderNo}`;
  if (merchantOrderNo) return `merchant:${merchantOrderNo}`;
  if (imageHash) return `image:${imageHash}`;
  return null;
}

export function validateReceiptArithmetic(receipt, decimals = 2) {
  const gross = moneyUnits(receipt?.amount ?? receipt?.grossAmount, decimals);
  const fee = moneyUnits(receipt?.fee ?? 0, decimals);
  const order = moneyUnits(receipt?.orderAmount, decimals);
  const net = moneyUnits(receipt?.netAmount ?? receipt?.net, decimals);
  const tolerance = 1;
  const issues = [];

  if (gross == null || gross <= 0) issues.push("invalid_gross_amount");
  if (fee == null) issues.push("invalid_fee");
  if (order != null && gross != null && fee != null && Math.abs(gross - (order + fee)) > tolerance) {
    issues.push("gross_order_fee_mismatch");
  }
  const expectedNet = order ?? (gross != null && fee != null ? gross - fee : null);
  if (net != null && expectedNet != null && Math.abs(net - expectedNet) > tolerance) issues.push("net_amount_mismatch");
  if (gross != null && fee != null && fee > gross) issues.push("fee_exceeds_gross");

  return {
    valid: issues.length === 0,
    issues,
    gross: gross == null ? null : gross / (10 ** decimals),
    fee: fee == null ? null : fee / (10 ** decimals),
    orderAmount: order == null ? null : order / (10 ** decimals),
    netAmount: expectedNet == null ? null : expectedNet / (10 ** decimals),
  };
}

export function classifyReceiptSet(receipts) {
  const seen = new Map();
  return (receipts || []).map((receipt) => {
    const identity = receiptIdentity(receipt);
    const duplicateOf = identity && seen.get(identity);
    if (identity && !duplicateOf) seen.set(identity, receipt.id ?? receipt.source ?? identity);
    return {
      ...receipt,
      identity,
      duplicate: Boolean(duplicateOf),
      duplicateOf: duplicateOf || null,
      validation: validateReceiptArithmetic(receipt),
    };
  });
}

