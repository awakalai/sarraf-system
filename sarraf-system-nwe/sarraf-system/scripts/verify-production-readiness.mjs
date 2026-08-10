import fs from "node:fs";
import path from "node:path";

const read = (file) => fs.readFileSync(file, "utf8");
const required = (condition, message) => { if (!condition) throw new Error(message); };

const html = read("index.html");
const appHtml = read("app-files/index.html");
const main = read("src/main.jsx");
const app = read("src/App.jsx");
const vite = read("vite.config.js");
const vercel = read("vercel.json");

required(!/cdn\.tailwindcss\.com|fonts\.googleapis\.com/i.test(html + appHtml + app), "Runtime CSS/font CDN dependency is not allowed");
required(main.includes('"./styles/tailwind.css"'), "Compiled Tailwind entry is missing");
required(main.includes("@fontsource/ibm-plex-sans-arabic"), "Self-hosted Kurdish/Arabic font is missing");
required(main.includes("AppErrorBoundary"), "Application recovery boundary is missing");
required(app.includes('href="#zeman-main-content"') && app.includes('id="zeman-main-content"') && app.includes("tabIndex={-1}"), "Skip navigation contract is incomplete");
required(app.includes('lang === "ku" ? "ckb" : lang'), "Kurdish document language must use the BCP 47 ckb code");
required(/aria-label=\{tr\("ئاگادارییەکان"\)\}/.test(app), "Notification control needs an accessible name");
required(vite.includes("manualChunks") && vite.includes("supabase-vendor"), "Production vendor splitting is missing");
required(/Content-Security-Policy/.test(vercel) && /script-src 'self'/.test(vercel), "Strict production CSP is missing");
required(!/<script(?![^>]+type="module")[^>]*>/i.test(html), "Unexpected inline or external runtime script in HTML");

const assets = fs.readdirSync("dist/assets");
const javascript = assets.filter((file) => file.endsWith(".js")).map((file) => ({ file, bytes: fs.statSync(path.join("dist/assets", file)).size }));
required(javascript.length >= 3, "Expected split production JavaScript chunks");
const oversized = javascript.filter(({ bytes }) => bytes > 500_000);
required(!oversized.length, `Oversized JavaScript chunks: ${oversized.map(({ file, bytes }) => `${file} (${bytes})`).join(", ")}`);
required(assets.some((file) => file.endsWith(".woff2")), "Self-hosted production font assets were not emitted");

console.log(`Production readiness contracts passed across ${javascript.length} JavaScript chunks.`);
