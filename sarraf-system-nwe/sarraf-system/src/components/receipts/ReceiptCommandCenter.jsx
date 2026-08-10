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

const COPY = {
  ku: { lifecycle: "ڕێڕەوی فیش", stages: ["وەرگیرا", "دەخوێندرێتەوە", "پشکنین پێویستە", "پشتڕاستکراو", "بەستراو", "ئەرشیفکراو"], inspector: "پشکنەری زیرەک", inspectorHint: "وێنە و خانە هەستیارەکان لە یەک شوێن بپشکنە.", close: "داخستنی پشکنەر", imageViewer: "بینەری وێنەی فیش", fields: "خانە خوێندراوەکان", zoomOut: "بچووککردنەوە", resetZoom: "گەڕاندنەوەی قەبارە", zoomIn: "گەورەکردن", noImage: "وێنە ئامادە نییە", uploadedAlt: "وێنەی فیشی پارەدان", edit: "دەستکاری", confirm: "پشتڕاستکردنەوە", retry: "دووبارە خوێندنەوە", reject: "ڕەتکردنەوە", unknown: "نادیار", verified: "پشتڕاستکراو", review: "پشکنین", uncertain: "نادڵنیا", reading: "خوێندنەوە", paused: "خوێندنەوە وەستاوە", duplicate: "دووبارە", invalid: "نادروست / هەڵە", fieldLabels: ["بڕ / کۆی گشتی", "دراو", "فی", "بڕی نەت", "وەرگر", "ژمارەی مامەڵە", "ژمارەی مامەڵەی فرۆشیار", "کارت / شێوازی پارەدان", "پلاتفۆرم", "بەروار / کات"] },
  en: { lifecycle: "Receipt lifecycle", stages: ["Received", "Reading", "Needs review", "Verified", "Matched", "Archived"], inspector: "Smart Inspector", inspectorHint: "Review the image and every sensitive field in one place.", close: "Close inspector", imageViewer: "Receipt image viewer", fields: "Extracted receipt fields", zoomOut: "Zoom out", resetZoom: "Reset zoom", zoomIn: "Zoom in", noImage: "Image unavailable", uploadedAlt: "Uploaded payment receipt", edit: "Edit", confirm: "Confirm", retry: "Read again", reject: "Reject", unknown: "Unknown", verified: "Verified", review: "Review", uncertain: "Invalid / uncertain", reading: "Reading", paused: "Reading paused", duplicate: "Duplicate", invalid: "Invalid / error", fieldLabels: ["Amount / gross", "Currency", "Fee", "Net amount", "Payee", "Order number", "Merchant order number", "Card / payment method", "Platform", "Date / time"] },
  ar: { lifecycle: "دورة الإيصال", stages: ["مستلم", "قيد القراءة", "بحاجة إلى مراجعة", "موثّق", "مرتبط", "مؤرشف"], inspector: "الفاحص الذكي", inspectorHint: "راجع الصورة وجميع الحقول الحساسة في مكان واحد.", close: "إغلاق الفاحص", imageViewer: "عارض صورة الإيصال", fields: "حقول الإيصال المستخرجة", zoomOut: "تصغير", resetZoom: "إعادة ضبط التكبير", zoomIn: "تكبير", noImage: "الصورة غير متاحة", uploadedAlt: "صورة إيصال الدفع المرفوعة", edit: "تعديل", confirm: "تأكيد", retry: "إعادة القراءة", reject: "رفض", unknown: "غير معروف", verified: "موثّق", review: "مراجعة", uncertain: "غير صالح / غير مؤكد", reading: "قيد القراءة", paused: "القراءة متوقفة", duplicate: "مكرر", invalid: "غير صالح / خطأ", fieldLabels: ["المبلغ / الإجمالي", "العملة", "الرسوم", "المبلغ الصافي", "المستفيد", "رقم الطلب", "رقم طلب التاجر", "البطاقة / طريقة الدفع", "المنصة", "التاريخ / الوقت"] },
};
const localeKey = (lang) => lang === "en" || lang === "ar" ? lang : "ku";
export const RECEIPT_LIFECYCLE = ["capture", "read", "review", "verify", "match", "archive"];

