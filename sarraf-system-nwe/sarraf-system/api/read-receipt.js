// api/read-receipt.js
// Receipt OCR v2 — structured multimodal extraction for Sarraf.
// Uses Gemini by default. Claude remains an optional fallback/provider.
// No Supabase writes happen in this endpoint.

const MAX_BASE64_CHARS = 12_000_000;
const RETRYABLE = new Set([429, 502, 503, 504]);

const RECEIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    amount: { type: ["number", "null"] },
    fee: { type: ["number", "null"] },
    feeOriginal: { type: ["number", "null"] },
    feeDiscount: { type: ["number", "null"] },
    netAmount: { type: ["number", "null"] },
    currency: { type: ["string", "null"] },
    sender: { type: ["string", "null"] },
    receiver: { type: ["string", "null"] },
    refNo: { type: ["string", "null"] },
    txTime: { type: ["string", "null"] },
    txDate: { type: ["string", "null"] },
    bank: { type: ["string", "null"] },
    platform: { type: ["string", "null"] },
    kind: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    fieldConfidence: {
      type: "object",
      additionalProperties: false,
      properties: {
        amount: { type: "number", minimum: 0, maximum: 1 },
        fee: { type: "number", minimum: 0, maximum: 1 },
        currency: { type: "number", minimum: 0, maximum: 1 },
        sender: { type: "number", minimum: 0, maximum: 1 },
        receiver: { type: "number", minimum: 0, maximum: 1 },
        refNo: { type: "number", minimum: 0, maximum: 1 },
        txDate: { type: "number", minimum: 0, maximum: 1 },
        txTime: { type: "number", minimum: 0, maximum: 1 },
        platform: { type: "number", minimum: 0, maximum: 1 }
      },
      required: ["amount", "fee", "currency", "sender", "receiver", "refNo", "txDate", "txTime", "platform"]
    },
    note: { type: ["string", "null"] }
  },
  required: [
    "ok", "amount", "fee", "feeOriginal", "feeDiscount", "netAmount",
    "currency", "sender", "receiver", "refNo", "txTime", "txDate",
    "bank", "platform", "kind", "confidence", "fieldConfidence", "note"
  ]
};

