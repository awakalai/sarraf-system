import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, BookOpen, RefreshCw, Scale, Search } from "lucide-react";
import {
  ACCOUNT_KIND_KU, accountRows, defaultRange, entryBalance, entryCorrection,
  loadGeneralLedger, loadProfitAndLoss, profitRows,
} from "../../services/ledgerReports";
import "./debt-center.css";

const COPY = {
  ku: {
    title: "دەفتەر و قازانج", subtitle: "قازانجی مامەڵە جیا لە گۆڕانی نرخ — و هەموو تۆمارێکی دەفتەر",
    pnl: "قازانج و زەرەر", ledger: "دەفتەری گشتی",
    from: "لە", to: "بۆ", refresh: "نوێکردنەوە", loading: "بارکردن...", failed: "بار نەبوو",
    income: "داهات", expense: "خەرجی", realized: "قازانجی مامەڵە", unrealized: "گۆڕانی نرخ",
    unrealizedNote: "گۆڕانی نرخ لەگەڵ قازانجی مامەڵە کۆ ناکرێتەوە — نرخێک کە ئەمڕۆ جوڵاوە هیچ دەربارەی مامەڵەیەکی تەواوبوو ناڵێت.",
    accounts: "هەژمارەکان", noAccounts: "هیچ جوڵانەوەیەک لەم ماوەیەدا نییە",
    search: "گەڕان لە تۆمارەکان", noEntries: "هیچ تۆمارێک نییە", more: "زیاتر",
    of: "لە", entries: "تۆمار", debit: "بە", credit: "لە", balanced: "هاوسەنگە",
    unbalanced: "هاوسەنگ نییە", voucher: "پسووڵە",
    reverses: "هەڵوەشاندنەوەی", reversed: "هەڵوەشێنراوەتەوە بە",
  },
  en: {
    title: "Books & profit", subtitle: "Trading profit apart from revaluation — and every entry in the ledger",
    pnl: "Profit & loss", ledger: "General ledger",
    from: "From", to: "To", refresh: "Refresh", loading: "Loading…", failed: "Could not load",
    income: "Income", expense: "Expense", realized: "Realized", unrealized: "Revaluation",
    unrealizedNote: "Revaluation is never added to trading profit — a rate that moved today says nothing about what a completed trade earned.",
    accounts: "Accounts", noAccounts: "No movements in this range",
    search: "Search entries", noEntries: "No entries", more: "More",
    of: "of", entries: "entries", debit: "Debit", credit: "Credit", balanced: "Balanced",
    unbalanced: "NOT balanced", voucher: "Voucher",
    reverses: "Reverses", reversed: "Reversed by",
  },
};
COPY.ar = COPY.en;
const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");
const money = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * What the business earned, and what every entry in its books says.
 *
 * §13.F.6 and §12. Both have been computable since the double-entry core went in and neither had
 * a screen, so the owner could not say what a month came to without adding it up by hand.
 *
 * Every figure comes from the server. Nothing on this screen is totalled in the browser.
 */
