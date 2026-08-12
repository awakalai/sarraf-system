/**
 * What the person who sent a receipt is allowed to see, and what it is called.
 *
 * The owner's report, in three parts:
 *
 *   "every receipt has a name in it, but it writes 'sent to unknown'"
 *   "they do not need any rate — only that they sent this much yuan, with the fee and without.
 *    They do not need to see what it comes to in dollars. When I turn it into a transaction,
 *    then they see what they sold me and what it came to."
 *   "the receipt says 3400 yuan, but it says dollars — that is a bug"
 *
 * All three are the same mistake from different angles: the uploader's screen was showing the
 * operator's information. A person handing over evidence needs to know the system read their
 * receipt correctly — the amount, the fee, the currency printed on it. A valuation in another
 * currency is a bookkeeping decision that has not been made yet, and showing one at upload time
 * is at best noise and at worst a figure they will hold the business to.
 */

/**
 * The recipient a receipt actually names.
 *
 * Payment services put the name in different places — a personal transfer has a receiver, a
 * merchant payment has a merchant name, a QR payment sometimes carries only a note. The old
 * code looked at two of those and said "unknown" for everything else, which is why receipts
 * that plainly showed a name were reported as going to nobody.
 */
export function payeeOf(receipt) {
  const candidates = [
    receipt?.receiver,
    receipt?.payee,
    receipt?.merchantName,
    receipt?.merchant_name,
    receipt?.raw?.payee,
    receipt?.raw?.receiver,
    receipt?.raw?.merchantName,
    receipt?.recipientNote,
    receipt?.raw?.recipientNote,
    receipt?.sender,
  ];
  for (const c of candidates) {
    const name = String(c ?? "").trim();
    if (name) return name;
  }
  return null;
}

export const PAYEE_UNKNOWN = "ناوی وەرگر لە فیشەکەدا نییە";

/** For grouping and display: the name, or an honest statement that the receipt did not give one. */
export const payeeLabel = (receipt) => payeeOf(receipt) || PAYEE_UNKNOWN;

/**
 * The currency a receipt states, or nothing.
 *
 * Never a default, never the system's base currency. A receipt whose currency could not be read
 * is a receipt awaiting review, and labelling its amount with a currency it does not name is
 * how 3400 yuan came to be shown as dollars.
 */
export function currencyOf(receipt) {
  const code = String(receipt?.currency ?? "").trim().toUpperCase();
  return /^[A-Z]{3,8}$/.test(code) ? code : null;
}

export const CURRENCY_UNREAD = "دراوەکە نەخوێندراوەتەوە";

/**
 * Everything the uploader may see about one receipt: what the receipt itself says.
 *
 * `net` is what reached the recipient after the fee, which is the number a customer cares
 * about. No valuation in any other currency appears here at all — that arrives with the
 * transaction, once the operator has made one.
 */
export function uploaderReceiptView(receipt) {
  const currency = currencyOf(receipt);
  const n = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const x = Number(v);
    return Number.isFinite(x) ? Math.abs(x) : null;
  };
  const gross = n(receipt?.amount);
  const fee = n(receipt?.fee);
  const net = n(receipt?.net) ?? n(receipt?.net_amount)
    ?? (gross == null ? null : Math.max(0, gross - (fee ?? 0)));

  return {
    currency,
    currencyKnown: currency != null,
    gross, fee, net,
    payee: payeeOf(receipt),
    reference: receipt?.refNo || receipt?.ref_no || null,
    date: receipt?.txDate || receipt?.tx_date || null,
    // Stated so no caller can accidentally reintroduce one.
    valuation: null,
  };
}

/**
 * Totals for the uploader, per currency, with no conversion.
 *
 * A receipt whose currency was not read is counted separately rather than folded into a
 * currency it might not belong to.
 */
export function uploaderTotals(receipts) {
  const byCurrency = {};
  let unread = 0;
  for (const r of receipts || []) {
    const v = uploaderReceiptView(r);
    if (!v.currencyKnown || v.net == null) { unread += 1; continue; }
    const b = byCurrency[v.currency] || (byCurrency[v.currency] = { gross: 0, fee: 0, net: 0, count: 0 });
    b.gross += v.gross ?? 0;
    b.fee += v.fee ?? 0;
    b.net += v.net;
    b.count += 1;
  }
  return { byCurrency, unread };
}

/**
 * May this person change what the reader extracted?
 *
 * Only staff, and only through the reviewed correction path. An uploader supplies the image;
 * the figures come from the evidence. §2 of the specification is explicit, and the edit control
 * was on every row regardless of who was looking at it — so a customer whose receipt showed
 * 1200 could type something else.
 */
export const mayEditExtraction = (isStaff) => isStaff === true;
