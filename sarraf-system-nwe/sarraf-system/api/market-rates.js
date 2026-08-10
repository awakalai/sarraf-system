import { getMarketSnapshot } from "./_market-service.js";

export default async function handler(req, res) {
  if (req.method !== "GET" || Object.keys(req.query || {}).length) {
    res.setHeader("Allow", "GET");
    return res.status(req.method === "GET" ? 400 : 405).json({ status: "unavailable", error: "unsupported_request" });
  }
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const snapshot = await getMarketSnapshot();
  // Transitional read-only fields keep the established Rates/MarketWatch views
  // compatible while every value still comes from the canonical allowlist.
  const byId = Object.fromEntries(snapshot.instruments.map((item) => [item.id, item]));
  const body = { ...snapshot, ok: snapshot.status !== "unavailable", provider: "Frankfurter / Metals.Dev",
    timestamp: snapshot.retrievedAt,
    rates: { CNY: byId["USD/CNY"]?.value, EUR: byId["EUR/USD"]?.value ? 1 / byId["EUR/USD"].value : null, GBP: byId["GBP/USD"]?.value ? 1 / byId["GBP/USD"].value : null },
    metals: { gold: byId["XAU/USD"]?.value } };
  return res.status(snapshot.status === "unavailable" ? 503 : 200).json(body);
}
