import { BRAND } from "../../brand/brand";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { buildMarketTickerRows, tickerHealth } from "./marketTickerModel";
import "./market-pulse.css";

const COPY = {
  en: { title:"Market Pulse", local:"Local Rate", global:"Global Market Rate", live:"Live", cached:"Cached", stale:"Stale", offline:"Offline", unavailable:"Unavailable", partial:"Partial data", updated:"Last updated", source:"Source", refresh:"Refresh", buy:"Buy", sell:"Sell" },
  ku: { title:"نبزی بازاڕ", local:"نرخی ناوخۆ", global:"نرخی بازاڕی جیهانی", live:"ڕاستەوخۆ", cached:"هەڵگیراو", stale:"کۆن", offline:"ئۆفلاین", unavailable:"بەردەست نییە", partial:"داتای ناتەواو", updated:"دوا نوێکردنەوە", source:"سەرچاوە", refresh:"نوێکردنەوە", buy:"کڕین", sell:"فرۆشتن" },
};
const digits = { "USD/IQD": 0, "USD/CNY": 4, "EUR/USD": 4, "GBP/USD": 4, "XAU/USD": 2 };

export default function MarketPulse({ currencies = [], lang = "ku", online = true }) {
  const t = COPY[lang] || COPY.ku;
  const [snapshot, setSnapshot] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);
  const controller = useRef(null);
  const load = async () => {
    const id = ++requestId.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setRefreshing(true);
    try {
      const response = await fetch("/api/market-rates", { signal: controller.current.signal, headers: { Accept:"application/json" } });
      const body = await response.json();
      if (id === requestId.current && body?.instruments) setSnapshot(old => !old || Date.parse(body.retrievedAt) >= Date.parse(old.retrievedAt) ? body : old);
    } catch (error) { if (error.name !== "AbortError") setSnapshot(old => old); }
    finally { if (id === requestId.current) setRefreshing(false); }
  };
  useEffect(() => {
    load();
    const timer = setInterval(load, 30 * 60 * 1000);
    return () => { clearInterval(timer); controller.current?.abort(); requestId.current += 1; };
  }, []);

  const rows = useMemo(() => buildMarketTickerRows(currencies, snapshot, online), [currencies, snapshot, online]);
  const health = tickerHealth(rows, online);
  const format = (value, id) => value == null ? "—" : new Intl.NumberFormat(lang === "en" ? "en" : "ckb", { maximumFractionDigits:digits[id] ?? 4, minimumFractionDigits:digits[id] ?? 0 }).format(value);
  const statusLabel = refreshing ? `${t.refresh}…` : t[health] || t.unavailable;
  const value = (item) => item.id === "USD/IQD"
    ? `${format(item.buyRate, item.id)} / ${format(item.sellRate, item.id)}`
    : format(item.value, item.id);
  const renderGroup = (duplicate = false) => <div className="market-ticker-group" role={duplicate ? undefined : "list"} aria-hidden={duplicate || undefined}>
    {rows.map((item) => <article key={`${duplicate ? "copy-" : ""}${item.id}`} role={duplicate ? undefined : "listitem"} className={`market-ticker-item tone-${item.tone} is-${item.freshness}`} aria-label={duplicate ? undefined : `${item.id}. ${item.classification === "local" ? t.local : t.global}. ${value(item)}. ${t[item.freshness] || t.unavailable}`}>
      <span className="market-ticker-symbol" dir="ltr">{item.symbol}</span>
      <strong dir="ltr">{value(item)}</strong>
    </article>)}
  </div>;

  return <section className={`market-ticker market-ticker-${health}`} aria-label={`${BRAND.name} ${t.title}`}>
    <div className="market-ticker-lights" role="status" aria-live="polite" aria-label={statusLabel} title={statusLabel}>
      <span className={`market-light market-light-green ${health === "live" ? "is-active" : ""}`} aria-hidden="true" />
      <span className={`market-light market-light-red ${health !== "live" ? "is-active" : ""}`} aria-hidden="true" />
    </div>
    <div className="market-ticker-viewport">
      <div className="market-ticker-track">{renderGroup(false)}{renderGroup(true)}</div>
    </div>
    <button className="market-ticker-refresh" type="button" onClick={load} disabled={refreshing || !online} aria-label={t.refresh} title={t.refresh}>
      <RotateCcw aria-hidden="true" />
    </button>
  </section>;
}
