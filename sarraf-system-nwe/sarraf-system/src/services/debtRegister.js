/**
 * The two things the debt centre could not do, and the register that records them.
 *
 * §13.C.6 — netting. When ZEMAN and one other party owe each other in the same currency, the
 * settlement is one entry that reduces both, not two payments that in practice never move.
 *
 * §13.C.7 — waiving. A debt that will not be collected has to leave the receivable and become
 * an expense, deliberately and on the record. It is not deleted and it is not marked paid.
 *
 * §13.F.1 — the voucher register. Every movement is handed a number that the person can quote
 * back. Columns named voucher_id have existed since the cashbox was built; nothing ever filled
 * one in.
 *
 * The commands live in the database. What follows checks what can be checked before the call is
 * made, so that a refusal arrives before anything is attempted rather than after.
 */

const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const clean = (v) => String(v ?? "").normalize("NFKC").trim();

export const OFFSET_REASON_MIN = 8;
/** Longer than a settlement's, because unlike a settlement nothing arrived in exchange. */
export const WRITE_OFF_REASON_MIN = 12;

export const offsetCommandKey = (leftId, rightId) =>
  `debt-offset:${clean(leftId).slice(0, 60)}:${clean(rightId).slice(0, 60)}:${id()}`;
export const writeOffCommandKey = (debtId) =>
  `debt-write-off:${clean(debtId).slice(0, 60)}:${id()}`;

/**
 * Can these two debts be netted against each other?
 *
 * The same check the database makes, so the reason is shown next to the button rather than
 * arriving as a refusal after the fact. Returns null when they can, or the reason when they
 * cannot.
 */
// A debt reaches this module in either of the two shapes the application uses: the row as the
// database returns it, or the reading `loadDebts` produces for the screen. Reading both means
// the check next to the button and the check before the call are literally the same function.
const face = (d) => d && ({
  id: d.id,
  currency: clean(d.currency).toUpperCase(),
  status: d.status,
  debtorType: d.debtorType ?? d.debtor_type,
  debtorId: d.debtorId ?? d.debtor_id ?? null,
  creditorType: d.creditorType ?? d.creditor_type,
  creditorId: d.creditorId ?? d.creditor_id ?? null,
  outstanding: Number(d.outstanding ?? d.outstanding_principal),
});

export function offsetObjection(rawLeft, rawRight) {
  const left = face(rawLeft), right = face(rawRight);
  if (!left || !right) return "دوو قەرز هەڵبژێرە";
  if (left.id && left.id === right.id) return "قەرزێک لەگەڵ خۆی دانانرێتەوە";
  if (left.currency !== right.currency) {
    return "هەردوو قەرز دەبێت بە هەمان دراو بن — دانانەوە گۆڕینی دراو نییە";
  }
  const closed = ["settled", "written_off", "void"];
  if (closed.includes(left.status) || closed.includes(right.status)) return "قەرزی داخراو دانانرێتەوە";
  const facing = left.debtorType === right.creditorType
    && left.debtorId === right.creditorId
    && left.creditorType === right.debtorType
    && left.creditorId === right.debtorId;
  if (!facing) return "دانانەوە دوو قەرزی پێچەوانەی نێوان هەمان دوو لا دەخوازێت";
  if (left.debtorType !== "zeman" && left.creditorType !== "zeman") {
    return "دانانەوە دەبێت لەنێوان زیمان و لایەکی تر بێت";
  }
  return null;
}

/** How much would actually cancel: the smaller of the two outstanding balances. */
export function offsetAmount(rawLeft, rawRight) {
  const a = face(rawLeft)?.outstanding;
  const b = face(rawRight)?.outstanding;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const amount = Math.min(a, b);
  return amount > 0 ? amount : null;
}

export async function offsetDebts(client, { leftDebtId, rightDebtId, amount = null, reason, commandKey }) {
  if (!leftDebtId || !rightDebtId) throw new Error("دوو قەرز پێویستە");
  if (leftDebtId === rightDebtId) throw new Error("قەرزێک لەگەڵ خۆی دانانرێتەوە");
  const why = clean(reason);
  if (why.length < OFFSET_REASON_MIN) throw new Error(`هۆکار لانیکەم ${OFFSET_REASON_MIN} پیت بێت`);
  if (amount != null && !(Number(amount) > 0)) throw new Error("بڕەکە دەبێت لە سفر گەورەتر بێت");
  const key = commandKey || offsetCommandKey(leftDebtId, rightDebtId);
  const { data, error } = await client.rpc("sarraf_offset_debts", {
    p_left_debt_id: leftDebtId,
    p_right_debt_id: rightDebtId,
    p_amount: amount == null ? null : Number(amount),
    p_reason: why,
    p_command_key: key,
  });
  if (error) throw error;
  return { result: data, commandKey: key };
}

export async function writeOffDebt(client, { debtId, amount = null, reason, commandKey }) {
  if (!debtId) throw new Error("قەرزێک پێویستە");
  const why = clean(reason);
  if (why.length < WRITE_OFF_REASON_MIN) {
    throw new Error(`بۆ بەخشینی قەرز هۆکار لانیکەم ${WRITE_OFF_REASON_MIN} پیت بێت`);
  }
  if (amount != null && !(Number(amount) > 0)) throw new Error("بڕەکە دەبێت لە سفر گەورەتر بێت");
  const key = commandKey || writeOffCommandKey(debtId);
  const { data, error } = await client.rpc("sarraf_write_off_debt", {
    p_debt_id: debtId,
    p_amount: amount == null ? null : Number(amount),
    p_reason: why,
    p_command_key: key,
  });
  if (error) throw error;
  return { result: data, commandKey: key };
}

export async function loadVoucherRegister(client, { partyId = null, from = null, to = null, limit = 200 } = {}) {
  const { data, error } = await client.rpc("sarraf_voucher_register", {
    p_party_id: partyId || null, p_from: from || null, p_to: to || null, p_limit: limit,
  });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function loadDebtHistory(client, debtId) {
  if (!debtId) throw new Error("قەرزێک پێویستە");
  const { data, error } = await client.rpc("sarraf_debt_history", { p_debt_id: debtId });
  if (error) throw error;
  return data || null;
}

export const VOUCHER_KIND_KU = Object.freeze({
  debt_opened: "کردنەوەی قەرز",
  debt_settlement: "تسویەی قەرز",
  debt_offset: "دانانەوەی دوولایەنە",
  debt_write_off: "بەخشینی قەرز",
  vault_deposit: "دانانی پارە لە قاسە",
  vault_withdrawal: "دەرهێنان لە قاسە",
  office_payment: "پارەدانی نووسینگە",
  partner_settlement: "تسویەی هاوبەش",
  reversal: "هەڵوەشاندنەوە",
});

export const DEBT_EVENT_KU = Object.freeze({
  opened: "کرایەوە",
  settled: "تسویە کرا",
  offset: "دانرایەوە",
  written_off: "بەخشرا",
  voided: "پووچ کرایەوە",
  reinstated: "گەڕێندرایەوە",
});
