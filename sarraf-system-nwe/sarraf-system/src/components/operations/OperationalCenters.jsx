import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, CircleGauge, Inbox, RefreshCw, ShieldAlert } from "lucide-react";
import { loadActionInbox, loadIntegrityCenter } from "../../services/operationalControl";
import "./operational-centers.css";

const COPY = {
  inbox: {
    eyebrow: "ZEMAN OPERATIONS",
    title: "Action Inbox",
    subtitle: "ئەو کارانەی ئێستا پێویستیان بە سەرنج و بڕیاری مرۆڤ هەیە",
    empty: "هیچ کارێکی چاوەڕوان نییە",
    emptyDetail: "سیستەمەکە هیچ receipt، transaction، rate یان approval ـێکی کراوە نەدۆزییەوە.",
  },
  integrity: {
    eyebrow: "ZEMAN ASSURANCE",
    title: "Integrity Center",
    subtitle: "پشکنینی تۆماری ناکۆک، دووبارە و شکاندنی پەیوەندییەکان—بەبێ گۆڕینی خۆکارانە",
    empty: "هیچ ناکۆکییەک نەدۆزرایەوە",
    emptyDetail: "کۆی receipt، batch و transaction ـە پشکنراوەکان لە سنووری ئەم پشکنینەدا ڕێکن.",
  },
};

const tone = (value) => value === "critical" || value === "high" ? "danger" : value === "medium" ? "warning" : "neutral";
const dateText = (value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("en-GB") : "—";
};

function useCenter(loader, client) {
  const [snapshot, setSnapshot] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      setSnapshot(await loader(client));
      setState("ready");
    } catch (cause) {
      setError(cause?.message || "Operational center could not be loaded");
      setState("error");
    }
  }, [client, loader]);
  useEffect(() => { refresh(); }, [refresh]);
  return { snapshot, state, error, refresh };
}

function Center({ kind, client, onNavigate }) {
  const copy = COPY[kind];
  const loader = kind === "inbox" ? loadActionInbox : loadIntegrityCenter;
  const { snapshot, state, error, refresh } = useCenter(loader, client);
  const items = snapshot?.items || [];
  const counts = useMemo(() => Object.entries(snapshot?.counts || {}).sort((a, b) => Number(b[1]) - Number(a[1])), [snapshot?.counts]);
  const Icon = kind === "inbox" ? Inbox : ShieldAlert;

  return <div className="operation-center">
    <header className="operation-center-header">
      <div className="operation-center-heading">
        <span className="operation-center-eyebrow">{copy.eyebrow}</span>
        <h1><Icon aria-hidden="true" /> {copy.title}</h1>
        <p>{copy.subtitle}</p>
      </div>
      <button type="button" className="operation-center-refresh" onClick={refresh} disabled={state === "loading"}>
        <RefreshCw aria-hidden="true" className={state === "loading" ? "is-spinning" : ""} />
        نوێکردنەوە
      </button>
    </header>

    {state === "error" && <section className="operation-center-state is-error" role="alert">
      <AlertTriangle aria-hidden="true" /><div><strong>بارکردن سەرکەوتوو نەبوو</strong><p>{error}</p></div>
      <button type="button" onClick={refresh}>دووبارە هەوڵ بدەرەوە</button>
    </section>}

    {state !== "error" && <>
      <section className="operation-center-summary" aria-label="Summary">
        <div className="operation-summary-primary">
          <span className={`operation-summary-orb ${items.length ? "has-items" : "is-clear"}`}><CircleGauge aria-hidden="true" /></span>
          <div><strong>{snapshot?.total ?? "—"}</strong><span>{kind === "inbox" ? "کاری چاوەڕوان" : "دۆزراوەی integrity"}</span></div>
        </div>
        <div className="operation-summary-counts">
          {counts.length ? counts.map(([label, count]) => <span key={label}><b>{count}</b>{label.replaceAll("_", " ")}</span>) : <span><b>0</b>clear</span>}
        </div>
      </section>

      {state === "loading" && !snapshot ? <section className="operation-center-loading" aria-live="polite">
        {[0, 1, 2].map((item) => <span key={item} />)}
      </section> : items.length === 0 ? <section className="operation-center-state is-clear">
        <CheckCircle2 aria-hidden="true" /><div><strong>{copy.empty}</strong><p>{copy.emptyDetail}</p></div>
      </section> : <section className="operation-center-list" aria-label={copy.title}>
        {items.map((item, index) => {
          const level = item.priority || item.severity || "neutral";
          return <article key={`${item.kind}-${item.created_at || item.detected_at}-${index}`} className={`operation-center-item tone-${tone(level)}`}>
            <span className="operation-item-light" aria-hidden="true" />
            <div className="operation-item-copy">
              <div className="operation-item-meta"><span>{String(item.kind || "item").replaceAll("_", " ")}</span><time>{dateText(item.created_at || item.detected_at)}</time></div>
              <h2>{item.title}</h2>
              <p>{item.detail || "—"}</p>
            </div>
            {item.path && <button type="button" onClick={() => onNavigate(item.path)} aria-label={`${item.title} — open`}>
              <span>کردنەوە</span><ArrowLeft aria-hidden="true" />
            </button>}
          </article>;
        })}
      </section>}
    </>}
  </div>;
}

export function ActionInbox(props) { return <Center kind="inbox" {...props} />; }
export function IntegrityCenter(props) { return <Center kind="integrity" {...props} />; }
