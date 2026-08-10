export const MARKET_TICKER_INSTRUMENTS = Object.freeze([
  Object.freeze({ id: "USD/IQD", symbol: "$/ع.د", tone: "mint" }),
  Object.freeze({ id: "USD/CNY", symbol: "$/¥", tone: "cyan" }),
  Object.freeze({ id: "EUR/USD", symbol: "€/$", tone: "violet" }),
  Object.freeze({ id: "GBP/USD", symbol: "£/$", tone: "rose" }),
  Object.freeze({ id: "XAU/USD", symbol: "XAU/$", tone: "gold" }),
]);

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

export function buildMarketTickerRows(currencies = [], snapshot = null, online = true) {
  const iqd = currencies.find((currency) => String(currency?.code || "").toUpperCase() === "IQD");
  const globalRows = new Map((snapshot?.instruments || []).map((item) => [item?.id, item]));

  return MARKET_TICKER_INSTRUMENTS.map((definition) => {
    if (definition.id === "USD/IQD") {
      const buyRate = positive(iqd?.buyRate);
      const sellRate = positive(iqd?.sellRate);
      const availability = buyRate || sellRate ? "available" : "unavailable";
      return {
        ...definition,
        classification: "local",
        buyRate,
        sellRate,
        value: null,
        availability,
        freshness: !online ? "offline" : iqd?.rateUpdated ? "live" : "unavailable",
        observedAt: iqd?.rateUpdated || null,
        source: "ZEMAN operational rates",
      };
    }

    const item = globalRows.get(definition.id) || {};
    const value = positive(item.value);
    return {
      ...definition,
      classification: "global",
      value,
      buyRate: null,
      sellRate: null,
      availability: value ? "available" : "unavailable",
      freshness: !online ? "offline" : item.freshness || "unavailable",
      observedAt: item.observedAt || null,
      source: item.source || null,
      percentageChange: Number.isFinite(Number(item.percentageChange)) ? Number(item.percentageChange) : null,
    };
  });
}

export function tickerHealth(rows = [], online = true) {
  if (!online) return "offline";
  if (!rows.some((row) => row.availability === "available")) return "unavailable";
  if (rows.some((row) => row.freshness === "stale")) return "stale";
  return "live";
}