const SYSTEM = `You extract payment-receipt data for an Iraqi/Kurdish currency-exchange system.

The image may come from FIB, FastPay, ZainCash, NassWallet, Qi Card, a bank app, Alipay, WeChat Pay, or another transfer/payment service.

Accuracy rules:
1. Never invent a value. If a field is not visible or not reliable, return null and lower that field's confidence.
2. "amount" is the transaction amount, NOT account balance, wallet balance, available balance, exchange rate, or a random number elsewhere on the screen.
3. "refNo" is the transaction/order/reference/trace/operation ID. Preserve letters and digits. Do not use phone numbers, account numbers, or timestamps as the reference unless the receipt explicitly labels them as transaction/reference/order/trace IDs.
4. Normalize Arabic/Persian/Kurdish digits to Latin digits.
5. Currency should be an uppercase ISO-style code when identifiable (IQD, USD, CNY, EUR, TRY, AED, SAR, etc.).
6. fee = final fee actually charged. feeOriginal = fee before discount. feeDiscount = discount amount. If there is no fee, use 0 where clearly applicable.
7. netAmount is the amount actually received when explicitly shown; otherwise amount - fee if that interpretation is valid for the receipt.
8. txDate must be YYYY-MM-DD only when recoverable. If the year is absent, use the current year only when the rest of the date is clearly visible.
9. platform should identify the app/service when visible, e.g. FIB, FastPay, ZainCash, NassWallet, QiCard, Alipay, WeChat, Bank.
10. If the image is not a payment/transfer receipt, set ok=false.
11. If the image may be edited/tampered, mention that in note and reduce confidence.
12. confidence is overall confidence. fieldConfidence is separate confidence for each extracted field.
13. Return only data matching the JSON schema.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const toLatinDigits = (value) => String(value ?? "")
  .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
  .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));

const cleanText = (v) => {
  if (v == null) return null;
  const s = toLatinDigits(v).trim();
  return s && !/^(null|unknown|نەزانراو)$/i.test(s) ? s : null;
};

const numberOrNull = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = toLatinDigits(v)
    .replace(/[,\s٬،]/g, "")
    .replace(/[^\d.+-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const clamp01 = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
};

function normalizeResult(parsed) {
  const ok = parsed?.ok !== false;
  const amount = numberOrNull(parsed?.amount);
  let fee = numberOrNull(parsed?.fee);
  let feeOriginal = numberOrNull(parsed?.feeOriginal);
  let feeDiscount = numberOrNull(parsed?.feeDiscount);
  let netAmount = numberOrNull(parsed?.netAmount);

  if (fee == null) fee = 0;
  if (feeOriginal == null) feeOriginal = fee;
  if (feeDiscount == null) feeDiscount = Math.max(0, feeOriginal - fee);
  if (netAmount == null && amount != null) netAmount = Math.max(0, amount - fee);

  let currency = cleanText(parsed?.currency);
  if (currency) currency = currency.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6) || null;

  let txDate = cleanText(parsed?.txDate);
  if (txDate && !/^\d{4}-\d{2}-\d{2}$/.test(txDate)) txDate = null;

  const fcIn = parsed?.fieldConfidence || {};
  const fieldConfidence = {
    amount: clamp01(fcIn.amount, amount != null ? 0.7 : 0),
    fee: clamp01(fcIn.fee, 0.7),
    currency: clamp01(fcIn.currency, currency ? 0.7 : 0),
    sender: clamp01(fcIn.sender, 0.5),
    receiver: clamp01(fcIn.receiver, 0.5),
    refNo: clamp01(fcIn.refNo, parsed?.refNo ? 0.6 : 0),
    txDate: clamp01(fcIn.txDate, txDate ? 0.6 : 0),
    txTime: clamp01(fcIn.txTime, parsed?.txTime ? 0.6 : 0),
    platform: clamp01(fcIn.platform, parsed?.platform || parsed?.bank ? 0.6 : 0),
  };

  return {
    ok,
    amount,
    fee,
    feeOriginal,
    feeDiscount,
    netAmount,
    currency,
    sender: cleanText(parsed?.sender),
    receiver: cleanText(parsed?.receiver),
    refNo: cleanText(parsed?.refNo),
    txTime: cleanText(parsed?.txTime),
    txDate,
    bank: cleanText(parsed?.bank),
    platform: cleanText(parsed?.platform),
    kind: cleanText(parsed?.kind),
    confidence: clamp01(parsed?.confidence, ok ? 0.5 : 0.2),
    fieldConfidence,
    note: cleanText(parsed?.note),
  };
}

function extractText(json) {
  return (json?.candidates?.[0]?.content?.parts || [])
    .map((p) => p?.text || "")
    .join("")
    .trim();
}

async function geminiOnce(model, key, image, mediaType, currentDate) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  const started = Date.now();
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{
        role: "user",
        parts: [
          { inline_data: { mime_type: mediaType, data: image } },
          { text: `Read this receipt. Current date: ${currentDate}. Extract only visible/reliable transaction data.` }
        ]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: RECEIPT_SCHEMA,
        maxOutputTokens: 1800,
        temperature: 0.1,
        thinkingConfig: { thinkingLevel: "low" }
      }
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const j = await r.json().catch(() => ({}));

    if (!r.ok || j?.error) {
      const e = new Error(`${model}: ${j?.error?.message || `HTTP ${r.status}`}`);
      e.status = j?.error?.code || r.status;
      throw e;
    }
    const raw = extractText(j);
    if (!raw) {
      const e = new Error(`${model}: empty response`);
      e.status = 500;
      throw e;
    }

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
      parsed = JSON.parse(cleaned);
    }

    return {
      data: normalizeResult(parsed),
      meta: { provider: "gemini", model, latencyMs: Date.now() - started }
    };
  } catch (e) {
    if (e?.name === "AbortError") {
      const err = new Error(`${model}: request timed out`);
      err.status = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function callGemini(key, image, mediaType, currentDate) {
  const models = [
    process.env.GEMINI_MODEL,
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite"
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  let last;
  for (const model of models) {
    try {
      return await geminiOnce(model, key, image, mediaType, currentDate);
    } catch (e) {
      last = e;
      if (e.status === 404 || /not found|not supported|deprecat/i.test(String(e.message))) continue;
      throw e;
    }
  }
  throw last || new Error("No Gemini OCR model is available");
}

async function callClaude(key, image, mediaType, currentDate) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  const started = Date.now();
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
        max_tokens: 1600,
        temperature: 0,
        system: SYSTEM,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
            { type: "text", text: `Current date: ${currentDate}. Return only a JSON object matching the requested receipt fields.` }
          ]
        }]
      }),
      signal: controller.signal
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) {
      const e = new Error(j?.error?.message || `Claude HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    const raw = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    const clean = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean);

    return {
      data: normalizeResult(parsed),
      meta: { provider: "claude", model: process.env.CLAUDE_MODEL || "claude-sonnet-5", latencyMs: Date.now() - started }
    };
  } catch (e) {
    if (e?.name === "AbortError") {
      const err = new Error("Claude request timed out");
      err.status = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "POST only" });
    return;
  }

  const gKey = process.env.GEMINI_API_KEY;
  const aKey = process.env.ANTHROPIC_API_KEY;
  if (!gKey && !aKey) {
    res.status(500).json({ error: "GEMINI_API_KEY یان ANTHROPIC_API_KEY لە Vercel دانەنراوە" });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const image = body?.image;
    const mediaType = String(body?.mediaType || "image/jpeg").toLowerCase();

    if (!image || typeof image !== "string") {
      res.status(400).json({ error: "وێنە نەنێردراوە" });
      return;
    }
    if (!mediaType.startsWith("image/")) {
      res.status(400).json({ error: "جۆری فایل پشتگیری ناکرێت" });
      return;
    }
    if (image.length > MAX_BASE64_CHARS) {
      res.status(413).json({ error: "قەبارەی وێنە زۆر گەورەیە" });
      return;
    }

    const currentDate = new Date().toISOString().slice(0, 10);
    const provider = String(process.env.OCR_PROVIDER || "gemini").toLowerCase();

    const run = async () => {
      if (provider === "claude" && aKey) return callClaude(aKey, image, mediaType, currentDate);
      if (gKey) return callGemini(gKey, image, mediaType, currentDate);
      return callClaude(aKey, image, mediaType, currentDate);
    };

    let result;
    try {
      result = await run();
    } catch (e) {
      if (RETRYABLE.has(Number(e?.status))) {
        await sleep(1800);
        result = await run();
      } else {
        throw e;
      }
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ...result.data,
      _meta: result.meta,
      ocrVersion: 2
    });
  } catch (e) {
    const status = Number(e?.status);
    const message = String(e?.message || e);
    const friendly = status === 429 || /quota|rate limit/i.test(message)
      ? "سنووری API پڕبووە — دووبارە هەوڵ بدە"
      : status === 504 || /timed out/i.test(message)
        ? "خوێندنەوە زۆر درێژەی کێشا — دووبارە هەوڵ بدە"
        : message;
    res.status(RETRYABLE.has(status) ? 503 : 500).json({ error: friendly });
  }
}
