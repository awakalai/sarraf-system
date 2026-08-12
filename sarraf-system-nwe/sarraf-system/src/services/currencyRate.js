/**
 * One ratio per currency.
 *
 *   rate = how many units of this currency one US dollar buys
 *
 *   1 USD = 7.20 CNY   →   3400 CNY ÷ 7.20 = 472.22 USD
 *   1 USD = 1410 IQD   →   282000 IQD ÷ 1410 = 200.00 USD
 *
 * Every valuation in the system divides by that number, and nothing else. The previous model
 * carried a buy rate and a sell rate per currency and then *derived* a cross rate between any
 * two of them through USD, applying a spread on each leg. That produced numbers nobody could
 * predict or check by hand — which is exactly the complaint.
 *
 * Profit no longer comes from a spread invented at valuation time. It comes from the ratio
 * having moved between the day a currency was acquired and the day it was sold, which the
 * inventory cost-basis engine already measures. A trade may still be struck at whatever rate
 * was actually agreed with the counterparty — that lives on the transaction. This ratio is the
 * house's own reference for valuing what it holds.
 *
 * There is no fallback rate anywhere in this module. A currency with no ratio yields `null`,
 * and every caller must say "not priced" rather than print a number nobody set.
 */

export const USD = "usd";

/** Number(null) and Number("") are a finite 0, so an absent value must be rejected first. */
const numeric = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const positive = (v) => {
  const n = numeric(v);
  return n !== null && n > 0 ? n : null;
};
/** Six places: enough for any ratio, and it keeps a midpoint from landing on 7.199999999. */
const tidy = (n) => (n === null ? null : Math.round(n * 1e6) / 1e6);

const idOf = (c) => String(c?.id ?? c ?? "").trim().toLowerCase();

/**
 * The ratio for one currency.
 *
 * `rate` is the single field this model uses. A currency still carrying only the old pair is
 * read at its midpoint, so the application behaves identically before and after the migration
 * that introduces the column — the change cannot half-land.
 */
export function rateOf(currency) {
  if (!currency) return null;
  if (idOf(currency) === USD) return 1;
  const single = positive(currency.rate);
  if (single) return single;
  const buy = positive(currency.buyRate);
  const sell = positive(currency.sellRate);
  if (buy && sell) return tidy((buy + sell) / 2);
  return buy || sell || null;
}

export const findCurrency = (currencies, curId) => {
  const key = idOf(curId);
  return (currencies || []).find((c) => idOf(c) === key) || null;
};

export const rateFor = (currencies, curId) =>
  idOf(curId) === USD ? 1 : rateOf(findCurrency(currencies, curId));

/** USD value of an amount. Null means the currency has no ratio — never zero. */
export function usdFrom(amount, curId, currencies) {
  const value = numeric(amount);
  if (value === null) return null;
  if (idOf(curId) === USD) return value;
  const rate = rateFor(currencies, curId);
  return rate ? value / rate : null;
}

/** The reverse: what a USD figure is worth in another currency. */
export function fromUsd(usdAmount, curId, currencies) {
  const value = numeric(usdAmount);
  if (value === null) return null;
  if (idOf(curId) === USD) return value;
  const rate = rateFor(currencies, curId);
  return rate ? value * rate : null;
}

/**
 * Units of `againstId` for one unit of `curId` — the shape a transaction's rate takes.
 *
 * Derived from the two ratios and nothing else, so it is reproducible by hand:
 * CNY→IQD at 7.20 and 1410 is 1410 ÷ 7.20 = 195.833… IQD per CNY.
 */
export function crossRate(curId, againstId, currencies) {
  if (!curId || !againstId || idOf(curId) === idOf(againstId)) return null;
  const from = rateFor(currencies, curId);
  const to = rateFor(currencies, againstId);
  return from && to ? to / from : null;
}

/**
 * The ratio as it stood on a date, from the recorded history.
 *
 * A valuation of something that happened in the past must use the ratio of that day; today's
 * ratio would silently rewrite what an old trade was worth. Entries after the date are ignored,
 * and when the date predates all history the earliest recorded ratio is used rather than
 * today's — the oldest thing actually known is closer to the truth than the newest.
 */
export function rateAsOf(curId, date, history, currencies) {
  if (idOf(curId) === USD) return 1;
  const when = new Date(date || Date.now()).getTime();
  if (!Number.isFinite(when)) return rateFor(currencies, curId);

  const entries = (history || [])
    .filter((h) => idOf(h?.curId) === idOf(curId) && Number.isFinite(new Date(h?.createdAt).getTime()))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  let chosen = null;
  for (const h of entries) {
    if (new Date(h.createdAt).getTime() <= when) chosen = h;
    else break;
  }
  if (!chosen && entries.length) chosen = entries[0];

  const historical = chosen ? rateOf({ id: curId, rate: chosen.rate, buyRate: chosen.buyRate, sellRate: chosen.sellRate }) : null;
  return historical || rateFor(currencies, curId);
}

export function usdFromAsOf(amount, curId, date, history, currencies) {
  const value = numeric(amount);
  if (value === null) return null;
  if (idOf(curId) === USD) return value;
  const rate = rateAsOf(curId, date, history, currencies);
  return rate ? value / rate : null;
}

export function fromUsdAsOf(usdAmount, curId, date, history, currencies) {
  const value = numeric(usdAmount);
  if (value === null) return null;
  if (idOf(curId) === USD) return value;
  const rate = rateAsOf(curId, date, history, currencies);
  return rate ? value * rate : null;
}

/** A ratio an operator typed. Rejects everything that is not a usable positive number. */
export function validateRate(input) {
  if (input === "" || input == null) return { ok: true, rate: null };
  const raw = typeof input === "string" ? input.trim().replace(/,/g, "") : input;
  const n = numeric(raw);
  if (n === null) return { ok: false, code: "not_a_number", rate: null };
  if (n <= 0) return { ok: false, code: "not_positive", rate: null };
  return { ok: true, rate: Math.round(n * 1e6) / 1e6 };
}

export const RATE_ERROR = Object.freeze({
  not_a_number: "ڕەیتیۆ دەبێت ژمارە بێت",
  not_positive: "ڕەیتیۆ دەبێت لە سفر گەورەتر بێت",
});
export const rateErrorText = (code) => RATE_ERROR[code] || code;

/** How the ratio is stated wherever it is shown, so it always reads the same way. */
export const rateLabel = (code) => `١ USD = ${code}`;

/** Currencies still without a ratio; nothing they touch can be valued in USD. */
export const unpricedCurrencies = (currencies) =>
  (currencies || []).filter((c) => idOf(c) !== USD && !rateOf(c)).map((c) => c.code || c.id);
