// api/read-receipt.js
// Receipt OCR v2 — structured multimodal extraction for Sarraf.
// Uses Groq Qwen Vision as primary when configured, with Gemini and Claude fallbacks.
// No Supabase writes happen in this endpoint.

const MAX_BASE64_CHARS = 3_500_000;
const RETRYABLE = new Set([502, 503, 504]);

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
    merchantOrderNo: { type: ["string", "null"] },
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
        merchantOrderNo: { type: "number", minimum: 0, maximum: 1 },
        txDate: { type: "number", minimum: 0, maximum: 1 },
        txTime: { type: "number", minimum: 0, maximum: 1 },
        platform: { type: "number", minimum: 0, maximum: 1 }
      },
      required: ["amount", "fee", "currency", "sender", "receiver", "refNo", "merchantOrderNo", "txDate", "txTime", "platform"]
    },
    note: { type: ["string", "null"] }
  },
  required: [
    "ok", "amount", "fee", "feeOriginal", "feeDiscount", "netAmount",
    "currency", "sender", "receiver", "refNo", "merchantOrderNo", "txTime", "txDate",
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
13. Alipay-specific rule: when both the merchant/display name at the top and a field explicitly labeled "Full name of payee" are visible, receiver MUST come from "Full name of payee". Do not combine the two names.
14. Alipay-specific rule: refNo MUST come from "Order No." when visible. merchantOrderNo MUST come from "Merchant order No." when visible. Never swap these two IDs.
15. Preserve decimal cents/fen exactly as shown. Example: 1,262.78 must remain 1262.78, not 1263.
16. Return only data matching the JSON schema.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const retryAfterSecondsFrom = (response, json) => {
  const header = Number(response?.headers?.get?.("retry-after"));
  if (Number.isFinite(header) && header > 0) return header;
  const details = json?.error?.details || [];
  for (const d of details) {
    const raw = d?.retryDelay || d?.retry_delay;
    const m = String(raw || "").match(/([0-9]+(?:\.[0-9]+)?)s/i);
    if (m) return Math.ceil(Number(m[1]));
  }
  return null;
};

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
    merchantOrderNo: clamp01(fcIn.merchantOrderNo, parsed?.merchantOrderNo ? 0.6 : 0),
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
    merchantOrderNo: cleanText(parsed?.merchantOrderNo),
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


const parseJsonObject = (raw, provider = "OCR") => {
  const text = String(raw || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  if (!text) {
    const e = new Error(`${provider}: empty JSON response`);
    e.status = 502;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    const e = new Error(`${provider}: invalid JSON response`);
    e.status = 502;
    throw e;
  }
};

const receiptShapePrompt = (currentDate) => `Read this payment receipt. Current date: ${currentDate}.
Return ONE JSON object only with exactly these fields:
ok, amount, fee, feeOriginal, feeDiscount, netAmount, currency, sender, receiver,
refNo, merchantOrderNo, txTime, txDate, bank, platform, kind, confidence,
fieldConfidence, note.
fieldConfidence must contain: amount, fee, currency, sender, receiver, refNo,
merchantOrderNo, txDate, txTime, platform.
Use null when a value is not visible/reliable. Confidence values must be 0..1.
Follow all system accuracy rules exactly.`;

async function callGroq(key, image, mediaType, currentDate) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  const started = Date.now();
  const model = process.env.GROQ_MODEL || "qwen/qwen3.6-27b";

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: receiptShapePrompt(currentDate) },
              {
                type: "image_url",
                image_url: { url: `data:${mediaType};base64,${image}` },
              },
            ],
          },
        ],
        response_format: { type: "json_object" },
        reasoning_effort: "none",
        temperature: 0.2,
        max_completion_tokens: 1600,
        stream: false,
      }),
      signal: controller.signal,
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) {
      const e = new Error(`Groq: ${j?.error?.message || `HTTP ${r.status}`}`);
      e.status = r.status || j?.error?.code || 500;
      e.retryAfterSeconds = retryAfterSecondsFrom(r, j);
      throw e;
    }

    const raw = j?.choices?.[0]?.message?.content;
    const parsed = parseJsonObject(raw, "Groq");
    return {
      data: normalizeResult(parsed),
      meta: {
        provider: "groq",
        model,
        latencyMs: Date.now() - started,
        remainingRequests: r.headers.get("x-ratelimit-remaining-requests") || null,
        remainingTokens: r.headers.get("x-ratelimit-remaining-tokens") || null,
      },
    };
  } catch (e) {
    if (e?.name === "AbortError") {
      const err = new Error("Groq: request timed out");
      err.status = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
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
      e.retryAfterSeconds = retryAfterSecondsFrom(r, j);
      throw e;
    }
    const raw = extractText(j);
    if (!raw) {
      const e = new Error(`${model}: empty response`);
      e.status = 500;
      throw e;
    }

    const parsed = parseJsonObject(raw, model);

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
    const parsed = parseJsonObject(raw, "Claude");

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
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "POST only" });
    return;
  }

  const qKey = process.env.GROQ_API_KEY;
  const gKey = process.env.GEMINI_API_KEY;
  const aKey = process.env.ANTHROPIC_API_KEY;
  if (!qKey && !gKey && !aKey) {
    res.status(500).json({ error: "GROQ_API_KEY یان GEMINI_API_KEY یان ANTHROPIC_API_KEY لە Vercel دانەنراوە" });
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
    const requestedProvider = String(process.env.OCR_PROVIDER || "").toLowerCase().trim();

    const providers = [];
    const addProvider = (name, key, fn) => {
      if (key && !providers.some((p) => p.name === name)) providers.push({ name, key, fn });
    };

    // Default order: Groq -> Gemini -> Claude.
    // OCR_PROVIDER can force the first provider without disabling fallbacks.
    if (requestedProvider === "gemini") addProvider("gemini", gKey, callGemini);
    else if (requestedProvider === "claude") addProvider("claude", aKey, callClaude);
    else addProvider("groq", qKey, callGroq);

    addProvider("groq", qKey, callGroq);
    addProvider("gemini", gKey, callGemini);
    addProvider("claude", aKey, callClaude);

    if (!providers.length) throw new Error("No OCR provider is configured");

    const attempts = [];
    let result = null;
    let lastError = null;

    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      try {
        result = await p.fn(p.key, image, mediaType, currentDate);
        result.meta = {
          ...(result.meta || {}),
          fallbackFrom: attempts.length ? attempts.map((x) => x.provider) : [],
        };
        break;
      } catch (e) {
        lastError = e;
        attempts.push({
          provider: p.name,
          status: Number(e?.status) || null,
          message: String(e?.message || e).slice(0, 220),
        });

        const status = Number(e?.status);
        const fallbackable = status === 429 || status === 404 || status === 500 || RETRYABLE.has(status) ||
          /rate limit|quota|timed out|temporar|service unavailable|model.*not found/i.test(String(e?.message || ""));

        if (!fallbackable) throw e;

        // If there is no second provider configured, retry transient upstream errors once.
        if (i === providers.length - 1 && RETRYABLE.has(status)) {
          await sleep(500);
          result = await p.fn(p.key, image, mediaType, currentDate);
          result.meta = { ...(result.meta || {}), fallbackFrom: attempts.map((x) => x.provider) };
          break;
        }
      }
    }

    if (!result) {
      if (lastError) {
        lastError.attempts = attempts;
        throw lastError;
      }
      throw new Error("OCR providers failed");
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ...result.data,
      _meta: result.meta,
      ocrVersion: 3
    });
  } catch (e) {
    const status = Number(e?.status);
    const message = String(e?.message || e);
    const friendly = status === 429 || /quota|rate limit/i.test(message)
      ? "سنووری API پڕبووە — دووبارە هەوڵ بدە"
      : status === 504 || /timed out/i.test(message)
        ? "خوێندنەوە زۆر درێژەی کێشا — دووبارە هەوڵ بدە"
        : message;
    const httpStatus = status === 429 ? 429 : RETRYABLE.has(status) ? 503 : (status >= 400 && status < 500 ? status : 500);
    res.status(httpStatus).json({
      error: friendly,
      retryable: status === 429 || RETRYABLE.has(status) || status === 504,
      retryAfterSeconds: Number(e?.retryAfterSeconds) || null,
      providersTried: Array.isArray(e?.attempts) ? e.attempts.map((x) => x.provider) : undefined,
    });
  }
}
