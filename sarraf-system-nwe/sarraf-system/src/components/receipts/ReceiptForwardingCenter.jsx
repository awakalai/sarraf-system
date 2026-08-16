import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, CheckCircle2, Eye, Loader2, RefreshCw, Send, Truck, UserRound,
} from "lucide-react";
import {
  forwardCommandKey, forwardReceipts, loadForwardingReconciliation,
  partitionForForwarding, recipientRoleFor, skipReasonText,
} from "../../services/receiptForwarding";
import "./receipt-forwarding.css";

const COPY = {
  ku: {
    title: "ناردنی فیش بۆ خاوەنەکەی",
    subtitle: "تەنها فیشی پەسەندکراو دەنێردرێت — وەرگر لە جۆری مامەڵەکەوە دێت، نەک لە هەڵبژاردنی تۆوە",
    refresh: "نوێکردنەوە", loading: "بارکردن...", empty: "هیچ فیشێکی پەسەندکراو بۆ ناردن نییە",
    recipient: "وەرگر", pickRecipient: "وەرگر هەڵبژێرە",
    eligible: "ئامادەی ناردن", blocked: "نانێردرێت", selected: "هەڵبژێردراو",
    selectAll: "هەمووی", clearAll: "لابردن",
    reason: "هۆکاری ناردن (لانیکەم ٨ پیت)", send: "ناردن", working: "دەنێردرێت...",
    sent: "نێردرا", skipped: "نەنێردرا",
    flows: {
      customer_sells_to_zeman: "کڕیار فرۆشتوویەتی بە زەمان → بۆ هاوبەش",
      customer_buys_from_zeman: "کڕیار کڕیویەتی لە زەمان → بۆ کڕیار",
    },
    wantsPartner: "ئەم فیشە بۆ هاوبەش دەنێردرێت", wantsCustomer: "ئەم فیشە بۆ کڕیار دەنێردرێت",
    recon: "پێکهاتنەوەی گەیاندن", reconForwarded: "نێردراو", reconSent: "لە ڕێگادا",
    reconDelivered: "گەیشتوو", reconSeen: "بینراو", reconFailed: "نەگەیشتوو",
    reconNote: "ناردن، گەیشتن و بینین سێ شتی جیاوازن و بە جیا دەژمێردرێن",
    result: "ئەنجام", replayed: "ئەم فەرمانە پێشتر جێبەجێکرابوو — دووبارە نەنێردرا",
    noRecipient: "سەرەتا وەرگر هەڵبژێرە", noneSelected: "هیچ فیشێک هەڵنەبژێردراوە",
    roles: { customer: "کڕیار", partner: "هاوبەش" },
    view: "بینینی وێنە",
  },
};
COPY.en = COPY.ku; COPY.ar = COPY.ku;

