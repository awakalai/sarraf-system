/**
 * Day close rules (§12).
 *
 * The database refuses a close that carries a counted difference without a reason. This is the
 * same rule stated where the operator can see it, so they are stopped at the button with an
 * explanation rather than at the server with an error — and so the rule can be tested without
 * a database.
 *
 * Nothing here is a substitute for the server check. It is the same rule said twice on purpose.
 */

/** Below this, a difference is rounding rather than a real discrepancy. */
export const DIFF_EPSILON = 1e-9;

/** The minimum every other command in the system asks for. */
export const REASON_MIN = 8;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const lineHasDifference = (line) => Math.abs(num(line?.diff)) > DIFF_EPSILON;

export const differingLines = (lines) => (lines || []).filter(lineHasDifference);

export const hasDifference = (lines) => differingLines(lines).length > 0;

/**
 * Whether this close may be submitted, and if not, why.
 * @returns {{ok: boolean, code: string|null, reasonRequired: boolean}}
 */
export function validateDayClose({ lines, note } = {}) {
  const counted = (lines || []).filter((l) => l && l.counted !== null && l.counted !== undefined);
  if (!counted.length) return { ok: false, code: "nothing_counted", reasonRequired: false };

  const reasonRequired = hasDifference(lines);
  if (!reasonRequired) return { ok: true, code: null, reasonRequired: false };

  const text = String(note ?? "").normalize("NFKC").trim();
  if (text.length < REASON_MIN) return { ok: false, code: "reason_required", reasonRequired: true };
  return { ok: true, code: null, reasonRequired: true };
}

export const DAY_CLOSE_MESSAGE = Object.freeze({
  nothing_counted: "لانیکەم یەک دراو بژمێرە",
  reason_required: `جیاوازی هەیە — هۆکارەکەی بنووسە (لانیکەم ${REASON_MIN} پیت)`,
});

export const dayCloseMessage = (code) => DAY_CLOSE_MESSAGE[code] || code;

/**
 * Totals per currency for the confirmation step. Differences are never added across
 * currencies; the USD figure alongside is a valuation, not a sum of the amounts.
 */
export function differenceByCurrency(lines) {
  const out = {};
  for (const l of differingLines(lines)) {
    const code = l.code || l.cur;
    if (!code) continue;
    out[code] = (out[code] || 0) + num(l.diff);
  }
  return out;
}
