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
 * The one currency a set of receipts is in — or nothing, when it is more than one.
 *
 * The owner's report: "I sent yuan, why does it show dollars here?" The screen took the first
 * currency it happened to encounter and presented that currency's net as *the* headline total.
 * With a yuan receipt and a dollar receipt in the same batch, the headline read USD and the
 * yuan sat below it, which reads as a conversion the house never made.
 *
 * There is no such thing as one total across two currencies. When a set is mixed, no single
 * figure may stand at the top of the screen — each currency is stated on its own.
 */
export function soleCurrency(receipts) {
  const seen = new Set();
  for (const r of receipts || []) {
    const c = currencyOf(r);
    if (c) seen.add(c);
    if (seen.size > 1) return null;
  }
  return seen.size === 1 ? [...seen][0] : null;
}

/**
 * A sale is money that came to the uploader; a purchase is money they sent out.
 *
 * A customer-seller earns yuan in China and sells it to the house. Their evidence is always a
 * receipt of money received. Offering them the other direction invites a receipt the house
 * cannot buy and, worse, one that would be booked the wrong way round.
 */
export const SALE_DIRECTIONS = Object.freeze(["in", "sell"]);
export const PURCHASE_DIRECTIONS = Object.freeze(["out", "buy"]);

export const DIRECTION_REFUSED = "کڕیار تەنها فیشی فرۆشتنی خۆی دەنێرێت";

/** The directions this role is allowed to upload. Staff choose; a customer does not. */
export function uploadDirectionsFor(role) {
  return role === "customer" ? [...SALE_DIRECTIONS] : [...SALE_DIRECTIONS, ...PURCHASE_DIRECTIONS];
}

export function mayUploadDirection(role, direction) {
  const d = String(direction ?? "").trim().toLowerCase();
  return uploadDirectionsFor(role).includes(d);
}

const tidy = (n) => Math.round(n * 1e6) / 1e6;

/**
 * What the uploader asked to see: who received their receipts, and what the whole lot came to.
 *
 *   "the details the customer-seller needs to see are only: how many receipts went to which
 *    recipient and how much went, the recipient's name, that many receipts and that much yuan,
 *    and at the end the grand total with fee and without fee"
 *
 * With fee is what left the sender's account; without fee is what reached the recipient. Both
 * are stated in the currency the receipt itself names — nothing is converted, and a receipt
 * whose currency could not be read is counted apart rather than added to a currency it may not
 * belong to.
 */
export function recipientSummary(receipts) {
  const byName = new Map();
  const grandTotal = {};
  let unread = 0;

  const bucket = (into, currency) => into[currency]
    || (into[currency] = { count: 0, withFee: 0, withoutFee: 0, fee: 0 });

  for (const r of receipts || []) {
    const v = uploaderReceiptView(r);
    if (!v.currencyKnown || v.net == null) { unread += 1; continue; }

    const entry = byName.get(v.payee ?? null)
      || { name: v.payee ?? PAYEE_UNKNOWN, named: v.payee != null, count: 0, byCurrency: {} };
    byName.set(v.payee ?? null, entry);
    entry.count += 1;

    for (const b of [bucket(entry.byCurrency, v.currency), bucket(grandTotal, v.currency)]) {
      b.count += 1;
      b.withFee = tidy(b.withFee + (v.gross ?? v.net));
      b.withoutFee = tidy(b.withoutFee + v.net);
      b.fee = tidy(b.fee + (v.fee ?? 0));
    }
  }

  // Busiest recipient first; a stable order after that, so the list does not reshuffle between
  // two readings of the same figures. The unnamed group is always last — it is a gap to close,
  // not a recipient.
  const recipients = [...byName.values()].sort((a, b) =>
    (a.named === b.named ? 0 : a.named ? -1 : 1)
    || b.count - a.count
    || a.name.localeCompare(b.name));

  return { recipients, grandTotal, unread };
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
