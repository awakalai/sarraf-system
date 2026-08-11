/**
 * Weighted-average inventory engine.
 *
 * Every currency has ONE pool across all trading pairs, with its cost basis normalized to
 * USD, so a CNY position bought with USD can later be sold for IQD without losing what it
 * cost. This is the calculation realized profit is derived from, so it is kept pure and
 * separately testable rather than living inside the component tree.
 *
 * costComplete is the honesty flag: when a buy carries no usable USD cost snapshot the pool
 * is marked incomplete and avgRate becomes null, so callers report "cost unknown" instead of
 * inventing a profit figure from a partial basis.
 */
export function computeInventoryPosition({
  txs = [],
  curId,
  excludeTxId = null,
  asOfDate = null,
  usdCostOf,
} = {}) {
  const asOfMs = asOfDate ? new Date(asOfDate).getTime() : null;
  const bounded = Number.isFinite(asOfMs);

  const relevant = txs
    .filter((t) => {
      if (!t || t.deleted || t.direct || t.curId !== curId) return false;
      if (excludeTxId && t.id === excludeTxId) return false;
      if (bounded && new Date(t.date).getTime() > asOfMs) return false;
      return true;
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date) || (a.code || 0) - (b.code || 0));

  let qty = 0;
  let costUsd = 0;
  let costComplete = true;
  let oversold = 0;

  for (const t of relevant) {
    const amount = Number(t.amount);
    if (!(amount > 0)) continue;

    if (t.type === "buy") {
      const snapshot = Number(t.buyTotal) > 0 ? Number(t.buyTotal) : usdCostOf?.(t);
      qty += amount;
      if (Number.isFinite(snapshot) && snapshot >= 0) costUsd += snapshot;
      else costComplete = false;
    } else if (t.type === "sell") {
      // A sale beyond the recorded position cannot consume cost that was never booked.
      // The excess is surfaced rather than dropped, so callers can say why profit is absent.
      if (amount > qty + 1e-9) oversold += amount - Math.max(0, qty);
      const used = Math.min(amount, Math.max(0, qty));
      if (used > 0 && costComplete && qty > 0) costUsd -= used * (costUsd / qty);
      qty = Math.max(0, qty - used);
      if (qty <= 1e-9) {
        qty = 0;
        costUsd = 0;
        // An emptied pool carries no unknown cost forward.
        costComplete = true;
      }
    }
  }

  const avgRate = costComplete && qty > 0 ? costUsd / qty : null;
  return { qty, cost: costUsd, costUsd, costComplete, oversold, avgRate, avgUsdRate: avgRate };
}

/**
 * An investor's share of a currency's profit: their capital's weight inside the pool of
 * capital eligible for that currency, times their agreed rate. Losses propagate on the same
 * weighting, so a negative total is shared rather than silently zeroed.
 */
export function investorProfitShare({ capital, totalCapital, rate, totalProfit }) {
  const cap = Number(capital) || 0;
  const total = Number(totalCapital) || 0;
  const profit = Number(totalProfit) || 0;
  const share = Number(rate) || 0;
  if (total <= 0 || cap <= 0 || !profit) return 0;
  return profit * (cap / total) * (share / 100);
}
