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
  "amount": <ژمارە — بڕی سەرەکی کە نێردراوە، بێ کۆما، بێ هێما>,
  "fee": <ژمارە — عمولە/کرێی گواستنەوە گەر لە فیشەکەدا نووسرابێت، ئەگینا 0>,
  "netAmount": <ژمارە — ئەو بڕەی بە ڕاستی گەیشتووەتە وەرگر (amount − fee). گەر فیشەکە خۆی «بڕی وەرگیراو» نووسیبێت، ئەوە بەکاربهێنە>,
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
- عمولە/کرێ: بەدوای وشەکانی «عمولة، رسوم، أجور، fee, charge, commission, service» بگەڕێ. گەر نەبوو، fee = 0 و netAmount = amount.
- گەر فیشەکە دوو بڕی هەبوو (نموونە: «بڕی ناردراو ١٠٠٠» و «بڕی وەرگیراو ٩٩٠»)، ئەوا amount=1000، netAmount=990، fee=10.
- گەر خانەیەک نەبوو، بیکە بە null — هەرگیز شتی هەڵبەستراو مەنووسە.
- txDate هەمیشە بە فۆرماتی YYYY-MM-DD بێت (نموونە: 2026-07-29). گەر ساڵ لە وێنەکەدا نەبوو، ساڵی ئێستا دابنێ.
- گەر وێنەکە فیشی پارەدان نەبێت: {"ok": false, "note": "ئەمە فیشی پارەدان نییە"}.
- گەر نیشانەی دەستکاریکردن هەبوو (فۆنتی ناتەبا، لێواری ناسروشتی، پیکسڵی شێواو)، لە note ئاگاداری بدە و confidence نزم بکەرەوە.`;

const USER_MSG = "ئەم فیشە بخوێنەوە و بە JSON بیگەڕێنەوە.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Gemini (بەخۆڕایی) ── */
// زنجیرەی مۆدێلەکان — گەر یەکەم نەبوو، دواتری تاقی دەکرێتەوە
const GEMINI_MODELS = [process.env.GEMINI_MODEL, "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3-flash"].filter(Boolean);

async function geminiOnce(model, key, image, mediaType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [{ parts: [{ inline_data: { mime_type: mediaType, data: image } }, { text: USER_MSG }] }],
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: 2000 },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) {
    const e = new Error(`${model}: ${j.error.message || "هەڵە"}`);
    e.status = j.error.code || r.status;
    throw e;
  }
  const out = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  if (!out) { const e = new Error(`${model}: وەڵامی بەتاڵ`); e.status = 500; throw e; }
  return out;
}

async function callGemini(key, image, mediaType) {
  let last;
  for (const m of GEMINI_MODELS) {
    try { return await geminiOnce(m, key, image, mediaType); }
    catch (e) {
      last = e;
      // تەنها گەر مۆدێلەکە نەبوو، دواتری تاقی بکەوە
      if (e.status === 404 || /not found|not supported|deprecat/i.test(e.message)) continue;
      throw e;
    }
  }
  throw last || new Error("هیچ مۆدێلێکی Gemini بەردەست نییە");
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