const money = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function ReceiptForwardingCenter({
  client, lang = "ku", people = [], flash = () => {}, signedUrlFor = null,
}) {
  const copy = COPY[lang] || COPY.ku;
  const [docs, setDocs] = useState([]);
  const [state, setState] = useState("loading");
  const [toActorId, setToActorId] = useState("");
  const [picked, setPicked] = useState(() => new Set());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [recon, setRecon] = useState(null);
  // Callers pass a fresh `flash` on every render. Holding it in a ref keeps `load` stable, so
  // the queue is fetched when it needs to be — not once per render of whatever renders this.
  const flashRef = useRef(flash);
  flashRef.current = flash;

  const recipients = useMemo(
    () => (people || []).filter((p) => (p.role === "customer" || p.role === "partner") && !p.deleted),
    [people],
  );
  const recipient = useMemo(() => recipients.find((p) => p.id === toActorId) || null, [recipients, toActorId]);

  const load = useCallback(async () => {
    setState("loading");
    try {
      // The server's RLS decides what an operator may see; nothing here widens it.
      const { data, error } = await client
        .from("receipt_documents")
        .select("id,flow,state,expected_currency,customer_id,partner_id,transaction_id,storage_path,received_at")
        .in("state", ["accepted", "finalized"])
        .order("received_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      setDocs(data || []);
      setState("ready");
      setRecon(await loadForwardingReconciliation(client).catch(() => null));
    } catch (e) {
      console.error("forwarding queue", e);
      flashRef.current(String(e?.message || e));
      setState("error");
    }
  }, [client]);

  useEffect(() => { load(); }, [load]);

  const { eligible, blocked } = useMemo(
    () => partitionForForwarding(docs, recipient?.role || null),
    [docs, recipient],
  );

  // A receipt that stops being eligible — because the recipient changed — must also stop being
  // selected, or the operator would send a batch that no longer matches what they can see.
  useEffect(() => {
    setPicked((prev) => {
      const ok = new Set(eligible.map((d) => d.id));
      const next = new Set([...prev].filter((id) => ok.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [eligible]);

  const toggle = (id) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const send = async () => {
    if (busy) return;
    if (!toActorId) { flash(copy.noRecipient); return; }
    if (!picked.size) { flash(copy.noneSelected); return; }
    setBusy(true);
    setResult(null);
    try {
      const r = await forwardReceipts(client, {
        documentIds: [...picked],
        toActorId,
        reason,
        commandKey: forwardCommandKey(toActorId),
      });
      setResult(r);
      setPicked(new Set());
      setReason("");
      await load();
    } catch (e) {
      console.error("forward", e);
      flash(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const openImage = async (path) => {
    if (!signedUrlFor || !path) return;
    try {
      const url = await signedUrlFor(path);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) { flash(String(e?.message || e)); }
  };

  const nameOf = (id) => (people || []).find((p) => p.id === id)?.name || id || "—";

  return (
    <section className="fwd-panel" aria-labelledby="fwd-title">
      <header className="fwd-header">
        <div className="fwd-icon"><Truck aria-hidden="true" /></div>
        <div>
          <h2 id="fwd-title">{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <button type="button" className="fwd-refresh" onClick={load} disabled={busy}>
          <RefreshCw aria-hidden="true" /> {copy.refresh}
        </button>
      </header>

      {recon && (
        <div className="fwd-recon" role="status">
          <h3>{copy.recon}</h3>
          <div className="fwd-recon-grid">
            <div className="fwd-recon-cell"><span>{copy.reconForwarded}</span><b>{recon.forwarded}</b></div>
            <div className="fwd-recon-cell"><span>{copy.reconSent}</span><b>{recon.sent}</b></div>
            <div className="fwd-recon-cell"><span>{copy.reconDelivered}</span><b>{recon.delivered}</b></div>
            <div className="fwd-recon-cell"><span>{copy.reconSeen}</span><b>{recon.seen}</b></div>
            <div className={`fwd-recon-cell ${recon.failed ? "is-bad" : ""}`}><span>{copy.reconFailed}</span><b>{recon.failed}</b></div>
          </div>
          <p className="fwd-note">{copy.reconNote}</p>
        </div>
      )}

      <div className="fwd-controls">
        <label className="fwd-field">
          <span>{copy.recipient}</span>
          <select value={toActorId} onChange={(e) => setToActorId(e.target.value)}
            aria-label={copy.recipient} required>
            <option value="">{copy.pickRecipient}</option>
            {recipients.map((p) => (
              <option key={p.id} value={p.id}>{p.name} — {copy.roles[p.role] || p.role}</option>
            ))}
          </select>
        </label>
        <label className="fwd-field fwd-field-wide">
          <span>{copy.reason}</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={700}
            aria-label={copy.reason} />
        </label>
        <button type="button" className="fwd-send" onClick={send} disabled={busy || !picked.size || !toActorId}>
          {busy ? <Loader2 className="fwd-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
          {busy ? copy.working : `${copy.send} (${picked.size})`}
        </button>
      </div>

      {result && (
        <div className={`fwd-result ${result.skipped.length ? "is-mixed" : "is-ok"}`} role="status">
          <h3><CheckCircle2 aria-hidden="true" /> {copy.result}</h3>
          <p>{copy.sent}: <b>{result.forwarded}</b>{result.replayed ? ` — ${copy.replayed}` : ""}</p>
          {result.skipped.length > 0 && (
            <ul className="fwd-skip-list">
              {result.skipped.map((s) => (
                <li key={s.id}><code>{s.id}</code> — {s.text}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {state === "loading" && <div className="fwd-empty"><Loader2 className="fwd-spin" /> {copy.loading}</div>}

      {state === "ready" && (
        <>
          <div className="fwd-section">
            <div className="fwd-section-head">
              <h3>{copy.eligible} <span className="fwd-count">{eligible.length}</span></h3>
              <div className="fwd-bulk">
                <button type="button" onClick={() => setPicked(new Set(eligible.map((d) => d.id)))}
                  disabled={!eligible.length}>{copy.selectAll}</button>
                <button type="button" onClick={() => setPicked(new Set())} disabled={!picked.size}>{copy.clearAll}</button>
              </div>
            </div>
            {eligible.length === 0 ? (
              <div className="fwd-empty">{copy.empty}</div>
            ) : (
              <ul className="fwd-list">
                {eligible.map((d) => {
                  const wants = recipientRoleFor(d.flow);
                  return (
                    <li key={d.id} className={picked.has(d.id) ? "is-picked" : ""}>
                      <label className="fwd-row">
                        <input type="checkbox" checked={picked.has(d.id)} onChange={() => toggle(d.id)}
                          aria-label={`${copy.send} ${d.id}`} />
                        <span className="fwd-row-main">
                          <span className="fwd-row-id">{d.id}</span>
                          <span className="fwd-row-flow">{copy.flows[d.flow] || d.flow}</span>
                        </span>
                        <span className="fwd-row-meta">
                          <span className="fwd-badge">{d.state}</span>
                          {wants && (
                            <span className="fwd-wants">
                              <UserRound /> {wants === "partner" ? copy.wantsPartner : copy.wantsCustomer}
                            </span>
                          )}
                        </span>
                      </label>
                      {signedUrlFor && d.storage_path && (
                        <button type="button" className="fwd-view" onClick={() => openImage(d.storage_path)}
                          aria-label={`${copy.view} ${d.id}`}>
                          <Eye /> {copy.view}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Named, not hidden: an operator who cannot see why a receipt did not go will
              assume the system lost it. */}
          {blocked.length > 0 && (
            <div className="fwd-section">
              <div className="fwd-section-head">
                <h3><AlertTriangle /> {copy.blocked} <span className="fwd-count">{blocked.length}</span></h3>
              </div>
              <ul className="fwd-list is-blocked">
                {blocked.map((d) => (
                  <li key={d.id}>
                    <div className="fwd-row">
                      <span className="fwd-row-main">
                        <span className="fwd-row-id">{d.id}</span>
                        <span className="fwd-row-flow">
                          {d.customer_id ? nameOf(d.customer_id) : d.partner_id ? nameOf(d.partner_id) : ""}
                        </span>
                      </span>
                      <span className="fwd-row-meta">
                        <span className="fwd-badge is-blocked">{skipReasonText(d.blockedBy)}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {state === "error" && (
        <div className="fwd-empty is-error"><AlertTriangle /> {copy.loading}</div>
      )}
    </section>
  );
}
