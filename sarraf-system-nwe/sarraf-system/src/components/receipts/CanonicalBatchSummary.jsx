import React from "react";
import { currencyRows, isEmpty, isPendingRate } from "../../services/batchSummary";

/**
 * The batch's totals, exactly as the server stated them.
 *
 * §4.14 requires that the administrator and the person who sent the receipts read the same
 * server-side read model, and that the client only render it. This is that renderer — one
 * component, used by both, so there is no second place for the numbers to come out differently.
 *
 * Every figure below is a decimal string from the database, printed as it arrived. Nothing here
 * adds, divides or rounds.
 */
export function CanonicalBatchSummary({ summary, ui, showUsd = true }) {
  const { Card, Pill, tr, num } = ui;
  const rows = currencyRows(summary);

  if (!summary) return null;

  if (isEmpty(summary)) {
    return (
      <Card className="p-4">
        <div className="text-[13px]" style={{ color: "var(--txt-3)" }}>
          {tr("هێشتا هیچ فیشێکی هەژمارکراو لەم کۆمەڵەیەدا نییە")}
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {isPendingRate(summary) && (
        <Card className="p-4" style={{ borderColor: "color-mix(in srgb, var(--warn) 34%, transparent)" }}>
          <div className="text-[13px] font-semibold" style={{ color: "var(--warn)" }}>
            {tr("ڕەیتیۆی ئەمڕۆ دانەنراوە")}
          </div>
          <div className="text-[12px] mt-1" style={{ color: "var(--txt-3)" }}>
            {tr("کۆکانی دراوی ڕەسەن تەواون. بەهای دۆلاری دیاری نەکراوە تا ئەدمین ڕەیتیۆی ئەمڕۆ دادەنێت — سفر یان نرخی ڕۆژێکی تر لە جێی دانانرێت.")}
          </div>
        </Card>
      )}

      {rows.map((r) => (
        <Card key={r.currency} className="px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-semibold" style={{ color: "var(--txt-2)" }}>{r.currency}</span>
            <span className="text-[11px]" style={{ ...num, color: "var(--txt-3)" }}>{r.count} {tr("فیش")}</span>
          </div>

          <Line ui={ui} label={tr("کۆی گشتی (بە فییەوە)")} money={r.native.gross} />
          <Line ui={ui} label={tr("فی")} money={r.native.fee} negative />
          <Line ui={ui} label={tr("گەیشتوو (بەبێ فی)")} money={r.native.net} strong />

          {!r.equationHolds && (
            <div className="mt-2"><Pill tone="red">{tr("ژمارەکانی فیشەکان یەک ناگرنەوە")}</Pill></div>
          )}

          {showUsd && r.usd && (
            <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--line)" }}>
              <div className="text-[11px] mb-1.5" style={{ color: "var(--txt-3)" }}>
                {r.rate?.convention}
              </div>
              <Line ui={ui} label={tr("کۆی گشتی (بە فییەوە)")} money={r.usd.gross} />
              <Line ui={ui} label={tr("فی")} money={r.usd.fee} negative />
              <Line ui={ui} label={tr("گەیشتوو (بەبێ فی)")} money={r.usd.net} strong />
            </div>
          )}

          {showUsd && !r.usd && r.usdPendingReason && (
            <div className="mt-3 pt-3 text-[11px]" style={{ borderTop: "1px solid var(--line)", color: "var(--txt-3)" }}>
              {tr("بەهای دۆلار: چاوەڕوانی ڕەیتیۆ")}
            </div>
          )}
        </Card>
      ))}

      <div className="text-[10px] px-1" style={{ ...num, color: "var(--txt-3)" }}>
        {tr("وەشانی کۆکانە")} {String(summary.summary_version || "").slice(0, 12)}
      </div>
    </div>
  );
}

function Line({ ui, label, money, negative, strong }) {
  const { num } = ui;
  if (!money) return null;
  return (
    <div className={`flex justify-between ${strong ? "items-baseline pt-2.5 mt-1" : "py-1"}`}
      style={strong ? { borderTop: "1px solid var(--line)" } : {}}>
      <span className={strong ? "text-[13px] font-semibold" : "text-[13px]"}
        style={{ color: strong ? "var(--txt)" : "var(--txt-3)" }}>{label}</span>
      <span className={strong ? "text-[20px] font-semibold" : "text-[13px]"}
        style={{ ...num, color: strong ? "var(--pos)" : negative && money.value ? "var(--neg)" : "var(--txt-2)" }}>
        {negative && money.value ? "−" : ""}{money.text}
        <span className="text-[10px] font-normal" style={{ color: "var(--txt-3)" }}> {money.currency}</span>
      </span>
    </div>
  );
}
