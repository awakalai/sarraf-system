/**
 * Realized and unrealized profit, kept apart (§12: "P&L realized و unrealized جیا بکە").
 *
 * Realized profit is what a completed sale actually earned: proceeds minus the cost basis the
 * inventory engine consumed. It is money that has happened.
 *
 * Unrealized profit is what the currency still sitting in inventory would earn if it were sold
 * at today's rate. It is a valuation, not an earning. The rate can move back tomorrow, and no
 * counterparty has agreed to anything.
 *
 * Adding the two together produces a number that reads like earnings and is not, which is how
 * an owner comes to withdraw against a paper gain that later evaporates. So they are computed
 * separately, reported separately, and never summed into one "profit" figure here.
 *
 * Where a rate is missing the answer is `null` — "not known" — never zero. A zero would read as
 * "this position has not moved", which is a different and false claim.
 */

import { computeInventoryPosition } from "./inventoryAccounting.js";

/**
 * The unrealized position of one currency.
 *
 * @param {object}   args
 * @param {Array}    args.txs           all transactions
 * @param {string}   args.curId         the currency held
 * @param {Function} args.usdCostOf     USD cost snapshot for a buy, as the inventory engine takes it
 * @param {Function} args.marketUsdRate (curId) => USD per one unit today, or null when unrated
 * @param {string?}  args.asOfDate      valuation date for the position, not for the rate
 * @returns {{qty:number, costUsd:number|null, marketUsd:number|null,
 *            unrealizedUsd:number|null, reason:string|null}}
 */
export function unrealizedForCurrency({ txs, curId, usdCostOf, marketUsdRate, asOfDate = null }) {
  const pos = computeInventoryPosition({ txs, curId, asOfDate, usdCostOf });
  const qty = Number(pos.qty) || 0;

  if (qty <= 0) {
    return { qty: 0, costUsd: 0, marketUsd: 0, unrealizedUsd: 0, reason: null };
  }
  // A pool whose cost was never fully recorded cannot be compared against anything.
  if (!pos.costComplete || pos.avgRate == null) {
    return { qty, costUsd: null, marketUsd: null, unrealizedUsd: null, reason: "cost_unknown" };
  }

  const rate = Number(marketUsdRate?.(curId));
  if (!Number.isFinite(rate) || rate <= 0) {
    return { qty, costUsd: pos.costUsd, marketUsd: null, unrealizedUsd: null, reason: "no_rate" };
  }

  const marketUsd = qty * rate;
  return {
    qty,
    costUsd: pos.costUsd,
    marketUsd,
    unrealizedUsd: marketUsd - pos.costUsd,
    reason: null,
  };
}

/**
 * Every held currency, plus a total that is only stated when every position could be valued.
 *
 * A total computed over some positions and not others is worse than no total: it looks
 * complete. So `totalUsd` is null whenever anything is unvalued, and `unvalued` names what
 * stopped it.
 */
export function unrealizedPnl({ txs, currencies, usdCostOf, marketUsdRate, asOfDate = null }) {
  const byCurrency = {};
  const unvalued = [];
  let total = 0;
  let complete = true;

  for (const c of currencies || []) {
    const id = c?.id ?? c;
    if (!id) continue;
    const row = unrealizedForCurrency({ txs, curId: id, usdCostOf, marketUsdRate, asOfDate });
    if (row.qty <= 0) continue;
    byCurrency[id] = row;
    if (row.unrealizedUsd == null) {
      complete = false;
      unvalued.push({ curId: id, reason: row.reason });
    } else {
      total += row.unrealizedUsd;
    }
  }

  return { byCurrency, totalUsd: complete ? total : null, complete, unvalued };
}

export const UNREALIZED_REASON = Object.freeze({
  cost_unknown: "تێچووی ئەم دراوە بە تەواوی تۆمار نەکراوە",
  no_rate: "نرخی ئەمڕۆی ئەم دراوە دانەنراوە",
});
export const unrealizedReasonText = (reason) => UNREALIZED_REASON[reason] || reason;

/**
 * The two figures side by side, deliberately without a combined total.
 *
 * `realizedUsd` comes from the caller — it is the report's existing, audited number. Nothing
 * here recomputes it; the point is only to place it beside the valuation and keep the two
 * from being added.
 */
export function profitSummary({ realizedUsd, unrealized }) {
  const realized = Number.isFinite(Number(realizedUsd)) ? Number(realizedUsd) : null;
  return {
    realizedUsd: realized,
    unrealizedUsd: unrealized?.totalUsd ?? null,
    unrealizedComplete: !!unrealized?.complete,
    unvalued: unrealized?.unvalued || [],
    // Stated only so a caller cannot accidentally treat the pair as one number: there is no
    // "total profit" here, and asking for one is the mistake this module exists to prevent.
    combined: null,
  };
}
