/**
 * Currency resolution for receipt evidence.
 *
 * The previous rule was `["IQD","USD","CNY",...].find(code => text.toUpperCase().includes(code))`.
 * That scanned the whole receipt for a bare substring with IQD checked first, so the letters
 * "IQD" appearing anywhere — a note, an address, a bank name — turned a Chinese CNY receipt
 * into an IQD one. Valued at the IQD rate, 2,300 CNY then displayed as roughly $1.63.
 *
 * Rules enforced here:
 *   - a code only counts on a word boundary, never as a loose substring;
 *   - CNY / RMB / 人民币 / 元 all resolve to CNY;
 *   - ¥ and ￥ are shared by CNY and JPY, so the symbol alone is never decisive;
 *   - IQD is never inferred from locale, language or the absence of other evidence;
 *   - when evidence conflicts or is absent the result is unresolved and needs review,
 *     rather than a guess that silently becomes an amount of money.
 */

export const AMBIGUOUS_YEN = "ambiguous_yen_symbol";
export const NO_EVIDENCE = "no_currency_evidence";
export const CONFLICTING = "conflicting_currency_evidence";
export const EXPECTED_MISMATCH = "currency_mismatch";

const SUPPORTED = ["CNY", "USD", "IQD", "EUR", "TRY", "AED", "SAR", "JPY", "GBP"];

// Word-boundary match: "IQD" inside "LIQDATE" must not count.
const hasCode = (text, code) => new RegExp(`(?<![A-Z])${code}(?![A-Z])`).test(text);

const CNY_WORDS = /人民币|元|RMB|YUAN/i;
const JPY_WORDS = /円|日元|JAPANESE\s*YEN|JPY/i;
const CHINESE_PLATFORM = /alipay|支付宝|wechat|weixin|微信|unionpay|银联/i;

/**
 * @returns {{currency: string|null, confident: boolean, reason: string|null, evidence: string[]}}
 */
export function resolveReceiptCurrency(rawText = "", { platform = null, expected = null } = {}) {
  const text = String(rawText || "");
  const upper = text.toUpperCase();
  const evidence = [];

  const explicit = SUPPORTED.filter((code) => hasCode(upper, code));
  if (CNY_WORDS.test(text) && !explicit.includes("CNY")) explicit.push("CNY");
  if (JPY_WORDS.test(text) && !explicit.includes("JPY")) explicit.push("JPY");
  explicit.forEach((code) => evidence.push(`code:${code}`));

  const yen = /[¥￥]/.test(text);
  if (yen) evidence.push("symbol:¥");

  const chinesePlatform = CHINESE_PLATFORM.test(text) || CHINESE_PLATFORM.test(String(platform || ""));
  if (chinesePlatform) evidence.push("platform:chinese");

  let currency = null;
  let confident = false;
  let reason = null;

  if (explicit.length === 1) {
    currency = explicit[0];
    confident = true;
  } else if (explicit.length > 1) {
    // Several codes named at once is not something to resolve by priority order.
    reason = CONFLICTING;
  } else if (yen) {
    // The symbol is shared. A Chinese payment platform is corroboration; nothing else is.
    if (chinesePlatform) {
      currency = "CNY";
      confident = true;
      evidence.push("resolved:yen+chinese-platform");
    } else {
      reason = AMBIGUOUS_YEN;
    }
  } else {
    reason = NO_EVIDENCE;
  }

  // The server's transaction context is authoritative; OCR may confirm it, never override it.
  const want = expected ? String(expected).toUpperCase() : null;
  if (want && currency && currency !== want) {
    return { currency: null, confident: false, reason: EXPECTED_MISMATCH, evidence };
  }
  if (want && !currency) {
    return { currency: null, confident: false, reason: reason || NO_EVIDENCE, evidence };
  }

  return { currency, confident, reason, evidence };
}

/**
 * USD equivalent of a receipt amount, using the manually set daily rate only.
 *
 * Never returns a number it cannot justify. Without a rate the caller gets
 * status "pending_rate" and must say so, instead of rendering a fabricated $0 or $2.
 * Convention is fixed and explicit: 1 USD = rate × currency.
 */
export function usdEquivalent(amount, { rate, rateDate = null, convention = "1USD=X" } = {}) {
  const value = Number(amount);
  const usdRate = Number(rate);
  if (!Number.isFinite(value)) return { status: "invalid_amount", usd: null };
  if (!Number.isFinite(usdRate) || usdRate <= 0) {
    return { status: "pending_rate", usd: null, rate: null, rateDate: null };
  }
  return {
    status: "ok",
    usd: value / usdRate,
    rate: usdRate,
    rateDate,
    convention,
  };
}