export function BooksReport({ client, lang = "ku", nameOf = (id) => id }) {
  const copy = COPY[localeKey(lang)];
  const [tab, setTab] = useState("pnl");
  const [range, setRange] = useState(defaultRange());
  const [report, setReport] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [search, setSearch] = useState("");
  const [openEntry, setOpenEntry] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      if (tab === "pnl") setReport(await loadProfitAndLoss(client, range));
      else setLedger(await loadGeneralLedger(client, { ...range, search: search || null, limit: 50 }));
      setState("ready");
    } catch (e) {
      console.error("books report", e);
      setError(String(e?.message || e));
      setState("error");
    }
  }, [client, tab, range, search]);

  useEffect(() => { load(); }, [load]);

  const rows = profitRows(report);

  return (
    <section className="debt-panel" aria-labelledby="books-title">
      <header className="debt-header">
        <span className="debt-icon"><Scale aria-hidden="true" /></span>
        <div>
          <h2 id="books-title">{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <button type="button" className="debt-refresh" onClick={load}>
          <RefreshCw aria-hidden="true" /> {copy.refresh}
        </button>
      </header>

      <div className="books-tabs" role="tablist">
        {[["pnl", copy.pnl], ["ledger", copy.ledger]].map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k}
            className={tab === k ? "is-on" : ""} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      <div className="books-range">
        <label>{copy.from}
          <input type="date" value={range.from || ""}
            onChange={(e) => setRange({ ...range, from: e.target.value })} />
        </label>
        <label>{copy.to}
          <input type="date" value={range.to || ""}
            onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </label>
        {tab === "ledger" && (
          <label className="books-search">
            <Search aria-hidden="true" />
            <input value={search} placeholder={copy.search} aria-label={copy.search}
              onChange={(e) => setSearch(e.target.value)} />
          </label>
        )}
      </div>

      {state === "error" && (
        <div className="debt-error" role="alert">
          <AlertTriangle aria-hidden="true" /> {copy.failed}
          <span className="debt-muted"> {error}</span>
        </div>
      )}
      {state === "loading" && <div className="debt-loading">{copy.loading}</div>}

      {state === "ready" && tab === "pnl" && (
        <>
          {rows.length === 0 ? <p className="debt-muted debt-empty">{copy.noAccounts}</p> : (
            <div className="debt-table-wrap">
              <table className="debt-table">
                <thead>
                  <tr>
                    <th scope="col">{" "}</th>
                    <th scope="col">{copy.income}</th>
                    <th scope="col">{copy.expense}</th>
                    <th scope="col">{copy.realized}</th>
                    <th scope="col">{copy.unrealized}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.currency}>
                      <td><strong className="debt-currency-code">{r.currency}</strong></td>
                      <td className="debt-amount">{money(r.income)}</td>
                      <td className="debt-amount">{money(r.expense)}</td>
                      <td className="debt-amount">
                        <strong className={r.realized >= 0 ? "pos" : "neg"}>{money(r.realized)}</strong>
                      </td>
                      {/* Never added to the column beside it. */}
                      <td className="debt-amount debt-muted">{r.unrealized ? money(r.unrealized) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="debt-muted books-note">{copy.unrealizedNote}</p>

          {accountRows(report).length > 0 && (
            <div className="books-accounts">
              <h3>{copy.accounts}</h3>
              <ul>
                {accountRows(report).map((a) => (
                  <li key={`${a.accountId}-${a.currency}`}>
                    <span className="books-account-code">{a.code}</span>
                    <span className="books-account-name">{a.name}</span>
                    <span className="debt-muted">{ACCOUNT_KIND_KU[a.kind] || a.kind}</span>
                    <span className="debt-amount">{money(a.amount)} <span className="debt-currency-code">{a.currency}</span></span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {state === "ready" && tab === "ledger" && (
        <>
          <div className="debt-muted books-count">
            {(ledger?.entries || []).length} {copy.of} {ledger?.total || 0} {copy.entries}
          </div>
          {(ledger?.entries || []).length === 0 ? <p className="debt-muted debt-empty">{copy.noEntries}</p> : (
            <ul className="books-entries">
              {ledger.entries.map((e) => {
                const balance = entryBalance(e);
                const correction = entryCorrection(e);
                const open = openEntry === e.id;
                return (
                  <li key={e.id}>
                    <button type="button" className="books-entry-head" aria-expanded={open}
                      onClick={() => setOpenEntry(open ? null : e.id)}>
                      <span className="books-entry-main">
                        <span className="books-entry-id">{e.voucher || e.id}</span>
                        <span className="debt-reason">{e.description || e.source_type}</span>
                      </span>
                      <span className="books-entry-meta">
                        <span className="debt-muted">{e.business_date}</span>
                        <span className={`recon-badge ${balance.balanced ? "" : "is-bad"}`}>
                          {balance.balanced ? copy.balanced : copy.unbalanced}
                        </span>
                      </span>
                    </button>
                    {correction && (
                      <div className="debt-muted books-correction">
                        {correction.kind === "reverses" ? `${copy.reverses} ${correction.of}` : `${copy.reversed} ${correction.by}`}
                      </div>
                    )}
                    {open && (
                      <table className="debt-table books-lines">
                        <tbody>
                          {(e.lines || []).map((l) => (
                            <tr key={l.line_no}>
                              <td>
                                <span className="books-account-code">{l.account_code}</span> {l.account_name}
                                {l.party_id && <span className="debt-reason">{nameOf(l.party_id) || l.party_id}</span>}
                              </td>
                              <td className="debt-amount">{l.side === "debit" ? money(l.amount) : ""}</td>
                              <td className="debt-amount">{l.side === "credit" ? money(l.amount) : ""}</td>
                              <td className="debt-currency-code">{l.currency}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
