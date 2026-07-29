// ═══════════════════════════════════════════════════════════
//  api/read-receipt.js
//  خوێندنەوەی فیشی پارەدان — پشتگیری Gemini (بەخۆڕایی) و Claude
//
//  لە Vercel یەکێک لەم کلیلانە دابنێ:
//    GEMINI_API_KEY     ← بەخۆڕایی (aistudio.google.com)
//    ANTHROPIC_API_KEY  ← بە پارە، وردتر (console.anthropic.com)
//  گەر هەردووکیان دانرابن، Claude بەکاردێت.
// ═══════════════════════════════════════════════════════════

const SYSTEM = `تۆ سیستەمێکی خوێندنەوەی فیشی پارەدانیت بۆ سەرافییەکی عێراقی/کوردی.
وێنەی فیشێکی پارەدانت پێدەدرێت (لە ئەپەکانی FIB, FastPay, Zain Cash, NassWallet, بانک, Alipay, WeChat Pay, یان وەسڵی دەستنووس).

ئەرکی تۆ: زانیارییەکان دەربهێنە و تەنها JSONـێکی پاک بگەڕێنەوە — بێ هیچ دەقێکی زیادە، بێ markdown.

{
  "ok": true,
  "amount": <ژمارە — تەنها بڕی سەرەکی، بێ کۆما، بێ هێما>,
  "currency": "<USD | IQD | CNY | EUR | TRY | نەزانراو>",
  "sender": "<ناوی نێرەر یان ژمارەی هەژماری نێرەر>",
  "receiver": "<ناوی وەرگر>",
  "refNo": "<ژمارەی مامەڵە / Transaction ID / Reference — گرنگترین خانەیە>",
  "txTime": "<بەروار و کات وەک لە وێنەکەدا نووسراوە>",
  "txDate": "<هەمان بەروار بەڵام بە فۆرماتی YYYY-MM-DD — گەر نەزانرا: null>",
  "bank": "<ناوی ئەپ یان بانک>",
  "kind": "<transfer | deposit | withdrawal | unknown>",
  "confidence": <0 بۆ 1>,
  "note": "<تێبینی گرنگ، بۆ نموونە: وێنەکە ناڕوونە، یان دەستکاری کراوە دەردەکەوێت>"
}

ڕێنمایی:
- ژمارە عەرەبی/فارسییەکان (٠١٢٣٤٥٦٧٨٩) بگۆڕە بۆ لاتینی.
- گەر دوو بڕ هەبوو (بڕ + کرێ)، بڕی سەرەکی هەڵبژێرە و کرێیەکە لە note بنووسە.
- گەر خانەیەک نەبوو، بیکە بە null — هەرگیز شتی هەڵبەستراو مەنووسە.
- txDate هەمیشە بە فۆرماتی YYYY-MM-DD بێت (نموونە: 2026-07-29). گەر ساڵ لە وێنەکەدا نەبوو، ساڵی ئێستا دابنێ.
- گەر وێنەکە فیشی پارەدان نەبێت: {"ok": false, "note": "ئەمە فیشی پارەدان نییە"}.
- گەر نیشانەی دەستکاریکردن هەبوو (فۆنتی ناتەبا، لێواری ناسروشتی، پیکسڵی شێواو)، لە note ئاگاداری بدە و confidence نزم بکەرەوە.`;

const USER_MSG = "ئەم فیشە بخوێنەوە و بە JSON بیگەڕێنەوە.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Gemini (بەخۆڕایی) ── */
async function callGemini(key, image, mediaType) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const body = {
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [{ parts: [{ inline_data: { mime_type: mediaType, data: image } }, { text: USER_MSG }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 800 },
  };
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) {
    const e = new Error(j.error.message || "هەڵەی Gemini");
    e.status = j.error.code || r.status;
    throw e;
  }
  return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
}

/* ── Claude (بە پارە) ── */
async function callClaude(key, image, mediaType) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
      max_tokens: 800,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text: USER_MSG },
        ],
      }],
    }),
  });
  const j = await r.json();
  if (j.error) { const e = new Error(j.error.message || "هەڵەی Claude"); e.status = r.status; throw e; }
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const gKey = process.env.GEMINI_API_KEY;
  const aKey = process.env.ANTHROPIC_API_KEY;
  if (!gKey && !aKey) {
    res.status(500).json({ error: "هیچ کلیلێک دانەنراوە — GEMINI_API_KEY یان ANTHROPIC_API_KEY لە Vercel دابنێ" });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { image, mediaType = "image/jpeg" } = body;
    if (!image) { res.status(400).json({ error: "وێنە نەنێردراوە" }); return; }

    const run = () => (aKey ? callClaude(aKey, image, mediaType) : callGemini(gKey, image, mediaType));

    let text;
    try { text = await run(); }
    catch (e) {
      // گەر سنووری خێرایی تێپەڕی بوو، جارێکی تر هەوڵ بدە
      if (e.status === 429 || e.status === 503) { await sleep(7000); text = await run(); }
      else throw e;
    }

    const clean = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { parsed = { ok: false, note: "نەتوانرا وەڵامەکە بخوێندرێتەوە", raw: clean.slice(0, 300) }; }

    res.status(200).json(parsed);
  } catch (e) {
    const m = String(e?.message || e);
    const friendly = /429|quota|rate/i.test(m)
      ? "سنووری خێرایی تێپەڕی — چەند چرکەیەک چاوەڕێ بکە و دووبارە هەوڵ بدە"
      : m;
    res.status(500).json({ error: friendly });
  }
}
