import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, History,
  Loader2, Minus, RefreshCw, XCircle, ZoomIn,
} from "lucide-react";
import {
  correctExtraction, diffVersions, loadDocumentDetail, loadReviewQueue,
  reviewEquation, reviewTotals, transitionDocument,
} from "../../services/receiptWorkspace";
import "./receipt-review.css";

const COPY = {
  ku: {
    title: "شوێنی پشکنینی فیش", subtitle: "وێنەی ڕەسەن و ئەوەی OCR خوێندوویەتی، تەنیشت یەک",
    queue: "ڕیزی چاوەڕوان", empty: "هیچ فیشێک چاوەڕوانی پشکنین نییە", loading: "بارکردن...",
    refresh: "نوێکردنەوە", prev: "پێشوو", next: "دواتر",
    original: "خوێندنەوەی ڕەسەن", current: "دوایین وەشان", version: "وەشان",
    equation: "پشکنینی ژمارەکان", reconciles: "ژمارەکان یەک دەگرنەوە", mismatch: "ژمارەکان یەک ناگرنەوە",
    undecidable: "ناتوانرێت بڕیار بدرێت — فیشەکە بڕی بنەڕەتی نەنووسیوە",
    gross: "کۆی گشتی", order: "بڕی بنەڕەتی", fee: "فی", net: "نەت", expected: "پێویستە بێت",
    treatment: "شێوازی فی", currency: "دراو", ref: "ژمارەی مامەڵە", payee: "وەرگر",
    accept: "پەسەندکردن", reject: "ڕەتکردنەوە", review: "بۆ پشکنینی دەستی",
    rejectReason: "هۆکاری ڕەتکردنەوە (لانیکەم ٨ پیت)",
    correct: "ڕاستکردنەوە", correctReason: "هۆکاری ڕاستکردنەوە (لانیکەم ٨ پیت)",
    save: "پاشەکەوت", cancel: "پاشگەزبوونەوە", working: "جێبەجێکردن...",
    history: "مێژووی قۆناغەکان", changes: "گۆڕانکارییەکان", before: "پێشتر", after: "ئێستا",
    totals: "کۆی کۆمەڵە", accepted: "پەسەندکراو", pending: "چاوەڕوان", rejected: "ڕەتکراو", duplicate: "دووبارە",
    noImage: "وێنە بەردەست نییە", zoomOut: "بچووککردنەوە", zoomIn: "گەورەکردن", reset: "گەڕاندنەوە",
    immutable: "خوێندنەوەی ڕەسەن هەرگیز ناگۆڕدرێت — ڕاستکردنەوە وەشانێکی نوێ دروست دەکات",
    treatments: {
      added_on_top: "لەسەر زیادکراوە", deducted_from_principal: "لە بڕی سەرەکی لابراوە",
      included_in_total: "لە کۆدا تێکەڵە", no_fee: "فی نییە", unknown: "نادیار",
    },
  },
};
COPY.en = COPY.ku; COPY.ar = COPY.ku;
const money = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function Field({ label, value, suffix }) {
  return (
    <div className="rrw-field">
      <span className="rrw-field-label">{label}</span>
      <span className="rrw-field-value">{value ?? "—"}{suffix ? ` ${suffix}` : ""}</span>
    </div>
  );
}

