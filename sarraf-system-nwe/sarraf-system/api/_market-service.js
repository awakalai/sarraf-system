// Server-only market snapshot service. Values are display references and never
// participate in Sarraf transactions or accounting.
export const MARKET_POLICY = Object.freeze({
  freshMs: 36 * 60 * 60 * 1000,
  cacheMs: 30 * 60 * 1000,
  staleMs: 72 * 60 * 60 * 1000,
  timeoutMs: 4500,
  retries: 1,
});

export const INSTRUMENTS = Object.freeze({
  "USD/CNY": { label: "USD/CNY", base: "USD", quote: "CNY", unit: "CNY per USD", precision: 4 },
  "EUR/USD": { label: "EUR/USD", base: "EUR", quote: "USD", unit: "USD per EUR", precision: 4 },
  "GBP/USD": { label: "GBP/USD", base: "GBP", quote: "USD", unit: "USD per GBP", precision: 4 },
  "XAU/USD": { label: "Gold", base: "XAU", quote: "USD", unit: "USD per troy ounce", precision: 2 },
});

let cache = null;
let inFlight = null;

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};
const iso = (value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export function normalizeProvider(payload, retrievedAt = new Date().toISOString(), provider = "Frankfurter") {
  const observedAt = iso(payload?.observedAt);
  const rates = payload?.rates || {};
  const values = {
    "USD/CNY": positive(rates.CNY),
    "EUR/USD": positive(rates.EUR) ? 1 / positive(rates.EUR) : null,
    "GBP/USD": positive(rates.GBP) ? 1 / positive(rates.GBP) : null,
    "XAU/USD": positive(payload?.gold),
  };
  return Object.entries(INSTRUMENTS).map(([id, definition]) => ({
    id, ...definition, value: values[id], previousValue: null, absoluteChange: null,
    percentageChange: null, classification: "global", source: id === "XAU/USD" ? "Metals.Dev" : provider,
    observedAt, retrievedAt, freshness: values[id] && observedAt && Date.parse(retrievedAt) - Date.parse(observedAt) <= MARKET_POLICY.freshMs ? "live" : values[id] ? "stale" : "unavailable",
    cache: "miss", history: [], availability: values[id] ? "available" : "unavailable",
    error: values[id] ? null : "not_available",
  }));
}

async function requestJson(url, fetchImpl) {
  let lastError;
  for (let attempt = 0; attempt <= MARKET_POLICY.retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MARKET_POLICY.timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > 250000) throw new Error("response_too_large");
      return JSON.parse(text);
    } catch (error) { lastError = error; }
    finally { clearTimeout(timer); }
  }
  throw lastError;
}

async function retrieve(fetchImpl, env, now) {
  const retrievedAt = new Date(now).toISOString();
  const fxRows = await requestJson("https://api.frankfurter.dev/v2/rates?base=USD&quotes=CNY,EUR,GBP", fetchImpl);
  const rates = {};
  let date = null;
  if (!Array.isArray(fxRows)) throw new Error("invalid_fx_shape");
  for (const row of fxRows) {
    const symbol = String(row?.quote || "").toUpperCase();
    if (["CNY", "EUR", "GBP"].includes(symbol) && positive(row.rate)) rates[symbol] = Number(row.rate);
    if (!date && /^\d{4}-\d{2}-\d{2}$/.test(row?.date || "")) date = `${row.date}T00:00:00.000Z`;
  }
  let gold = null;
  let goldObservedAt = null;
  if (env.METALS_DEV_API_KEY) {
    try {
      const metal = await requestJson(`https://api.metals.dev/v1/latest?api_key=${encodeURIComponent(env.METALS_DEV_API_KEY)}&currency=USD&unit=toz`, fetchImpl);
      if (metal?.status === "success") {
        gold = positive(metal?.metals?.gold);
        goldObservedAt = iso(metal?.timestamps?.metal || metal?.timestamp);
      }
    } catch { /* independent partial failure is represented as unavailable */ }
  }
  const instruments = normalizeProvider({ rates, gold, observedAt: date }, retrievedAt);
  const goldRow = instruments.find((item) => item.id === "XAU/USD");
  if (goldRow && goldObservedAt) {
    goldRow.observedAt = goldObservedAt;
    goldRow.freshness = Date.parse(retrievedAt) - Date.parse(goldObservedAt) <= MARKET_POLICY.freshMs ? "live" : "stale";
  }
  return { schemaVersion: 1, referenceOnly: true, retrievedAt, status: instruments.every(i => i.availability === "available") ? "ok" : "partial", instruments };
}

export async function getMarketSnapshot({ fetchImpl = fetch, env = process.env, now = Date.now() } = {}) {
  if (cache && now - cache.at < MARKET_POLICY.cacheMs) return markCache(cache.data, "hit");
  if (inFlight) return inFlight;
  inFlight = retrieve(fetchImpl, env, now).then((data) => {
    if (data.instruments.some(i => i.availability === "available")) cache = { at: now, data };
    return data;
  }).catch(() => {
    if (cache && now - cache.at <= MARKET_POLICY.staleMs) return markCache(cache.data, "stale", true);
    return unavailable(now);
  }).finally(() => { inFlight = null; });
  return inFlight;
}

function markCache(data, state, stale = false) {
  return { ...data, status: stale ? "partial" : data.status, instruments: data.instruments.map(i => ({ ...i, cache: state, freshness: stale && i.value ? "stale" : i.freshness })) };
}
function unavailable(now) {
  const retrievedAt = new Date(now).toISOString();
  return { schemaVersion: 1, referenceOnly: true, retrievedAt, status: "unavailable", instruments: normalizeProvider({ rates: {}, gold: null, observedAt: null }, retrievedAt) };
}

export function resetMarketCache() { cache = null; inFlight = null; }
