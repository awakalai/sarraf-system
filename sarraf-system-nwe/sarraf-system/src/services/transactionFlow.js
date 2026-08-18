/**
 * The three real-world exchange flows.  The existing UI already exposes the signals we need:
 * a paired `direct` trade is the owner's own-money flow, a normal trade with a partner is
 * partner custody, and the remaining normal trades keep the legacy/standard behaviour.
 *
 * Keeping the classification in one pure module prevents the browser payload, reports and the
 * database from inventing different meanings for the same transaction.
 */
export const TRANSACTION_BUSINESS_FLOW = Object.freeze({
  PARTNER_CUSTODY: "partner_custody",
  OWNER_CASHBOX: "owner_cashbox",
  STANDARD: "standard",
});

const present = (value) => value !== null && value !== undefined && String(value).trim() !== "";
const valueOf = (record, camel, snake) => record?.[camel] ?? record?.[snake];

export function transactionBusinessFlowOf(record = {}) {
  const direct = Boolean(valueOf(record, "direct", "direct"));
  const partnerId = valueOf(record, "partnerId", "partner_id");
  if (direct) return TRANSACTION_BUSINESS_FLOW.OWNER_CASHBOX;
  if (present(partnerId)) return TRANSACTION_BUSINESS_FLOW.PARTNER_CUSTODY;
  return TRANSACTION_BUSINESS_FLOW.STANDARD;
}

/**
 * Validate and stamp a transaction before it crosses the network boundary.
 * The database repeats these checks authoritatively; this early check only gives the operator a
 * useful error without allowing the browser to choose a contradictory flow label.
 */
export function normalizeTransactionBusinessFlow(record = {}) {
  const flow = transactionBusinessFlowOf(record);
  const explicit = valueOf(record, "businessFlow", "business_flow");
  const direct = Boolean(valueOf(record, "direct", "direct"));
  const ownMoney = Boolean(valueOf(record, "ownMoney", "own_money"));
  const partnerId = valueOf(record, "partnerId", "partner_id");
  const pairId = valueOf(record, "pairId", "pair_id");
  const directRole = valueOf(record, "directRole", "direct_role");
  const type = String(record?.type || "").trim();

  if (present(explicit) && explicit !== flow) {
    throw new Error("جۆری مامەڵە لەگەڵ شوێنی پارەکە یەک ناگرێتەوە");
  }

  if (flow === TRANSACTION_BUSINESS_FLOW.OWNER_CASHBOX) {
    if (present(partnerId)) throw new Error("مامەڵەی ڕاستەوخۆ ناتوانێت هاوبەشی هەبێت");
    if (!ownMoney) throw new Error("مامەڵەی ڕاستەوخۆ دەبێت بە پارەی خاوەن‌کار تۆمار بکرێت");
    if (!present(pairId) || !["buy", "sell"].includes(directRole) || directRole !== type) {
      throw new Error("دوو لای مامەڵەی ڕاستەوخۆ بە دروستی پێکەوە نەبەستراون");
    }
  } else {
    if (direct || ownMoney || present(pairId) || present(directRole)) {
      throw new Error("مامەڵەی ئاسایی ناتوانێت نیشانەکانی مامەڵەی ڕاستەوخۆ هەڵبگرێت");
    }
    if (flow === TRANSACTION_BUSINESS_FLOW.PARTNER_CUSTODY && !present(partnerId)) {
      throw new Error("مامەڵەی هاوبەش پێویستی بە هاوبەشێکی دیاریکراو هەیە");
    }
  }

  return { ...record, businessFlow: flow, business_flow: flow };
}

export const isOwnerCashboxFlow = (record) =>
  (valueOf(record, "businessFlow", "business_flow") || transactionBusinessFlowOf(record))
    === TRANSACTION_BUSINESS_FLOW.OWNER_CASHBOX;

export const receiptRecipientRoleForTransaction = (record) => {
  const flow = valueOf(record, "businessFlow", "business_flow") || transactionBusinessFlowOf(record);
  if (flow === TRANSACTION_BUSINESS_FLOW.PARTNER_CUSTODY) return "partner";
  return null;
};
