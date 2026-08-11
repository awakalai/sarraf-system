import { resolveReceiptCurrency } from "../src/services/receiptCurrency.js";

const VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";

const latinDigits = (value) => String(value || "")
  .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
  .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));

const numberFrom = (value) => {
  const match = latinDigits(value).replace(/,/g, "").match(/-?\d+(?:\.\d{1,3})?/);
  return match ? Number(match[0]) : null;
};

const valueNear = (lines, labels) => {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const label = labels.find((candidate) => line.toLowerCase().includes(candidate.toLowerCase()));
    if (!label) continue;
    const inline = line.slice(line.toLowerCase().indexOf(label.toLowerCase()) + label.length).replace(/^\s*[:：-]?\s*/, "");
    if (inline) return inline;
    if (lines[i + 1]) return lines[i + 1];
  }
  return null;
};

const confidenceFields = (score = 0.2) => ({
  amount: score, fee: score, orderAmount: score, currency: score,
  paymentMethod: score, transactionStatus: score, sender: score,
  receiver: score, refNo: score, merchantOrderNo: score,
  txDate: score, txTime: score, platform: score,
});

export function parseGoogleVisionReceipt(text) {
  const rawText = latinDigits(text).trim();
  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const amountRaw = valueNear(lines, ["total amount", "transaction amount", "amount", "订单金额", "المبلغ"]);
  const feeRaw = valueNear(lines, ["international card fee", "handling fee", "fee", "手续费", "العمولة"]);
  const refNo = valueNear(lines, ["transfer order no.", "transfer order no", "order no.", "reference no", "transaction id", "رقم المرجع"]);
  const status = valueNear(lines, ["current status", "transaction status", "status", "الحالة"]);
  const amount = numberFrom(amountRaw);
  const fee = numberFrom(feeRaw);
  const platform = /alipay|支付宝/i.test(rawText) ? "Alipay"
    : /wechat|微信/i.test(rawText) ? "WeChat"
      : /\bFIB\b/i.test(rawText) ? "FIB"
        : /fastpay/i.test(rawText) ? "FastPay"
          : /zaincash/i.test(rawText) ? "ZainCash"
            : /nasswallet/i.test(rawText) ? "NassWallet"
              : /qi\s*card/i.test(rawText) ? "QiCard" : null;
  // Currency is resolved from explicit evidence only. A loose substring scan previously let
  // the letters "IQD" anywhere in a Chinese receipt define the whole document's currency.
  const resolved = resolveReceiptCurrency(rawText, { platform });
  const currency = resolved.currency;
  const detected = [amount != null, currency, refNo, status, platform].filter(Boolean).length;
  const score = Math.min(0.72, 0.28 + detected * 0.08);
  const fieldConfidence = confidenceFields(0.18);
  if (amount != null) fieldConfidence.amount = 0.7;
  if (fee != null) fieldConfidence.fee = 0.68;
  if (currency) fieldConfidence.currency = 0.72;
  if (refNo) fieldConfidence.refNo = 0.66;
  if (status) fieldConfidence.transactionStatus = 0.62;
  if (platform) fieldConfidence.platform = 0.7;

  return {
    ok: detected >= 2,
    amount, fee, feeOriginal: null, feeDiscount: null,
    netAmount: amount != null && fee != null ? Math.abs(amount) - Math.abs(fee) : null,
    orderAmount: null, currency, paymentMethod: null, cardLast4: null,
    transactionStatus: status, recipientNote: null, merchantName: null,
    platformEvidence: platform ? `Google Vision OCR: ${platform}` : null,
    sender: null, receiver: null, refNo, merchantOrderNo: null,
    txTime: null, txDate: null, bank: null, platform, kind: "payment_receipt",
    confidence: score, fieldConfidence,
    note: "Google Cloud Vision OCR fallback; low-confidence fields require manual review.",
  };
}

export async function callGoogleVision(key, image, mediaType) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const started = Date.now();
  try {
    const response = await fetch(`${VISION_ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ image: { content: image }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }] }),
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    const upstreamError = json?.responses?.[0]?.error || json?.error;
    if (!response.ok || upstreamError) {
      const error = new Error(`Google Vision: ${upstreamError?.message || `HTTP ${response.status}`}`);
      error.status = Number(upstreamError?.code) || response.status || 500;
      throw error;
    }
    const text = json?.responses?.[0]?.fullTextAnnotation?.text || json?.responses?.[0]?.textAnnotations?.[0]?.description || "";
    if (!text.trim()) {
      const error = new Error("Google Vision: no text detected");
      error.status = 422;
      throw error;
    }
    return {
      data: parseGoogleVisionReceipt(text),
      meta: { provider: "google-vision", model: "DOCUMENT_TEXT_DETECTION", mediaType, latencyMs: Date.now() - started },
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("Google Vision: request timed out");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
