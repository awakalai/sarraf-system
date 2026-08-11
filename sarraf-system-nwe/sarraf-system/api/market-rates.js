import { getMarketSnapshot } from "./_market-service.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ status: "unavailable", error: "method_not_allowed" });
  }
  // This endpoint takes no parameters, and nothing in the query can change the response.
  // Rejecting unknown parameters turned an ordinary read into a 400 as soon as anything
  // appended one — a browser or CDN cache-buster such as ?_=1699 was enough. Unknown
  // parameters are ignored, which is both the HTTP norm and the only safe behaviour for a
  // reference feed the dashboard polls.
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
