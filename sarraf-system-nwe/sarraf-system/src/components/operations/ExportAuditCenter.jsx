import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileCheck2, Filter, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { AUDIT_DATASET_LABELS, auditTimeline, buildSafeCsv, downloadTextFile, loadAuditExportSnapshot, snapshotChecksum } from "../../services/auditExport";
import "./export-audit-center.css";

const day = (date) => date.toISOString().slice(0, 10);
const initialRange = () => {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 29);
  return { from: day(from), to: day(to) };
};
const displayDate = (value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString("en-GB") : "—";
};
const safeName = (value) => String(value || "export").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "");

export function ExportAuditCenter({ client }) {
  const [range, setRange] = useState(initialRange);
  const [limit, setLimit] = useState(1000);
  const [snapshot, setSnapshot] = useState(null);
  const [active, setActive] = useState("transactions");
  const [query, setQuery] = useState("");
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [checksum, setChecksum] = useState("");

  const load = async () => {
    setState("loading");
    setError("");
    try {
      setSnapshot(await loadAuditExportSnapshot(client, { ...range, limit }));
      setState("ready");
    } catch (cause) {
      setError(cause?.message || "Export & Audit Center could not be loaded");
      setState("error");
    }
  };

  useEffect(() => { load(); }, []); // The operator controls later refreshes and range changes.
  useEffect(() => {
    let live = true;
    setChecksum("");
    if (snapshot) snapshotChecksum(snapshot).then((value) => { if (live) setChecksum(value || ""); });
    return () => { live = false; };
  }, [snapshot]);

  const rows = snapshot?.datasets?.[active] || [];
  const visibleRows = useMemo(() => {
    const needle = query.normalize("NFKC").trim().toLocaleLowerCase();
    if (!needle) return rows.slice(0, 60);
    return rows.filter((row) => JSON.stringify(row).toLocaleLowerCase().includes(needle)).slice(0, 60);
  }, [query, rows]);
  const columns = useMemo(() => [...new Set(visibleRows.flatMap((row) => Object.keys(row || {})))].slice(0, 8), [visibleRows]);
  const timeline = useMemo(() => auditTimeline(snapshot).slice(0, 40), [snapshot]);
  const clippedKeys = Object.entries(snapshot?.clipped || {}).filter(([, clipped]) => clipped).map(([key]) => key);

  const downloadCsv = () => {
    downloadTextFile(buildSafeCsv(rows), `zeman_${safeName(active)}_${range.from}_${range.to}.csv`, "text/csv;charset=utf-8");
  };
  const downloadManifest = async () => {
    const digest = checksum || await snapshotChecksum(snapshot);
    const manifest = { ...snapshot, integrity: { algorithm: digest ? "SHA-256" : "unavailable", snapshot_checksum: digest } };
    downloadTextFile(JSON.stringify(manifest, null, 2), `zeman_export_audit_${range.from}_${range.to}.json`, "application/json;charset=utf-8");
  };

  return <div className="export-audit-center">
    <header className="export-audit-header">
      <div><span>ZEMAN CONTROL PLANE</span><h1><ShieldCheck aria-hidden="true" /> Export &amp; Audit Center</h1><p>Export ـی سنووردار، timeline ـی یەکخراو و checksum ـی پشکنین—تەنها خوێندنەوە و بێ گۆڕینی داتا.</p></div>
      <span className={`export-audit-live ${state === "error" ? "is-error" : ""}`}><i aria-hidden="true" />{state === "loading" ? "LOADING" : state === "error" ? "ERROR" : "VERIFIED READ"}</span>
    </header>

    <section className="export-audit-filter" aria-label="Export range">
      <div><label htmlFor="audit-from">لە بەرواری</label><input id="audit-from" type="date" value={range.from} onChange={(event) => setRange({ ...range, from: event.target.value })} /></div>
      <div><label htmlFor="audit-to">بۆ بەرواری</label><input id="audit-to" type="date" value={range.to} onChange={(event) => setRange({ ...range, to: event.target.value })} /></div>
      <div><label htmlFor="audit-limit">سنووری هەر dataset</label><select id="audit-limit" value={limit} onChange={(event) => setLimit(Number(event.target.value))}><option value="500">500</option><option value="1000">1,000</option><option value="2500">2,500</option></select></div>
      <button type="button" onClick={load} disabled={state === "loading"}><RefreshCw aria-hidden="true" className={state === "loading" ? "is-spinning" : ""} />بارکردن</button>
    </section>

    {state === "error" && <section className="export-audit-error" role="alert"><AlertTriangle aria-hidden="true" /><div><strong>Snapshot ئامادە نەبوو</strong><p>{error}</p></div></section>}
    {clippedKeys.length > 0 && <section className="export-audit-warning"><AlertTriangle aria-hidden="true" /><span>هەندێ dataset بە سنووری {snapshot.row_limit_per_dataset} ڕیز وەستاوە: {clippedKeys.map((key) => AUDIT_DATASET_LABELS[key] || key).join("، ")}. ماوەکە بچووکتر بکە بۆ export ـی تەواوی ئەو بەشە.</span></section>}

    <section className="export-audit-counts" aria-label="Dataset counts">
      {Object.entries(AUDIT_DATASET_LABELS).map(([key, label]) => <button type="button" key={key} className={active === key ? "is-active" : ""} onClick={() => setActive(key)}><span>{label}</span><strong>{Number(snapshot?.counts?.[key] || 0).toLocaleString("en-US")}</strong><small>{snapshot?.clipped?.[key] ? "CLIPPED" : "COMPLETE"}</small></button>)}
    </section>

    <div className="export-audit-grid">
      <section className="export-audit-dataset">
        <div className="export-audit-section-head"><div><span>DATASET</span><h2>{AUDIT_DATASET_LABELS[active]}</h2></div><div className="export-audit-actions"><label><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="گەڕان لە preview..." /></label><button type="button" onClick={downloadCsv} disabled={!rows.length}><Download aria-hidden="true" />CSV</button></div></div>
        <div className="export-audit-table-wrap">
          {visibleRows.length ? <table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{visibleRows.map((row, index) => <tr key={row.id || `${active}-${index}`}>{columns.map((column) => <td key={column} title={typeof row[column] === "object" ? JSON.stringify(row[column]) : String(row[column] ?? "")}><span>{typeof row[column] === "object" ? JSON.stringify(row[column]) : String(row[column] ?? "—")}</span></td>)}</tr>)}</tbody></table> : <div className="export-audit-empty"><Filter aria-hidden="true" />هیچ ڕیزێک بۆ ئەم dataset/گەڕانە نییە</div>}
        </div>
        <div className="export-audit-foot"><span>Preview: {visibleRows.length} / Export rows: {rows.length}</span><span>CSV values are spreadsheet-safe</span></div>
      </section>

      <aside className="export-audit-manifest">
        <div className="export-audit-section-head"><div><span>MANIFEST</span><h2>Integrity proof</h2></div><FileCheck2 aria-hidden="true" /></div>
        <dl><div><dt>Generated</dt><dd>{displayDate(snapshot?.generated_at)}</dd></div><div><dt>UTC range</dt><dd>{snapshot ? `${snapshot.range?.from} → ${snapshot.range?.to}` : "—"}</dd></div><div><dt>Format</dt><dd>{snapshot?.format || "—"} v{snapshot?.version || "—"}</dd></div><div><dt>SHA-256</dt><dd className="checksum">{checksum || (snapshot ? "calculating…" : "—")}</dd></div></dl>
        <button type="button" onClick={downloadManifest} disabled={!snapshot}><Download aria-hidden="true" />JSON + checksum</button>
        <p>ئەم manifest ـە snapshot ـەکە و checksum ـەکەی پێکەوە هەڵدەگرێت؛ backup/PITR نییە.</p>
      </aside>
    </div>

    <section className="export-audit-timeline">
      <div className="export-audit-section-head"><div><span>UNIFIED TRAIL</span><h2>Audit timeline</h2></div><CheckCircle2 aria-hidden="true" /></div>
      {timeline.length ? <div>{timeline.map((item, index) => <article key={`${item._dataset}-${item.id || index}`}><i aria-hidden="true" /><div><span>{AUDIT_DATASET_LABELS[item._dataset] || item._dataset}</span><strong>{item._label}</strong><small>{item.detail || item.decision_note || item.actor_name || item.actor_id || "Recorded event"}</small></div><time>{displayDate(item._at)}</time></article>)}</div> : <div className="export-audit-empty">هیچ audit event ـێک لەم ماوەیەدا نییە</div>}
    </section>
  </div>;
}
