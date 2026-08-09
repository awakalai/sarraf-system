// api/market-rates.js
// Reference-only global FX + metals feed.
// IMPORTANT: this endpoint never writes to Supabase and never changes internal Sarraf rates.

const CACHE_SECONDS = 12 * 60 * 60;

async function fromMetalsDev(apiKey) {
  const url = `https://api.metals.dev/v1/latest?api_key=${encodeURIComponent(apiKey)}&currency=USD&unit=toz`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  const j = await r.json().catch(() => ({}));

  if (!r.ok || j?.status !== "success") {
    throw new Error(j?.error_message || `Metals.Dev HTTP ${r.status}`);
  }

  // Metals.Dev latest currencies are USD value of one unit of each currency.
  // Normalize for the UI to: 1 USD = X currency.
  const rates = {};
  for (const [code, usdPerUnitRaw] of Object.entries(j.currencies || {})) {
    const usdPerUnit = Number(usdPerUnitRaw);
    if (!(usdPerUnit > 0)) continue;
    rates[code] = code === "USD" ? 1 : 1 / usdPerUnit;
  }
  rates.USD = 1;

  const metalKeys = ["gold", "silver", "platinum", "palladium"];
  const metals = {};
  for (const key of metalKeys) {
    const v = Number(j.metals?.[key]);
    if (v > 0) metals[key] = v;
  }

  return {
    ok: true,
    provider: "Metals.Dev",
    base: "USD",
    rates,
    metals,
    timestamp: j.timestamps?.currency || j.timestamp || new Date().toISOString(),
    metalTimestamp: j.timestamps?.metal || j.timestamp || null,
    referenceOnly: true,
  };
}

async function fromFrankfurter() {
  const r = await fetch("https://api.frankfurter.dev/v2/rates?base=USD", {
    headers: { Accept: "application/json" },
  });
  const rows = await r.json().catch(() => []);
  if (!r.ok || !Array.isArray(rows)) throw new Error(`Frankfurter HTTP ${r.status}`);

  const rates = { USD: 1 };
  let date = null;
  for (const row of rows) {
    const rate = Number(row?.rate);
    if (row?.quote && rate > 0) rates[String(row.quote).toUpperCase()] = rate;
    if (!date && row?.date) date = row.date;
  }

  return {
    ok: true,
    provider: "Frankfurter fallback",
    base: "USD",
    rates,
    metals: {},
    timestamp: date ? `${date}T00:00:00Z` : new Date().toISOString(),
    referenceOnly: true,
    message: "METALS_DEV_API_KEY دانەنراوە؛ دراوەکان لە fallback ـەوە هاتون و کانزا بەردەست نییە.",
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ ok: false, message: "GET only" });
    return;
  }

  // CDN cache is intentionally long because the feed is display/reference-only
  // and the Metals.Dev free plan has a limited monthly quota.
  res.setHeader("Cache-Control", `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`);
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    const key = process.env.METALS_DEV_API_KEY;
    const data = key ? await fromMetalsDev(key) : await fromFrankfurter();
    res.status(200).json(data);
  } catch (primaryError) {
    console.error("market-rates primary", primaryError);

    // A market-data outage must never affect Sarraf transactions.
    try {
      const fallback = await fromFrankfurter();
      fallback.message = `Live provider unavailable; fallback used. ${String(primaryError?.message || "")}`.trim();
      res.status(200).json(fallback);
    } catch (fallbackError) {
      console.error("market-rates fallback", fallbackError);
      res.status(503).json({
        ok: false,
        referenceOnly: true,
        message: "نرخی بازاڕ کاتێک بەردەست نییە. نرخی ناوخۆ و مامەڵەکان هیچ کاریگەرییان لێ وەرناگرێت.",
      });
    }
  }
}
