/**
 * Reading the one canonical total. Nothing here calculates.
 *
 * §4.14: "the admin and the person who sent the receipt read the same server-side endpoint and
 * read model … the client only renders; no role and no component has a formula or a rate
 * inversion of its own."
 *
 * That last clause is the whole point of this file. The totals used to be added up in the
 * browser, in more than one place, from whatever rows the screen happened to be holding — so two
 * people could look at the same batch and see two different numbers, with no way to tell which
 * was the real one. Every figure below arrives as a decimal string from the database and is
 * carried to the screen as that string. There is no division, no multiplication and no float
 * round-trip anywhere in this module, and a test asserts as much.
 */

/** What the database calls a refusal to act on figures that have moved (§4.15). */
export const STALE_SUMMARY = "stale_summary";

/** A summary that has not been loaded yet, or a batch with nothing counted. */
export const CALCULATION = Object.freeze({
  OK: "ok",
  PENDING_RATE: "pending_rate",
  EMPTY: "empty",
});

/**
 * The canonical read model for one batch. Whoever asks — the administrator reviewing it or the
 * person who sent it — this is the same call and the same bytes.
 */
export async function loadBatchSummary(client, batchId) {
  if (!batchId) throw new Error("receipt batch is required");
  const { data, error } = await client.rpc("sarraf_batch_summary", { p_batch_id: batchId });
  if (error) throw error;
  return data || null;
}

/**
 * Did this refusal happen because the figures moved under the person acting on them?
 *
 * The database raises PT409, which PostgREST turns into an HTTP 409 carrying the word
 * stale_summary. Anything else is a different problem and must not be reported as this one.
 */
export function isStale(error) {
  if (!error) return false;
  const code = String(error.code ?? error.status ?? "");
  const text = `${error.message ?? ""} ${error.details ?? ""} ${error.detail ?? ""}`;
  return code === "409" || code === "PT409" || text.includes(STALE_SUMMARY);
}

export const STALE_MESSAGE = "ژمارەکان گۆڕاون لەو کاتەوەی ئەم پەڕەیە کرایەوە — تکایە نوێی بکەرەوە و دووبارە سەیری کۆکانە بکە";

/**
 * One typed money value as the server stated it: the decimal string, unchanged.
 *
 * The string is what is displayed. Number() appears only for a caller that needs to ask
 * "is this zero" or to sort, never to produce what is shown.
 */
export function moneyOf(m) {
  if (!m || m.amount_decimal == null) return null;
  return {
    text: String(m.amount_decimal),
    currency: m.currency_code || null,
    value: Number(m.amount_decimal),
    source: m.source_amount
      ? { text: String(m.source_amount.amount_decimal), currency: m.source_amount.currency_code || null }
      : null,
    unrounded: m.unrounded ? String(m.unrounded) : null,
  };
}

/** The per-currency blocks, in the order the server gave them. Currencies are never merged. */
export function currencyRows(summary) {
  return (Array.isArray(summary?.currencies) ? summary.currencies : []).map((c) => ({
    currency: c.currency_code,
    count: Number(c.count) || 0,
    equationHolds: c.equation_holds !== false,
    native: {
      gross: moneyOf(c.native?.gross_total),
      fee: moneyOf(c.native?.fee_total),
      net: moneyOf(c.native?.net_total),
      order: moneyOf(c.native?.order_total),
    },
    // §4.18: no rate means no USD figure — never a zero, never yesterday's number.
    usd: c.usd?.status === CALCULATION.OK ? {
      gross: moneyOf(c.usd.gross_total),
      fee: moneyOf(c.usd.fee_total),
      net: moneyOf(c.usd.net_total),
      order: moneyOf(c.usd.order_total),
    } : null,
    usdPendingReason: c.usd?.status === CALCULATION.OK ? null : (c.usd?.reason || null),
    rate: c.rate?.status === CALCULATION.OK ? {
      id: c.rate.rate_id,
      value: String(c.rate.rate_value),
      convention: c.rate.rate_convention,
      inverse: c.rate.inverse_value ? String(c.rate.inverse_value) : null,
      version: c.rate.rate_version,
    } : null,
  }));
}

/** The version this screen is looking at, to be quoted back by anything that acts on it. */
export const versionOf = (summary) => summary?.summary_version || null;

/** Has the batch moved since this screen read it? */
export function hasMoved(shown, current) {
  const a = versionOf(shown);
  const b = versionOf(current);
  return !!a && !!b && a !== b;
}

export const isPendingRate = (summary) => summary?.calculation_status === CALCULATION.PENDING_RATE;
export const isEmpty = (summary) => summary?.calculation_status === CALCULATION.EMPTY;
