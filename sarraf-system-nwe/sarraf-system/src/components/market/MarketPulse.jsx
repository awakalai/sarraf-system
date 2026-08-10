import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Minus, RotateCcw } from "lucide-react";
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

  const rows = useMemo(() => {
    const iqd = currencies.find(c => String(c.code).toUpperCase() === "IQD");
    const local = { id:"USD/IQD", label:"USD/IQD", classification:"local", source:"Sarraf operational rates", observedAt:iqd?.rateUpdated || null,
      freshness: iqd?.rateUpdated && Date.now() - Date.parse(iqd.rateUpdated) <= 36*60*60*1000 ? "live" : iqd?.rateUpdated ? "stale" : "unavailable",
      availability: Number(iqd?.buyRate)>0 || Number(iqd?.sellRate)>0 ? "available" : "unavailable", unit:"IQD per USD", buyRate:Number(iqd?.buyRate)>0?Number(iqd.buyRate):null, sellRate:Number(iqd?.sellRate)>0?Number(iqd.sellRate):null };
    return [local, ...(snapshot?.instruments || [])];
  }, [currencies, snapshot]);
  const format = (value, id) => value == null ? "—" : new Intl.NumberFormat(lang === "en" ? "en" : "ckb", { maximumFractionDigits:digits[id] ?? 4, minimumFractionDigits:digits[id] ?? 0 }).format(value);
  return <section className="market-pulse" aria-labelledby="market-pulse-title">
    <div className="market-pulse-head"><h2 id="market-pulse-title">{t.title}</h2><span aria-live="polite">{!online ? t.offline : refreshing ? `${t.refresh}…` : snapshot?.status === "partial" ? t.partial : ""}</span>
      <button type="button" onClick={load} disabled={refreshing || !online} aria-label={t.refresh}><RotateCcw aria-hidden="true" /></button></div>
    <div className="market-pulse-row" role="list">
      {rows.map(item => { const state = !online ? "offline" : item.freshness || "unavailable"; const movement = item.percentageChange; const Icon = movement > 0 ? ArrowUp : movement < 0 ? ArrowDown : movement === 0 ? Minus : AlertTriangle;
        return <article key={item.id} role="listitem" className={`market-pulse-item is-${state}`} tabIndex="0" aria-label={`${item.label}. ${item.classification === "local" ? t.local : t.global}. ${t[state] || t.unavailable}`}>
          <div><b dir="ltr">{item.label}</b><span>{item.classification === "local" ? t.local : t.global} · {t[state] || t.unavailable}</span></div>
          <strong dir="ltr">{item.id === "USD/IQD" ? <>{t.buy} {format(item.buyRate,item.id)} / {t.sell} {format(item.sellRate,item.id)}</> : format(item.value,item.id)}</strong>
          <span className="market-move"><Icon aria-hidden="true" />{movement == null ? "—" : `${movement > 0 ? "+" : ""}${format(movement,item.id)}%`}</span>
          <small>{t.source}: {item.source} · {item.unit}<br/>{t.updated}: {item.observedAt ? new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "ckb", { dateStyle:"short", timeStyle:"short" }).format(new Date(item.observedAt)) : t.unavailable}{item.cache && item.cache !== "miss" ? ` · ${t.cached}` : ""}</small>
        </article>; })}
    </div>
  </section>;
}
