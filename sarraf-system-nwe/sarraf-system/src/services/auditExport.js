export const AUDIT_DATASET_LABELS = Object.freeze({
  transactions: "Transactions",
  audit: "Change log",
  receipt_audit: "Receipt audit",
  approvals: "Approvals",
  approval_events: "Approval events",
  tx_versions: "Transaction versions",
  receipt_batches: "Receipt batches",
});

const safeDay = (value) => {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("valid export dates are required");
  return text;
};

export async function loadAuditExportSnapshot(client, { from, to, limit = 1000 } = {}) {
  const bounded = Math.min(2500, Math.max(1, Number(limit) || 1000));
  const { data, error } = await client.rpc("sarraf_export_audit_snapshot", {
    p_from: safeDay(from),
    p_to: safeDay(to),
    p_limit: bounded,
  });
  if (error) throw error;
  const datasets = data?.datasets && typeof data.datasets === "object" ? data.datasets : {};
  return {
    format: data?.format || "zeman-export-audit-snapshot",
    version: Number(data?.version) || 1,
    generated_at: data?.generated_at || null,
    generated_by: data?.generated_by || null,
    range: data?.range || { from, to, timezone: "UTC" },
    row_limit_per_dataset: Math.min(2500, Math.max(1, Number(data?.row_limit_per_dataset) || bounded)),
    counts: data?.counts && typeof data.counts === "object" ? data.counts : {},
    clipped: data?.clipped && typeof data.clipped === "object" ? data.clipped : {},
    datasets: Object.fromEntries(Object.keys(AUDIT_DATASET_LABELS).map((key) => [key, Array.isArray(datasets[key]) ? datasets[key].slice(0, bounded) : []])),
  };
}

const spreadsheetSafe = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /^[\s]*[=+\-@]/.test(text) || /^[\t\r]/.test(text) ? `'${text}` : text;
};

const csvCell = (value) => `"${spreadsheetSafe(value).replaceAll('"', '""')}"`;

export function buildSafeCsv(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const headers = [...new Set(list.flatMap((row) => row && typeof row === "object" ? Object.keys(row) : []))].sort();
  if (!headers.length) return "\uFEFF";
  return `\uFEFF${headers.map(csvCell).join(",")}\r\n${list.map((row) => headers.map((key) => csvCell(row?.[key])).join(",")).join("\r\n")}`;
}

const bytesToHex = (bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export async function snapshotChecksum(snapshot) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(snapshot)));
  return bytesToHex(digest);
}

export function downloadTextFile(contents, filename, type = "text/plain;charset=utf-8") {
  const href = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export function auditTimeline(snapshot) {
  const datasets = snapshot?.datasets || {};
  const rows = [
    ...(datasets.audit || []).map((row) => ({ ...row, _dataset: "audit", _at: row.date, _label: row.action || "Change recorded" })),
    ...(datasets.receipt_audit || []).map((row) => ({ ...row, _dataset: "receipt_audit", _at: row.created_at, _label: row.event_type || "Receipt event" })),
    ...(datasets.approval_events || []).map((row) => ({ ...row, _dataset: "approval_events", _at: row.created_at, _label: row.event || "Approval event" })),
    ...(datasets.tx_versions || []).map((row) => ({ ...row, _dataset: "tx_versions", _at: row.created_at, _label: row.action || "Transaction version" })),
  ];
  return rows.sort((left, right) => new Date(right._at || 0) - new Date(left._at || 0));
}
