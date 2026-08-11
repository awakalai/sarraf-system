import React, { useCallback, useEffect, useState } from "react";
import { Building2, CheckCircle2, Clock, Loader2, RefreshCw, Send } from "lucide-react";
import "./debt-center.css";

const COPY = {
  ku: {
    title: "پارەدانی نووسینگە", subtitle: "تەنها ئەو ئەرکانەی بۆ تۆ دیاریکراون — بڕ و دراو لە مامەڵەکەوە دێن و ناگۆڕدرێن",
    empty: "هیچ ئەرکێکی پارەدانت نییە", refresh: "نوێکردنەوە", loading: "بارکردن...",
    amount: "بڕی داواکراو", paid: "دراوە", outstanding: "ماوە", due: "کاتی کۆتایی",
    ack: "بینیم", initiated: "دەستم پێکرد", report: "پارەم دا",
    reference: "ژمارەی پسووڵە", note: "تێبینی", reportAmount: "بڕی دراو",
    send: "ناردن", working: "جێبەجێکردن...",
    statuses: {
      assigned: "دیاریکراو", acknowledged: "بینراوە", payment_initiated: "دەستی پێکراوە",
      paid_reported: "ڕاپۆرتکراو", confirmed: "پشتڕاستکراو", rejected: "ڕەتکراو", cancelled: "هەڵوەشێنراوە",
    },
    confirmNote: "پشتڕاستکردنەوە لەلایەن ئەدمینەوە دەکرێت — تۆ ناتوانیت پارەدانی خۆت پشتڕاست بکەیت",
  },
  en: {
    title: "Office payments", subtitle: "Only assignments given to you — amount and currency come from the transaction and cannot be changed",
    empty: "No payment assignments", refresh: "Refresh", loading: "Loading…",
    amount: "Amount due", paid: "Paid", outstanding: "Outstanding", due: "Due",
    ack: "Acknowledge", initiated: "Payment started", report: "Report payment",
    reference: "Reference", note: "Note", reportAmount: "Amount paid",
    send: "Send", working: "Working…",
    statuses: {
      assigned: "Assigned", acknowledged: "Acknowledged", payment_initiated: "Started",
      paid_reported: "Reported", confirmed: "Confirmed", rejected: "Rejected", cancelled: "Cancelled",
    },
    confirmNote: "Confirmation is done by an administrator — you cannot confirm your own payment",
  },
};
COPY.ar = COPY.en;
const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");
const money = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const commandKey = () =>
  `office-pay:${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`;

