const localeKey = (lang) => lang === "en" || lang === "ar" ? lang : "ku";

const TEXT = {
  ku: {
    setup: "ڕێکخستنی database ـی ئەم بەشە هێشتا تەواو نییە. پەیوەندی بە بەڕێوەبەری سیستەمەوە بکە.",
    denied: "دەسەڵاتی بینینی ئەم بەشەت نییە.",
    network: "پەیوەندی بە سێرڤەرەوە نەکرا. ئینتەرنێت بپشکنە و دووبارە هەوڵ بدەرەوە.",
    fallback: "ئەم بەشە ئێستا بار نەبوو. دووبارە هەوڵ بدەرەوە.",
  },
  en: {
    setup: "The database setup for this area is not complete. Contact the system administrator.",
    denied: "You do not have permission to view this area.",
    network: "The server could not be reached. Check the connection and try again.",
    fallback: "This area could not be loaded. Try again.",
  },
  ar: {
    setup: "إعداد قاعدة البيانات لهذا القسم غير مكتمل. تواصل مع مسؤول النظام.",
    denied: "ليست لديك صلاحية لعرض هذا القسم.",
    network: "تعذر الاتصال بالخادم. تحقق من الاتصال وحاول مرة أخرى.",
    fallback: "تعذر تحميل هذا القسم الآن. حاول مرة أخرى.",
  },
};

export function userFacingServiceError(cause, lang = "ku", fallback) {
  const copy = TEXT[localeKey(lang)];
  const code = String(cause?.code || "").toUpperCase();
  const message = String(cause?.message || "");
  if (code === "PGRST202" || /schema cache|could not find the function/i.test(message)) return copy.setup;
  if (code === "42501" || /not authorized|permission denied/i.test(message)) return copy.denied;
  if (/failed to fetch|network|load failed/i.test(message)) return copy.network;
  return fallback || copy.fallback;
}
