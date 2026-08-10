import React, { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Minus,
  Pencil,
  Receipt,
  RotateCcw,
  X,
  XCircle,
  ZoomIn,
} from "lucide-react";

export const RECEIPT_LIFECYCLE = [
  ["capture", "Received", "وەرگیرا"],
  ["read", "Reading", "دەخوێندرێتەوە"],
  ["review", "Needs Review", "پشکنین پێویستە"],
  ["verify", "Verified", "پشتڕاستکراو"],
  ["match", "Matched", "بەستراو"],
  ["archive", "Archived", "ئەرشیفکراو"],
];

export function ReceiptLifecycle({ stage = "capture", compact = false }) {
  const active = Math.max(0, RECEIPT_LIFECYCLE.findIndex(([key]) => key === stage));
  return (
    <nav aria-label="Receipt lifecycle" className="rounded-[var(--r)] p-3 md:p-4 overflow-x-auto"
      style={{ background: "var(--surf)", border: "1px solid var(--line)", boxShadow: "var(--sh-1)" }}>
      <ol className="flex items-center min-w-[720px]">
        {RECEIPT_LIFECYCLE.map(([key, label, localizedLabel], index) => {
          const done = index < active;
          const current = index === active;
          return (
            <React.Fragment key={key}>
              <li className="flex items-center gap-2 shrink-0" aria-current={current ? "step" : undefined}>
                <span className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold"
                  style={done || current
                    ? { background: done ? "var(--pos)" : "var(--ac)", color: "#fff" }
                    : { background: "var(--surf-3)", color: "var(--txt-3)", border: "1px solid var(--line)" }}>
                  {done ? <CheckCircle2 aria-hidden="true" className="w-3.5 h-3.5" /> : index + 1}
                </span>
                <span className={`${compact ? "text-[10px]" : "text-[11px]"} font-semibold whitespace-nowrap`}
                  style={{ color: current ? "var(--txt)" : done ? "var(--pos)" : "var(--txt-3)" }}>
                  <span dir="ltr">{label}</span> · {localizedLabel}
                </span>
              </li>
              {index < RECEIPT_LIFECYCLE.length - 1 && (
                <span aria-hidden="true" className="h-px min-w-6 flex-1 mx-2" style={{ background: index < active ? "var(--pos)" : "var(--line-2)" }} />
              )}
            </React.Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

export function ReceiptSmartInspector({
  receipt: r, data, onEdit, onConfirm, onReject, onRetry, onClose,
  Card, Btn, Pill, clamp01, fmtMoney, num, platMeta,
}) {
  const [zoom, setZoom] = useState(1);
  if (!r) return null;
  const confidence = (key) => {
    const raw = r.fieldConfidence?.[key];
    if (raw == null || !Number.isFinite(Number(raw))) return { label: "Unknown", icon: AlertTriangle, color: "var(--txt-3)", bg: "var(--surf-3)" };
    const pct = Math.round(clamp01(raw) * 100);
    if (pct >= 80) return { label: `Verified · ${pct}%`, icon: CheckCircle2, color: "var(--pos)", bg: "color-mix(in srgb, var(--pos) 9%, var(--surf))" };
    if (pct >= 60) return { label: `Review · ${pct}%`, icon: AlertTriangle, color: "var(--warn)", bg: "color-mix(in srgb, var(--warn) 10%, var(--surf))" };
    return { label: `Invalid / uncertain · ${pct}%`, icon: XCircle, color: "var(--neg)", bg: "color-mix(in srgb, var(--neg) 9%, var(--surf))" };
  };
  const fields = [
    ["amount", "Amount / Gross", Number(r.amount) > 0 ? `${fmtMoney(data, r.amount, r.currency)} ${r.currency || ""}` : "—"],
    ["currency", "Currency", r.currency || "—"],
    ["fee", "Fee", Number.isFinite(Number(r.fee)) ? fmtMoney(data, r.fee, r.currency) : "—"],
    ["netAmount", "Net", Number.isFinite(Number(r.net)) ? fmtMoney(data, r.net, r.currency) : "—"],
    ["receiver", "Payee", r.receiver || r.merchantName || "—"],
    ["refNo", "Order No.", r.refNo || "—"],
    ["merchantOrderNo", "Merchant Order No.", r.merchantOrderNo || "—"],
    ["paymentMethod", "Card / Method", r.paymentMethod || (r.cardLast4 ? `****${r.cardLast4}` : "—")],
    ["platform", "Platform", r.platform ? platMeta(r.platform).ku : (r.bank || "—")],
    ["txDate", "Date / Time", [r.txDate, r.txTime].filter(Boolean).join(" · ") || "—"],
  ];
  const overall = r.confidence == null ? null : Math.round(clamp01(r.confidence) * 100);
  const stateTone = r.status === "ok" ? "green" : r.status === "suspect" || r.status === "retry" ? "amber" : r.status === "processing" ? "slate" : "red";
  const stateLabel = { processing: "Reading", ok: "Verified", suspect: "Needs Review", retry: "Reading paused", dup: "Duplicate", error: "Invalid / error" }[r.status] || r.status;

  return (
    <Card className="p-0 overflow-hidden">
      <div className="p-4 border-b border-[var(--line)] flex items-center justify-between gap-3">
        <div><div className="text-[13px] font-bold text-[var(--txt)]">Smart Inspector</div><div className="text-[10.5px] text-[var(--txt-3)] mt-0.5">وێنە و خانە هەستیارەکان لە یەک شوێن بپشکنە.</div></div>
        <button type="button" onClick={onClose} className="p-2 rounded-lg text-[var(--txt-3)] hover:bg-[var(--surf-3)]" aria-label="Close inspector"><X aria-hidden="true" className="w-4 h-4" /></button>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(340px,1.1fr)_minmax(0,0.9fr)]">
        <section aria-label="Receipt image viewer" className="min-h-[320px] lg:min-h-[560px] p-3 flex flex-col" style={{ background: "linear-gradient(145deg, var(--surf-3), var(--bg))" }}>
          <div className="flex justify-end gap-1.5 pb-2" dir="ltr">
            <button type="button" onClick={() => setZoom((v) => Math.max(0.75, v - 0.25))} aria-label="Zoom out" className="p-2 rounded-lg bg-[var(--surf)] text-[var(--txt-2)] border border-[var(--line)]"><Minus className="w-4 h-4" /></button>
            <button type="button" onClick={() => setZoom(1)} aria-label="Reset zoom" className="px-3 rounded-lg bg-[var(--surf)] text-[11px] font-bold text-[var(--txt-2)] border border-[var(--line)]" style={num}>{Math.round(zoom * 100)}%</button>
            <button type="button" onClick={() => setZoom((v) => Math.min(3, v + 0.25))} aria-label="Zoom in" className="p-2 rounded-lg bg-[var(--surf)] text-[var(--txt-2)] border border-[var(--line)]"><ZoomIn className="w-4 h-4" /></button>
          </div>
          <div className="flex-1 overflow-auto flex items-center justify-center rounded-xl" tabIndex={0}>
            {r.url ? <img src={r.url} alt="Uploaded payment receipt" className="max-w-full max-h-[500px] object-contain rounded-xl transition-transform origin-center" style={{ transform: `scale(${zoom})` }} /> : <div className="text-center text-[var(--txt-3)]">{r.status === "processing" ? <RotateCcw className="w-7 h-7 animate-spin mx-auto" /> : <Receipt className="w-8 h-8 mx-auto" />}<div className="text-xs mt-2">وێنە ئامادە نییە</div></div>}
          </div>
        </section>
        <section aria-label="Extracted receipt fields" className="p-4 md:p-5">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-4"><div className="flex items-center gap-2"><Pill tone={stateTone}>{stateLabel}</Pill>{overall != null && <span className="text-[11px] font-bold" style={{ color: overall >= 80 ? "var(--pos)" : overall >= 60 ? "var(--warn)" : "var(--neg)", ...num }}>AI {overall}%</span>}</div>{r.platform && <span className="text-[11px] text-[var(--txt-3)]">{platMeta(r.platform).ku}</span>}</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">{fields.map(([key, label, value]) => { const tone = confidence(key); const ToneIcon = tone.icon; return <div key={key} className="rounded-xl p-3" style={{ background: tone.bg, border: "1px solid var(--line)" }}><div className="flex items-center justify-between gap-2"><span className="text-[10px] text-[var(--txt-3)]">{label}</span><span className="text-[9px] font-bold flex items-center gap-1" style={{ color: tone.color, ...num }}><ToneIcon aria-hidden="true" className="w-3 h-3" />{tone.label}</span></div><div className="text-[12px] font-semibold mt-1 break-words" style={{ color: "var(--txt)", ...num }}>{value}</div></div>; })}</div>
          {r.note && <div role={r.status === "error" ? "alert" : "status"} className="mt-3 p-3 rounded-xl text-[11px] leading-relaxed" style={{ background: "var(--surf-3)", color: r.status === "suspect" ? "var(--warn)" : r.status === "error" || r.status === "dup" ? "var(--neg)" : "var(--txt-2)" }}>{r.note}</div>}
          <div className="flex flex-wrap gap-2 mt-4">{r.status !== "processing" && r.status !== "dup" && <Btn kind="ghost" onClick={onEdit}><Pencil className="w-4 h-4" /> دەستکاری</Btn>}{r.status === "suspect" && <Btn onClick={onConfirm}><CheckCircle2 className="w-4 h-4" /> پشتڕاستکردنەوە</Btn>}{r.ocrImage && ["retry", "suspect", "error"].includes(r.status) && <Btn kind="ghost" onClick={onRetry}><RotateCcw className="w-4 h-4" /> دووبارە خوێندنەوە</Btn>}{r.status !== "processing" && r.status !== "dup" && <Btn kind="ghost" style={{ color: "var(--neg)" }} onClick={onReject}><XCircle className="w-4 h-4" /> ڕەتکردنەوە</Btn>}</div>
        </section>
      </div>
    </Card>
  );
}
