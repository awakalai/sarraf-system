/**
 * Reading the books: what the business earned, and what every entry in it says.
 *
 * §13.F.6 asks for a profit and loss with realized kept apart from unrealized. §12 asks that the
 * general ledger be readable. The arithmetic and the entries have both been correct since the
 * double-entry core went in — there was simply no way to look at either, so the owner could not
 * say what a month came to without adding it up by hand.
 *
 * Both come from the server. Nothing here totals anything; §4.14's rule is the same rule for the
 * books as it is for a batch of receipts.
 */

const iso = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
};

/** The month so far, which is what a person means when they have not said otherwise. */
export function defaultRange(today = new Date()) {
  const to = new Date(today);
  const from = new Date(today.getFullYear(), today.getMonth(), 1);
  return { from: iso(from), to: iso(to) };
}

export async function loadProfitAndLoss(client, { from = null, to = null, currency = null, partyId = null } = {}) {
  const a = iso(from);
  const b = iso(to);
  if (a && b && a > b) throw new Error("کۆتایی ماوەکە پێش سەرەتاکەیەتی");
  const { data, error } = await client.rpc("sarraf_profit_and_loss", {
    p_from: a, p_to: b,
    p_currency: currency ? String(currency).trim().toUpperCase() : null,
    p_party_id: partyId || null,
  });
  if (error) throw error;
  return data || null;
}

export async function loadGeneralLedger(client, {
  from = null, to = null, accountId = null, partyId = null,
  transactionId = null, search = null, limit = 100, offset = 0,
} = {}) {
  const { data, error } = await client.rpc("sarraf_general_ledger", {
    p_from: iso(from), p_to: iso(to),
    p_account_id: accountId || null,
    p_party_id: partyId || null,
    p_transaction_id: transactionId || null,
    p_search: search ? String(search).trim() : null,
    p_limit: Math.max(1, Math.min(Number(limit) || 100, 500)),
    p_offset: Math.max(0, Number(offset) || 0),
  });
  if (error) throw error;
  return data || { entries: [], total: 0, limit, offset };
}

const num = (v) => (v == null ? 0 : Number(v) || 0);

/**
 * The report as a screen needs it: one row per currency, with what trading earned and what the
 * rate merely moved kept in separate columns.
 *
 * They are never added. A rate that moved today says nothing about what a completed trade
 * earned, and a business that adds the two talks itself into a profit it has not made.
 */
export function profitRows(report) {
  const realized = new Map((report?.realized || []).map((r) => [r.currency, r]));
  const unrealized = new Map((report?.unrealized || []).map((r) => [r.currency, r]));
  const currencies = [...new Set([
    ...(report?.by_currency || []).map((c) => c.currency),
    ...unrealized.keys(),
  ])].filter(Boolean).sort();

  return currencies.map((currency) => {
    const r = realized.get(currency);
    const all = (report?.by_currency || []).find((c) => c.currency === currency);
    return {
      currency,
      income: num(r?.income ?? all?.income),
      expense: num(r?.expense ?? all?.expense),
      realized: num(r?.net),
      unrealized: num(unrealized.get(currency)?.amount),
    };
  });
}

/** The accounts behind a currency's figure, so a number can be opened rather than trusted. */
export function accountRows(report, currency = null) {
  return (report?.by_account || [])
    .filter((a) => !currency || a.currency === currency)
    .map((a) => ({
      accountId: a.account_id,
      code: a.account_code,
      name: a.account_name,
      kind: a.account_kind,
      currency: a.currency,
      amount: num(a.amount),
      lines: num(a.line_count),
    }));
}

/** Whether an entry is a correction of another, or has itself been corrected. */
export const entryCorrection = (entry) =>
  (entry?.reversal_of ? { kind: "reverses", of: entry.reversal_of }
    : entry?.reversed_by ? { kind: "reversed", by: entry.reversed_by }
      : null);

/** Both sides of an entry, summed, so a reader can see for themselves that it balances. */
export function entryBalance(entry) {
  const lines = entry?.lines || [];
  const debit = lines.filter((l) => l.side === "debit").reduce((n, l) => n + num(l.amount), 0);
  const credit = lines.filter((l) => l.side === "credit").reduce((n, l) => n + num(l.amount), 0);
  return { debit, credit, balanced: Math.abs(debit - credit) < 0.005 };
}

export const ACCOUNT_KIND_KU = Object.freeze({
  asset: "سامان", liability: "قەرزاری", equity: "سەرمایە",
  income: "داهات", expense: "خەرجی",
});
