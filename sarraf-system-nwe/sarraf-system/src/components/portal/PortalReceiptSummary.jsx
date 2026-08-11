import React from "react";

const STAGE_LABEL = {
  received: "وەرگیرا",
  reading: "دەخوێندرێتەوە",
  needs_review: "پشکنین پێویستە",
  verified: "پشتڕاستکراو",
  matched: "بەستراوەکان",
  archived: "ئەرشیفکراو",
  rejected: "دووبارە",
};
const STAGE_TONE = {
  received: "slate", reading: "slate", needs_review: "amber",
  verified: "green", matched: "green", archived: "slate", rejected: "red",
};

/** Read-only portal receipt totals + recent batch lifecycle. Server totals only — no
 *  individual receipt rows/images are exposed here, matching sarraf_portal_receipt_summary. */
export function PortalReceiptSummary({ summary, data, ui }) {
  const { Card, Empty, Hero, Pill, fmtMoney, tr, num } = ui;
  const totals = Array.isArray(summary?.totals) ? summary.totals : [];
  const batches = Array.isArray(summary?.batches) ? summary.batches : [];
  const mainCur = totals[0];

  if (!totals.length && !batches.length) {
    return <Card className="p-2"><Empty t={tr("هیچ فیشێک نییە")} /></Card>;
  }

  return (
    <div className="space-y-3">
      {mainCur && (
        <div className="relative pt-3 pb-1">
          <Hero label={tr("گەیشتوو (بێ فی)")}
            value={fmtMoney(data, mainCur.total_net, mainCur.currency)} unit={mainCur.currency}
            sub={`${summary.accepted_count || 0} ${tr("فیش")}${summary.rejected_count ? ` · ${summary.rejected_count} ${tr("هەژمار نەکراوە")}` : ""}`} />
        </div>
      )}

      {totals.length > 0 && (
        <Card className="px-4 py-2">
          {totals.map((t, i) => (
            <div key={t.currency} className="py-3" style={i ? { borderTop: "1px solid var(--line)" } : {}}>
              <div className="flex items-center justify-between mb-2.5">
                <span className="text-[12px] font-semibold" style={{ color: "var(--txt-2)" }}>{t.currency}</span>
                <span className="text-[11px]" style={{ ...num, color: "var(--txt-3)" }}>{t.accepted_count || 0} {tr("فیش")}</span>
              </div>
              <div className="flex justify-between text-[13px] py-1">
                <span style={{ color: "var(--txt-3)" }}>{tr("کۆی گشتی (بە فییەوە)")}</span>
                <span style={{ ...num, color: "var(--txt-2)" }}>{fmtMoney(data, t.total_gross, t.currency)}</span>
              </div>
              <div className="flex justify-between text-[13px] py-1">
                <span style={{ color: "var(--txt-3)" }}>{tr("فی")}</span>
                <span style={{ ...num, color: t.total_fee ? "var(--neg)" : "var(--txt-3)" }}>
                  {t.total_fee ? "−" + fmtMoney(data, t.total_fee, t.currency) : fmtMoney(data, 0, t.currency)}
                </span>
              </div>
              <div className="flex justify-between items-baseline pt-2.5 mt-1" style={{ borderTop: "1px solid var(--line)" }}>
                <span className="text-[13px] font-semibold" style={{ color: "var(--txt)" }}>{tr("گەیشتوو")}</span>
                <span className="text-[20px] font-semibold" style={{ ...num, color: "var(--pos)" }}>{fmtMoney(data, t.total_net, t.currency)}</span>
              </div>
            </div>
          ))}
        </Card>
      )}

      {batches.length > 0 && (
        <Card className="px-4 py-2">
          {batches.map((b, i) => (
            <div key={b.id} className="flex items-center justify-between gap-3 py-3" style={i ? { borderTop: "1px solid var(--line)" } : {}}>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold" style={{ ...num, color: "var(--txt)" }}>
                  {fmtMoney(data, b.total_net, b.currency)} <span className="text-[11px]" style={{ color: "var(--txt-3)" }}>{b.currency}</span>
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: "var(--txt-3)" }}>
                  {b.n || 0} {tr("فیش")}{b.rejected_n ? ` · ${b.rejected_n} ${tr("هەژمار نەکراوە")}` : ""} · {b.created_at ? new Date(b.created_at).toLocaleDateString("en-GB") : "—"}
                </div>
              </div>
              <Pill tone={STAGE_TONE[b.receipt_stage] || "slate"}>{tr(STAGE_LABEL[b.receipt_stage] || b.receipt_stage || "—")}</Pill>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