export function OfficePayments({ client, lang = "ku", flash = () => {} }) {
  const copy = COPY[localeKey(lang)];
  const [rows, setRows] = useState([]);
  const [state, setState] = useState("loading");
  const [openId, setOpenId] = useState(null);
  const [form, setForm] = useState({ amount: "", reference: "", note: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    try {
      // RLS returns only this office's assignments; no client-side filtering is relied on.
      const { data, error } = await client
        .from("office_payment_assignments")
        .select("*")
        .order("assigned_at", { ascending: false });
      if (error) throw error;
      setRows((data || []).map((r) => ({
        id: r.id,
        amount: Number(r.amount) || 0,
        paid: Number(r.amount_paid) || 0,
        currency: r.currency,
        status: r.status,
        dueAt: r.due_at,
        reference: r.payment_reference,
        note: r.payment_note,
        transactionId: r.transaction_id,
      })));
      setState("ready");
    } catch (e) {
      console.error("office payments", e);
      flash(String(e?.message || e));
      setState("error");
    }
  }, [client, flash]);

  useEffect(() => { load(); }, [load]);

  const report = async (row, status) => {
    if (busy) return;
    setBusy(true);
    try {
      const { error } = await client.rpc("sarraf_office_payment_report", {
        p_assignment_id: row.id,
        p_status: status,
        p_amount: status === "paid_reported" ? Number(form.amount) : null,
        p_reference: form.reference || null,
        p_note: form.note || null,
        p_command_key: commandKey(),
      });
      if (error) throw error;
      flash("✓");
      setOpenId(null);
      setForm({ amount: "", reference: "", note: "" });
      await load();
    } catch (e) {
      console.error("office report", e);
      flash(String(e?.message || e));
    } finally { setBusy(false); }
  };

  if (state === "loading") return <div className="debt-panel"><div className="debt-loading">{copy.loading}</div></div>;

  return (
    <section className="debt-panel" aria-labelledby="office-pay-title">
      <header className="debt-header">
        <span className="debt-icon"><Building2 aria-hidden="true" /></span>
        <div>
          <h2 id="office-pay-title">{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <button type="button" className="debt-refresh" onClick={load}>
          <RefreshCw aria-hidden="true" /> {copy.refresh}
        </button>
      </header>

      {rows.length === 0 ? <p className="debt-muted debt-empty">{copy.empty}</p> : rows.map((row) => {
        const outstanding = row.amount - row.paid;
        const settled = row.status === "confirmed" || outstanding <= 0;
        const canReport = !["confirmed", "cancelled", "rejected"].includes(row.status);
        return (
          <article key={row.id} className="debt-card">
            <div className="debt-currency-row">
              <span className="debt-card-title">
                <strong>{money(row.amount)} <span className="debt-currency-code">{row.currency}</span></strong>
                <span className="debt-reason">{copy.amount}</span>
              </span>
              <span className={`debt-badge ${settled ? "is-ok" : ""}`}
                    style={settled ? { background: "var(--pos-bg)", color: "var(--pos)" } : undefined}>
                {settled ? <CheckCircle2 aria-hidden="true" style={{ width: 11, height: 11, verticalAlign: "-1px" }} />
                         : <Clock aria-hidden="true" style={{ width: 11, height: 11, verticalAlign: "-1px" }} />}
                {" "}{copy.statuses[row.status] || row.status}
              </span>
            </div>

            <div className="debt-currency-list">
              <div className="debt-currency-row">
                <span className="debt-currency-code">{copy.paid}</span>
                <span className="debt-currency-amount pos">{money(row.paid)}</span>
              </div>
              <div className="debt-currency-row">
                <span className="debt-currency-code">{copy.outstanding}</span>
                <span className={`debt-currency-amount ${outstanding > 0 ? "neg" : ""}`}>{money(outstanding)}</span>
              </div>
              {row.dueAt && (
                <div className="debt-currency-row">
                  <span className="debt-currency-code">{copy.due}</span>
                  <span className="debt-currency-amount">{new Date(row.dueAt).toLocaleDateString("en-GB")}</span>
                </div>
              )}
            </div>

            {canReport && (
              <>
                <div className="cashbox-actions">
                  <button type="button" className="cashbox-btn" disabled={busy}
                          onClick={() => report(row, "acknowledged")}>
                    {busy ? <Loader2 className="spin" aria-hidden="true" /> : null} {copy.ack}
                  </button>
                  <button type="button" className="cashbox-btn" disabled={busy}
                          onClick={() => report(row, "payment_initiated")}>{copy.initiated}</button>
                  <button type="button" className="cashbox-btn is-pos"
                          onClick={() => setOpenId(openId === row.id ? null : row.id)}>
                    <Send aria-hidden="true" /> {copy.report}
                  </button>
                </div>

                {openId === row.id && (
                  <div className="cashbox-form">
                    <label>
                      {copy.reportAmount}
                      <input type="number" inputMode="decimal" value={form.amount}
                             max={outstanding}
                             onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                    </label>
                    <label>
                      {copy.reference}
                      <input value={form.reference}
                             onChange={(e) => setForm({ ...form, reference: e.target.value })} />
                    </label>
                    <label className="cashbox-wide">
                      {copy.note}
                      <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
                    </label>
                    <button type="button" className="cashbox-btn is-pos cashbox-wide"
                            disabled={busy || !(Number(form.amount) > 0) || Number(form.amount) > outstanding}
                            onClick={() => report(row, "paid_reported")}>
                      {busy ? copy.working : copy.send}
                    </button>
                  </div>
                )}
              </>
            )}

            {/* The office reports; only a verifier confirms. Say so, so the absence is not a puzzle. */}
            <p className="debt-muted">{copy.confirmNote}</p>
          </article>
        );
      })}
    </section>
  );
}