export function ReceiptReviewWorkspace({ client, lang = "ku", actorId = null, signedUrlFor = null, flash = () => {} }) {
  const copy = COPY[lang] || COPY.ku;
  const [queue, setQueue] = useState([]);
  const [index, setIndex] = useState(0);
  const [detail, setDetail] = useState(null);
  const [state, setState] = useState("loading");
  const [zoom, setZoom] = useState(1);
  const [imageUrl, setImageUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rejectText, setRejectText] = useState("");
  const [editing, setEditing] = useState(null);
  const [correctReason, setCorrectReason] = useState("");

  const loadQueue = useCallback(async () => {
    setState("loading");
    try {
      const rows = await loadReviewQueue(client);
      setQueue(rows);
      setIndex((i) => Math.min(i, Math.max(0, rows.length - 1)));
      setState("ready");
    } catch (e) { console.error("review queue", e); flash(String(e?.message || e)); setState("error"); }
  }, [client, flash]);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  const currentDoc = queue[index] || null;

  useEffect(() => {
    let alive = true;
    setDetail(null); setImageUrl(null); setZoom(1); setEditing(null); setRejectText("");
    if (!currentDoc) return;
    (async () => {
      try {
        const d = await loadDocumentDetail(client, currentDoc.id);
        if (!alive) return;
        setDetail(d);
        if (signedUrlFor && d.document.storagePath) {
          const url = await signedUrlFor(d.document.storagePath);
          if (alive) setImageUrl(url);
        }
      } catch (e) { if (alive) { console.error("review detail", e); flash(String(e?.message || e)); } }
    })();
    return () => { alive = false; };
  }, [client, currentDoc, signedUrlFor, flash]);

  const equation = useMemo(() => reviewEquation(detail?.current), [detail]);
  const changes = useMemo(
    () => (detail && detail.original !== detail.current ? diffVersions(detail.original, detail.current) : []),
    [detail]
  );
  const totals = useMemo(() => reviewTotals(queue), [queue]);

  const act = async (fn, message) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); flash(message); await loadQueue(); setDetail(null); }
    catch (e) { console.error("review action", e); flash(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  const accept = () => act(
    () => transitionDocument(client, { documentId: currentDoc.id, toState: "validated" }), "✓");
  const reject = () => act(
    () => transitionDocument(client, { documentId: currentDoc.id, toState: "rejected", reason: rejectText }), "✓");
  const saveCorrection = () => act(async () => {
    const changed = {};
    for (const [k, v] of Object.entries(editing || {})) {
      const base = detail.current?.[k];
      const next = ["grossAmount", "orderAmount", "feeAmount", "netAmount"].includes(k)
        ? (v === "" ? null : Number(v)) : v;
      if (String(next ?? "") !== String(base ?? "")) changed[k] = next;
    }
    await correctExtraction(client, {
      documentId: currentDoc.id, base: detail.current, changes: changed,
      reason: correctReason, correctedBy: actorId,
    });
  }, "✓");

  if (state === "loading") return <div className="rrw"><div className="rrw-empty">{copy.loading}</div></div>;

  return (
    <section className="rrw" aria-labelledby="rrw-title">
      <header className="rrw-header">
        <div>
          <h2 id="rrw-title">{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <button type="button" className="rrw-btn" onClick={loadQueue}>
          <RefreshCw aria-hidden="true" /> {copy.refresh}
        </button>
      </header>

      <div className="rrw-totals" role="status">
        <span><b>{totals.accepted}</b> {copy.accepted}</span>
        <span><b>{totals.pending}</b> {copy.pending}</span>
        <span><b>{totals.rejected}</b> {copy.rejected}</span>
        <span><b>{totals.duplicate}</b> {copy.duplicate}</span>
      </div>

      {queue.length === 0 ? <p className="rrw-empty">{copy.empty}</p> : (
        <>
          <nav className="rrw-nav" aria-label={copy.queue}>
            <button type="button" className="rrw-btn" disabled={index === 0}
                    onClick={() => setIndex((i) => i - 1)}><ArrowRight aria-hidden="true" /> {copy.prev}</button>
            <span className="rrw-counter">{index + 1} / {queue.length}</span>
            <button type="button" className="rrw-btn" disabled={index >= queue.length - 1}
                    onClick={() => setIndex((i) => i + 1)}>{copy.next} <ArrowLeft aria-hidden="true" /></button>
          </nav>

          <div className="rrw-split">
            {/* Left: the original evidence, always visible beside the numbers. */}
            <section className="rrw-image" aria-label={copy.original}>
              <div className="rrw-zoom" dir="ltr">
                <button type="button" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
                        aria-label={copy.zoomOut}><Minus aria-hidden="true" /></button>
                <button type="button" onClick={() => setZoom(1)} aria-label={copy.reset}>{Math.round(zoom * 100)}%</button>
                <button type="button" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
                        aria-label={copy.zoomIn}><ZoomIn aria-hidden="true" /></button>
              </div>
              <div className="rrw-image-frame" tabIndex={0}>
                {imageUrl
                  ? <img src={imageUrl} alt={copy.original} style={{ transform: `scale(${zoom})` }} />
                  : <div className="rrw-empty">{copy.noImage}</div>}
              </div>
            </section>

            <section className="rrw-detail" aria-label={copy.current}>
              {!detail ? <div className="rrw-empty">{copy.loading}</div> : (
                <>
                  {/* The arithmetic verdict, stated rather than left for the reviewer to compute. */}
                  {equation && (
                    <div className={`rrw-equation ${equation.reconciles === true ? "is-ok"
                      : equation.reconciles === false ? "is-bad" : "is-unknown"}`}>
                      {equation.reconciles === true ? <CheckCircle2 aria-hidden="true" />
                        : <AlertTriangle aria-hidden="true" />}
                      <span>
                        {equation.reconciles === true ? copy.reconciles
                          : equation.reconciles === false ? copy.mismatch : copy.undecidable}
                        {equation.expectedGross != null && equation.reconciles === false && (
                          <> — {copy.expected} {money(equation.expectedGross)}</>
                        )}
                      </span>
                    </div>
                  )}

                  <div className="rrw-fields">
                    <Field label={copy.gross} value={money(detail.current?.grossAmount)} suffix={detail.current?.currency} />
                    <Field label={copy.order} value={money(detail.current?.orderAmount)} suffix={detail.current?.currency} />
                    <Field label={copy.fee} value={money(detail.current?.feeAmount)} suffix={detail.current?.currency} />
                    <Field label={copy.net} value={money(detail.current?.netAmount)} suffix={detail.current?.currency} />
                    <Field label={copy.treatment} value={copy.treatments[detail.current?.feeTreatment] || detail.current?.feeTreatment} />
                    <Field label={copy.currency} value={detail.current?.currency} />
                    <Field label={copy.ref} value={detail.current?.refNo} />
                    <Field label={copy.payee} value={detail.current?.payee} />
                  </div>

                  {/* A correction never overwrites: show what changed from the original reading. */}
                  {changes.length > 0 && (
                    <div className="rrw-changes">
                      <h3><History aria-hidden="true" /> {copy.changes}</h3>
                      {changes.map((c) => (
                        <div key={c.field} className="rrw-change">
                          <span>{c.label}</span>
                          <span className="rrw-before">{String(c.before ?? "—")}</span>
                          <span>→</span>
                          <span className="rrw-after">{String(c.after ?? "—")}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <p className="rrw-note">{copy.immutable}</p>

                  {editing ? (
                    <div className="rrw-edit">
                      {["grossAmount", "orderAmount", "feeAmount", "netAmount", "currency", "refNo", "payee"].map((k) => (
                        <label key={k}>
                          {copy[{ grossAmount: "gross", orderAmount: "order", feeAmount: "fee",
                                  netAmount: "net", currency: "currency", refNo: "ref", payee: "payee" }[k]]}
                          <input value={editing[k] ?? ""} onChange={(e) => setEditing({ ...editing, [k]: e.target.value })} />
                        </label>
                      ))}
                      <label className="rrw-wide">
                        {copy.correctReason}
                        <input value={correctReason} onChange={(e) => setCorrectReason(e.target.value)} />
                      </label>
                      <div className="rrw-actions">
                        <button type="button" className="rrw-btn is-pos"
                                disabled={busy || correctReason.trim().length < 8} onClick={saveCorrection}>
                          {busy ? <Loader2 className="rrw-spin" aria-hidden="true" /> : null} {copy.save}
                        </button>
                        <button type="button" className="rrw-btn" onClick={() => setEditing(null)}>{copy.cancel}</button>
                      </div>
                    </div>
                  ) : (
                    <div className="rrw-actions">
                      <button type="button" className="rrw-btn is-pos" disabled={busy} onClick={accept}>
                        <CheckCircle2 aria-hidden="true" /> {copy.accept}
                      </button>
                      <button type="button" className="rrw-btn"
                              onClick={() => setEditing({ ...detail.current })}>{copy.correct}</button>
                    </div>
                  )}

                  <div className="rrw-reject">
                    <input placeholder={copy.rejectReason} value={rejectText}
                           onChange={(e) => setRejectText(e.target.value)} />
                    <button type="button" className="rrw-btn is-neg"
                            disabled={busy || rejectText.trim().length < 8} onClick={reject}>
                      <XCircle aria-hidden="true" /> {copy.reject}
                    </button>
                  </div>

                  {detail.history?.length > 0 && (
                    <div className="rrw-history">
                      <h3>{copy.history}</h3>
                      <ol>
                        {detail.history.map((h, i) => (
                          <li key={i}>
                            <span>{h.from || "—"} → <b>{h.to}</b></span>
                            <time>{h.at ? new Date(h.at).toLocaleString("en-GB") : ""}</time>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}