export function ReceiptLifecycle({ stage = "capture", compact = false, lang = "ku" }) {
  const copy = COPY[localeKey(lang)];
  const active = Math.max(0, RECEIPT_LIFECYCLE.findIndex((key) => key === stage));
  return (
    <nav aria-label={copy.lifecycle} className="rounded-[var(--r)] p-3 md:p-4 overflow-x-auto"
      style={{ background: "var(--surf)", border: "1px solid var(--line)", boxShadow: "var(--sh-1)" }}>
      <ol className="flex items-center min-w-[720px]">
        {RECEIPT_LIFECYCLE.map((key, index) => {
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
                  {copy.stages[index]}
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
  Card, Btn, Pill, clamp01, fmtMoney, num, platMeta, lang = "ku",
}) {
  const copy = COPY[localeKey(lang)];
  const [zoom, setZoom] = useState(1);
  if (!r) return null;
  const confidence = (key) => {
    const raw = r.fieldConfidence?.[key];
    if (raw == null || !Number.isFinite(Number(raw))) return { label: copy.unknown, icon: AlertTriangle, color: "var(--txt-3)", bg: "var(--surf-3)" };
    const pct = Math.round(clamp01(raw) * 100);
    if (pct >= 80) return { label: `${copy.verified} · ${pct}%`, icon: CheckCircle2, color: "var(--pos)", bg: "color-mix(in srgb, var(--pos) 9%, var(--surf))" };
    if (pct >= 60) return { label: `${copy.review} · ${pct}%`, icon: AlertTriangle, color: "var(--warn)", bg: "color-mix(in srgb, var(--warn) 10%, var(--surf))" };
    return { label: `${copy.uncertain} · ${pct}%`, icon: XCircle, color: "var(--neg)", bg: "color-mix(in srgb, var(--neg) 9%, var(--surf))" };
  };
  const fields = [
    ["amount", copy.fieldLabels[0], Number(r.amount) > 0 ? `${fmtMoney(data, r.amount, r.currency)} ${r.currency || ""}` : "—"], ["currency", copy.fieldLabels[1], r.currency || "—"], ["fee", copy.fieldLabels[2], Number.isFinite(Number(r.fee)) ? fmtMoney(data, r.fee, r.currency) : "—"], ["netAmount", copy.fieldLabels[3], Number.isFinite(Number(r.net)) ? fmtMoney(data, r.net, r.currency) : "—"], ["receiver", copy.fieldLabels[4], r.receiver || r.merchantName || "—"], ["refNo", copy.fieldLabels[5], r.refNo || "—"], ["merchantOrderNo", copy.fieldLabels[6], r.merchantOrderNo || "—"], ["paymentMethod", copy.fieldLabels[7], r.paymentMethod || (r.cardLast4 ? `****${r.cardLast4}` : "—")], ["platform", copy.fieldLabels[8], r.platform ? platMeta(r.platform).ku : (r.bank || "—")], ["txDate", copy.fieldLabels[9], [r.txDate, r.txTime].filter(Boolean).join(" · ") || "—"],
  ];
  const overall = r.confidence == null ? null : Math.round(clamp01(r.confidence) * 100);
  const stateTone = r.status === "ok" ? "green" : r.status === "suspect" || r.status === "retry" ? "amber" : r.status === "processing" ? "slate" : "red";
  const stateLabel = { processing: copy.reading, ok: copy.verified, suspect: copy.review, retry: copy.paused, dup: copy.duplicate, error: copy.invalid }[r.status] || r.status;

  return (
    <Card className="p-0 overflow-hidden">
      <div className="p-4 border-b border-[var(--line)] flex items-center justify-between gap-3">
        <div><div className="text-[13px] font-bold text-[var(--txt)]">{copy.inspector}</div><div className="text-[10.5px] text-[var(--txt-3)] mt-0.5">{copy.inspectorHint}</div></div>
        <button type="button" onClick={onClose} className="p-2 rounded-lg text-[var(--txt-3)] hover:bg-[var(--surf-3)]" aria-label={copy.close}><X aria-hidden="true" className="w-4 h-4" /></button>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(340px,1.1fr)_minmax(0,0.9fr)]">
        <section aria-label={copy.imageViewer} className="min-h-[320px] lg:min-h-[560px] p-3 flex flex-col" style={{ background: "linear-gradient(145deg, var(--surf-3), var(--bg))" }}>
          <div className="flex justify-end gap-1.5 pb-2" dir="ltr">
            <button type="button" onClick={() => setZoom((v) => Math.max(0.75, v - 0.25))} aria-label={copy.zoomOut} className="p-2 rounded-lg bg-[var(--surf)] text-[var(--txt-2)] border border-[var(--line)]"><Minus className="w-4 h-4" /></button>
            <button type="button" onClick={() => setZoom(1)} aria-label={copy.resetZoom} className="px-3 rounded-lg bg-[var(--surf)] text-[11px] font-bold text-[var(--txt-2)] border border-[var(--line)]" style={num}>{Math.round(zoom * 100)}%</button>
            <button type="button" onClick={() => setZoom((v) => Math.min(3, v + 0.25))} aria-label={copy.zoomIn} className="p-2 rounded-lg bg-[var(--surf)] text-[var(--txt-2)] border border-[var(--line)]"><ZoomIn className="w-4 h-4" /></button>
          </div>
          <div className="flex-1 overflow-auto flex items-center justify-center rounded-xl" tabIndex={0}>
            {r.url ? <img src={r.url} alt={copy.uploadedAlt} className="max-w-full max-h-[500px] object-contain rounded-xl transition-transform origin-center" style={{ transform: `scale(${zoom})` }} /> : <div className="text-center text-[var(--txt-3)]">{r.status === "processing" ? <RotateCcw className="w-7 h-7 animate-spin mx-auto" /> : <Receipt className="w-8 h-8 mx-auto" />}<div className="text-xs mt-2">{copy.noImage}</div></div>}
          </div>
        </section>
        <section aria-label={copy.fields} className="p-4 md:p-5">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-4"><div className="flex items-center gap-2"><Pill tone={stateTone}>{stateLabel}</Pill>{overall != null && <span className="text-[11px] font-bold" style={{ color: overall >= 80 ? "var(--pos)" : overall >= 60 ? "var(--warn)" : "var(--neg)", ...num }}>AI {overall}%</span>}</div>{r.platform && <span className="text-[11px] text-[var(--txt-3)]">{platMeta(r.platform).ku}</span>}</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">{fields.map(([key, label, value]) => { const tone = confidence(key); const ToneIcon = tone.icon; return <div key={key} className="rounded-xl p-3" style={{ background: tone.bg, border: "1px solid var(--line)" }}><div className="flex items-center justify-between gap-2"><span className="text-[10px] text-[var(--txt-3)]">{label}</span><span className="text-[9px] font-bold flex items-center gap-1" style={{ color: tone.color, ...num }}><ToneIcon aria-hidden="true" className="w-3 h-3" />{tone.label}</span></div><div className="text-[12px] font-semibold mt-1 break-words" style={{ color: "var(--txt)", ...num }}>{value}</div></div>; })}</div>
          {r.note && <div role={r.status === "error" ? "alert" : "status"} className="mt-3 p-3 rounded-xl text-[11px] leading-relaxed" style={{ background: "var(--surf-3)", color: r.status === "suspect" ? "var(--warn)" : r.status === "error" || r.status === "dup" ? "var(--neg)" : "var(--txt-2)" }}>{r.note}</div>}
          <div className="flex flex-wrap gap-2 mt-4">{r.status !== "processing" && r.status !== "dup" && <Btn kind="ghost" onClick={onEdit}><Pencil className="w-4 h-4" /> {copy.edit}</Btn>}{r.status === "suspect" && <Btn onClick={onConfirm}><CheckCircle2 className="w-4 h-4" /> {copy.confirm}</Btn>}{r.ocrImage && ["retry", "suspect", "error"].includes(r.status) && <Btn kind="ghost" onClick={onRetry}><RotateCcw className="w-4 h-4" /> {copy.retry}</Btn>}{r.status !== "processing" && r.status !== "dup" && <Btn kind="ghost" style={{ color: "var(--neg)" }} onClick={onReject}><XCircle className="w-4 h-4" /> {copy.reject}</Btn>}</div>
        </section>
      </div>
    </Card>
  );
}
