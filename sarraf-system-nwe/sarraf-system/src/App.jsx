import React, { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "./lib/supabase";
import { createClient } from "@supabase/supabase-js";
import {
  LayoutDashboard, Vault, ArrowLeftRight, ListOrdered, Users, Handshake,
  TrendingUp, Building2, UserCog, PieChart, History, Plus, Trash2, Pencil,
  CheckCircle2, AlertTriangle, Eye, LogOut, Wallet, ChevronLeft, Coins,
  Receipt, TrendingDown, ScanLine, Upload, XCircle, SlidersHorizontal, MoreHorizontal, X, Share2, Database, Download, ClipboardCheck, RotateCcw, MessageCircle
} from "lucide-react";

/* ══════════════════ یارمەتیدەرەکان ══════════════════ */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const now = () => new Date().toISOString();
const ROLE_KU = { admin: "ئەدمین", customer: "کڕیار-فرۆشیار", partner: "هاوبەشی سین", investor: "وەبەرهێنەر", office: "نووسینگە" };

const fmt = (n, dec = 2) => {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dec });
};
const num = { fontVariantNumeric: "tabular-nums", direction: "ltr", unicodeBidi: "embed" };

/* ڕەنگ و هێمای دراوەکان */
const CUR_STYLE = {
  usd: { bg: "from-emerald-500 to-emerald-700", ring: "ring-emerald-500/20", txt: "text-emerald-700", sym: "$" },
  eur: { bg: "from-blue-500 to-blue-700", ring: "ring-blue-500/20", txt: "text-blue-700", sym: "€" },
  cny: { bg: "from-rose-500 to-rose-700", ring: "ring-rose-500/20", txt: "text-rose-700", sym: "¥" },
  jpy: { bg: "from-rose-400 to-rose-600", ring: "ring-rose-400/20", txt: "text-rose-600", sym: "¥" },
  iqd: { bg: "from-amber-500 to-amber-700", ring: "ring-amber-500/20", txt: "text-amber-700", sym: "ع" },
  try: { bg: "from-cyan-500 to-cyan-700", ring: "ring-cyan-500/20", txt: "text-cyan-700", sym: "₺" },
  gbp: { bg: "from-violet-500 to-violet-700", ring: "ring-violet-500/20", txt: "text-violet-700", sym: "£" },
  aed: { bg: "from-teal-500 to-teal-700", ring: "ring-teal-500/20", txt: "text-teal-700", sym: "د.إ" },
  gold: { bg: "from-yellow-400 to-amber-600", ring: "ring-yellow-500/20", txt: "text-amber-600", sym: "Au" },
  _default: { bg: "from-slate-500 to-slate-700", ring: "ring-slate-500/20", txt: "text-slate-700", sym: "¤" },
};
const curStyle = (c) => CUR_STYLE[(c?.id || "").toLowerCase()] || CUR_STYLE._default;

/* نیشانەی دراو — گۆی ڕەنگاوڕەنگ */
const CurBadge = ({ c, size = "md", pulse }) => {
  const st = curStyle(c);
  const dim = size === "lg" ? "w-11 h-11 text-base" : size === "sm" ? "w-7 h-7 text-[11px]" : "w-9 h-9 text-sm";
  return (
    <div className={`${dim} rounded-full bg-gradient-to-br ${st.bg} text-white font-bold flex items-center justify-center shadow-sm ring-4 ${st.ring} shrink-0 ${pulse ? "cur-pop" : ""}`}>
      {c?.symbol || st.sym}
    </div>
  );
};

/* گۆڕینی بڕێک بۆ دۆلار بەپێی نرخی ئەمڕۆ — بەپێی کۆدی دراو */
const usdConv = (data) => (amount, code) => {
  if (!amount || !code) return null;
  const c = (data?.currencies || []).find((x) => x.code === code);
  if (!c) return null;
  if (c.id === "usd") return amount;
  const mid = c.buyRate && c.sellRate ? (c.buyRate + c.sellRate) / 2 : (c.buyRate || c.sellRate);
  return mid ? amount / mid : null;
};

/* نیشاندانی بەرامبەری دۆلار */
const UsdHint = ({ v, className = "" }) =>
  v == null ? null : <span className={`text-slate-400 ${className}`} style={num}>≈ {fmt(v, 0)} $</span>;

/* ژمارەی جوڵاو */
function CountUp({ v, dec = 0, className = "", style }) {
  const [d, setD] = useState(v);
  const prev = useRef(v);
  useEffect(() => {
    const from = prev.current, to = v;
    if (from === to) return;
    let raf, t0 = null;
    const dur = 550;
    const step = (t) => {
      if (!t0) t0 = t;
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setD(from + (to - from) * e);
      if (p < 1) raf = requestAnimationFrame(step); else prev.current = to;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [v]);
  return <span className={className} style={{ ...num, ...style }}>{fmt(d, dec)}</span>;
}
const dOnly = (d) => (d || "").slice(0, 10);

/* ══════════════════ پێکهاتە بچووکەکان ══════════════════ */
const Card = ({ children, className = "", onClick, dark, accent, style }) => {
  const base = dark ? "bg-slate-900 border-slate-900 text-white"
    : accent ? "bg-emerald-700 border-emerald-700 text-white"
    : "bg-white border-stone-200/80";
  return (
    <div onClick={onClick} style={style}
      className={`${base} border rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${onClick ? "cursor-pointer lift press hover:border-emerald-500" : ""} ${className}`}>
      {children}
    </div>
  );
};
const H = ({ children, sub }) => (
  <div className="mb-4">
    <h2 className="text-xl font-bold text-slate-900 tracking-tight">{children}</h2>
    {sub && <p className="text-sm text-slate-500 mt-0.5">{sub}</p>}
  </div>
);
const SecLbl = ({ children }) => <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">{children}</div>;
const Lbl = ({ children }) => <label className="block text-[13px] font-medium text-slate-600 mb-1.5">{children}</label>;
const Inp = (p) => <input {...p} className={`w-full border border-stone-300 rounded-xl px-3 py-2.5 text-sm bg-white outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/15 transition ${p.className || ""}`} />;
const Sel = (p) => <select {...p} className={`w-full border border-stone-300 rounded-xl px-3 py-2.5 text-sm bg-white outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/15 transition ${p.className || ""}`}>{p.children}</select>;
const Btn = ({ kind = "primary", className = "", ...p }) => {
  const k = {
    primary: "bg-gradient-to-b from-emerald-600 to-emerald-700 hover:from-emerald-700 hover:to-emerald-800 text-white shadow-[0_2px_8px_rgba(4,120,87,.25)]",
    danger: "bg-gradient-to-b from-rose-600 to-rose-700 hover:from-rose-700 hover:to-rose-800 text-white shadow-[0_2px_8px_rgba(190,18,60,.22)]",
    ghost: "bg-white hover:bg-stone-50 text-slate-700 border border-stone-300 shadow-sm",
    gold: "bg-gradient-to-b from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white shadow-[0_2px_8px_rgba(217,119,6,.25)]",
  }[kind];
  return <button {...p} className={`px-4 py-2.5 rounded-xl text-sm font-semibold transition press disabled:opacity-50 disabled:shadow-none ${k} ${className}`} />;
};
const Money = ({ v, dec, pos }) => (
  <span style={num} className={`font-bold ${v < 0 ? "text-rose-700" : pos ? "text-emerald-700" : "text-slate-900"}`}>{fmt(v, dec)}</span>
);
const Empty = ({ t }) => <div className="text-center text-slate-400 py-10 text-sm">{t}</div>;
const Back = ({ onClick, t }) => (
  <button onClick={onClick} className="flex items-center gap-1 text-sm text-emerald-700 font-semibold mb-3 hover:gap-2 transition-all">
    <ChevronLeft className="w-4 h-4 rotate-180" /> {t}
  </button>
);
const Pill = ({ tone = "slate", children }) => {
  const t = {
    slate: "bg-stone-100 text-slate-600", green: "bg-emerald-50 text-emerald-800",
    red: "bg-rose-50 text-rose-800", amber: "bg-amber-50 text-amber-800",
  }[tone];
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${t}`}>{children}</span>;
};

/* ══════════════════ ئەپی سەرەکی ══════════════════ */
export default function App() {
  const [session, setSession] = useState(undefined);
  const [data, setData] = useState(null);
  const [profile, setProfile] = useState(null);
  const [page, setPage] = useState("dash");
  const [viewAs, setViewAs] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [editTx, setEditTx] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [batches, setBatches] = useState([]);
  const [pendingBatch, setPendingBatch] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  useEffect(() => { if (session) loadAll(); }, [session]);
  useEffect(() => { if (profile?.role === "admin") { const id = setTimeout(() => autoBackup(), 4000); return () => clearTimeout(id); } }, [profile]);

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(null), 3000); };

  const reloadBatches = async () => {
    try {
      const { data: b } = await supabase.from("receipt_batches").select("*").order("created_at", { ascending: false }).limit(200);
      setBatches(b || []);
    } catch { setBatches([]); }
  };

  const loadAll = async () => {
    try {
      reloadBatches();
      const [c, u, l, t, a, ac] = await Promise.all([
        supabase.from("currencies").select("*").order("code"),
        supabase.from("app_users").select("*").order("created_at"),
        supabase.from("ledger").select("*").order("date"),
        supabase.from("txs").select("*").order("date"),
        supabase.from("audit").select("*").order("date", { ascending: false }).limit(300),
        supabase.from("account_ledger").select("*").order("created_at", { ascending: false }).limit(5000),
      ]);
      const d = {
        currencies: (c.data || []).map((r) => ({ id: r.id, code: r.code, name: r.name, symbol: r.symbol, dec: r.dec, external: !!r.external, buyRate: r.buy_rate == null ? null : +r.buy_rate, sellRate: r.sell_rate == null ? null : +r.sell_rate, rateUpdated: r.rate_updated })),
        users: (u.data || []).map((r) => ({ id: r.id, authId: r.auth_id, name: r.name, role: r.role, rate: +r.rate || 0, scope: Array.isArray(r.scope_curs) ? r.scope_curs : [], phone: r.phone, address: r.address, note: r.note, deleted: r.deleted })),
        ledger: (l.data || []).map((r) => ({ id: r.id, type: r.type, owner: r.owner, investorId: r.investor_id, curId: r.cur_id, amount: +r.amount, partnerId: r.partner_id, txId: r.tx_id, note: r.note, date: r.date })),
        txs: (t.data || []).map((r) => ({ id: r.id, code: r.code, type: r.type, direct: !!r.direct,
          pairId: r.pair_id, directRole: r.direct_role, ownMoney: !!r.own_money,
          buyRate: r.buy_rate == null ? null : +r.buy_rate, buyTotal: r.buy_total == null ? null : +r.buy_total, cpId: r.cp_id, cpName: r.cp_name, curId: r.cur_id, amount: +r.amount, rate: +r.rate, againstId: r.against_id, total: +r.total, partnerId: r.partner_id, status: r.status, paidAt: r.paid_at, profit: r.profit == null ? null : +r.profit, profitCurId: r.profit_cur_id, note: r.note, date: r.date, edited: r.edited, deleted: r.deleted })),
        audit: (a.data || []).map((r) => ({ id: r.id, date: r.date, action: r.action, detail: r.detail })),
        acct: (ac.data || []).map((r) => ({ id: r.id, userId: r.user_id, kind: r.kind, curId: r.cur_id,
          amount: +r.amount, type: r.type, refId: r.ref_id, note: r.note, date: r.created_at })),
      };
      setData(d);
      if (session) setProfile(d.users.find((x) => x.authId === session.user.id) || null);
    } catch (err) { console.error(err); flash("هەڵە لە بارکردنی داتا"); }
  };

  const A = (action, detail) => supabase.from("audit").insert({ id: uid(), date: now(), action, detail });
  const LR = (e) => ({ id: e.id, type: e.type, owner: e.owner || null, investor_id: e.investorId || null, cur_id: e.curId, amount: e.amount, partner_id: e.partnerId || null, tx_id: e.txId || null, note: e.note || null, date: e.date });
  const TR = (t) => ({ id: t.id, code: t.code || null, type: t.type, direct: !!t.direct,
    pair_id: t.pairId ?? null, direct_role: t.directRole ?? null, own_money: !!t.ownMoney,
    buy_rate: t.buyRate ?? null, buy_total: t.buyTotal ?? null, cp_id: t.cpId, cp_name: t.cpName, cur_id: t.curId, amount: t.amount, rate: t.rate, against_id: t.againstId, total: t.total, partner_id: t.partnerId, status: t.status, paid_at: t.paidAt, profit: t.profit, profit_cur_id: t.profitCurId, note: t.note || null, date: t.date, edited: !!t.edited, deleted: !!t.deleted });

  const lockRef = useRef(false);
  const run = async (fn) => {
    if (lockRef.current) return false;                  // قوفڵی هاوکات — خێراتر لە state
    lockRef.current = true; setBusy(true);
    try { await fn(); await loadAll(); return true; }
    catch (err) { console.error(err); flash("هەڵەیەک ڕوویدا — دووبارە هەوڵ بدەوە"); return false; }
    finally { lockRef.current = false; setBusy(false); }
  };

  /* ───────── حیسابەکان ───────── */
  const calc = useMemo(() => {
    if (!data) return null;
    const phys = {}, partner = {}, invCap = {}, selfCap = {}, invPaid = {}, expenses = {}, fees = {};
    for (const e of data.ledger) {
      phys[e.curId] = (phys[e.curId] || 0) + e.amount;
      if (e.partnerId) {
        partner[e.partnerId] = partner[e.partnerId] || {};
        partner[e.partnerId][e.curId] = (partner[e.partnerId][e.curId] || 0) + e.amount;
      }
      if (e.type === "deposit" || e.type === "withdraw") {
        if (e.owner === "investor") {
          invCap[e.investorId] = invCap[e.investorId] || {};
          invCap[e.investorId][e.curId] = (invCap[e.investorId][e.curId] || 0) + e.amount;
        } else selfCap[e.curId] = (selfCap[e.curId] || 0) + e.amount;
      }
      if (e.type === "investor_payout" && e.investorId) {
        invPaid[e.investorId] = invPaid[e.investorId] || {};
        invPaid[e.investorId][e.curId] = (invPaid[e.investorId][e.curId] || 0) + Math.abs(e.amount);
      }
      if (e.type === "expense") expenses[e.curId] = (expenses[e.curId] || 0) + Math.abs(e.amount);
      if (e.type === "partner_fee") fees[e.curId] = (fees[e.curId] || 0) + Math.abs(e.amount);
    }
    const invTotal = {};
    Object.values(invCap).forEach((m) => Object.entries(m).forEach(([c, v]) => (invTotal[c] = (invTotal[c] || 0) + v)));
    // ئەوەی لای خۆم مابێت (قاسەی گشتی — ئەوەی لای هاوبەشەکانە)
    const atMe = {};
    for (const c of data.currencies) {
      const atP = Object.values(partner).reduce((s, m) => s + (m[c.id] || 0), 0);
      atMe[c.id] = (phys[c.id] || 0) - atP;
    }
    // باڵانسی دووسەرەی کڕیارەکان (قەرز)
    const cust = {};
    for (const t of data.txs) {
      if (t.deleted || t.status !== "pending") continue;
      const key = t.cpId || "name:" + (t.cpName || "");
      cust[key] = cust[key] || { owe: {}, due: {}, n: 0 };
      cust[key].n++;
      // کڕین چاوەڕوان = من قەرزاری ئەوم | فرۆشتن چاوەڕوان = ئەو قەرزاری منە
      const side = t.type === "buy" ? "owe" : "due";
      cust[key][side][t.againstId] = (cust[key][side][t.againstId] || 0) + t.total;
    }
    // ── باڵانسی قاسە و قەرزی هەر حسابێک ──
    const acctCash = {}, acctDebt = {};
    for (const e of (data.acct || [])) {
      const box = e.kind === "debt" ? acctDebt : acctCash;
      box[e.userId] = box[e.userId] || {};
      box[e.userId][e.curId] = (box[e.userId][e.curId] || 0) + e.amount;
    }
    // قەرزی مامەڵە چاوەڕوانەکان دەخرێتە سەر دەفتەری قەرز
    for (const t of data.txs) {
      if (t.deleted || t.status !== "pending" || !t.cpId) continue;
      acctDebt[t.cpId] = acctDebt[t.cpId] || {};
      const sign = t.type === "buy" ? +1 : -1;   // کڕین = قەرزاری ئەوم | فرۆشتن = ئەو قەرزارە
      acctDebt[t.cpId][t.againstId] = (acctDebt[t.cpId][t.againstId] || 0) + sign * t.total;
    }
    return { phys, partner, atMe, invCap, invTotal, selfCap, invPaid, expenses, fees, cust, pending: cust, acctCash, acctDebt };
  }, [data]);

  const cur = (id) => data?.currencies.find((c) => c.id === id) || {};
  const usr = (id) => data?.users.find((u) => u.id === id) || {};

  /* خێری فرۆشتنەکان لە ماوەیەکدا، بۆ هەر دراوێک */
  // خێری هاوبەش (دابەش دەکرێت) — مامەڵەی ڕاستەوخۆ لێی دەرکراوە
  const profitIn = (from, to) => {
    const m = {};
    for (const t of data.txs) {
      if (t.deleted || t.profit == null || t.direct) continue;
      if (t.type !== "sell") continue;
      const d = dOnly(t.date);
      if (from && d < from) continue;
      if (to && d > to) continue;
      m[t.profitCurId] = (m[t.profitCurId] || 0) + t.profit;
    }
    return m;
  };
  // خێری تایبەتی خۆم (مامەڵەی ڕاستەوخۆ) — دابەش ناکرێت
  const ownProfitIn = (from, to) => {
    const m = {};
    for (const t of data.txs) {
      if (t.deleted || t.profit == null || !t.direct) continue;
      const d = dOnly(t.date);
      if (from && d < from) continue;
      if (to && d > to) continue;
      m[t.profitCurId] = (m[t.profitCurId] || 0) + t.profit;
    }
    return m;
  };
  const ownProfitAll = useMemo(() => (data ? ownProfitIn(null, null) : {}), [data]);
  const profitAll = useMemo(() => (data ? profitIn(null, null) : {}), [data]);

  /* بەشی وەبەرهێنەرێک لە خێری دراوێک */
  // ئایا ئەم وەبەرهێنەرە لەم دراوەدا شەریکە؟ (بەتاڵ = لە هەموویان)
  const inScope = (iid, curId) => {
    const sc = usr(iid).scope || [];
    return !sc.length || sc.includes(curId);
  };
  // کۆی سەرمایەی ئەوانەی لەم دراوەدا شەریکن
  const scopedCap = (curId) => {
    let s2 = calc.selfCap[curId] || 0;
    data.users.forEach((u) => {
      if (u.role === "investor" && !u.deleted && inScope(u.id, curId))
        s2 += (calc.invCap[u.id] || {})[curId] || 0;
    });
    return s2;
  };
  const invShare = (iid, curId, totalProfit) => {
    if (!inScope(iid, curId)) return 0;
    const totalCap = scopedCap(curId);
    const cap = (calc.invCap[iid] || {})[curId] || 0;
    if (totalCap <= 0 || cap <= 0 || !totalProfit) return 0;
    return totalProfit * (cap / totalCap) * ((usr(iid).rate || 0) / 100);
  };
  // دابەشکردن تەنها لەسەر خێری هاوبەش دەکرێت (نەک ڕاستەوخۆ)
  const investorsProfitIn = (pm) => {
    const out = {};
    const invs = data.users.filter((u) => u.role === "investor" && !u.deleted);
    Object.entries(pm).forEach(([c, tot]) => {
      out[c] = invs.reduce((s, u) => s + invShare(u.id, c, tot), 0);
    });
    return out;
  };

  /* قاسەی خۆم = سەرمایەی خۆم + خێری خۆم − خەرجی − عمولەی هاوبەشان */
  const mySafe = useMemo(() => {
    if (!data || !calc) return {};
    const invP = investorsProfitIn(profitAll);
    const out = {};
    for (const c of data.currencies) {
      const shared = (profitAll[c.id] || 0) - (invP[c.id] || 0);   // بەشی من لە خێری هاوبەش
      const own = ownProfitAll[c.id] || 0;                          // خێری ڕاستەوخۆ — ١٠٠٪ هی من
      out[c.id] = (calc.selfCap[c.id] || 0) + shared + own - (calc.expenses[c.id] || 0) - (calc.fees[c.id] || 0);
    }
    return out;
  }, [data, calc, profitAll, ownProfitAll]);

  /* خێری نەدراوی وەبەرهێنەرێک */
  const invUnpaid = (iid, curId) => invShare(iid, curId, profitAll[curId] || 0) - ((calc.invPaid[iid] || {})[curId] || 0);

  /* گۆڕینی هەر دراوێک بۆ دۆلار بەپێی نرخی ئەمڕۆ (بۆ کۆکردنەوەی گشتی) */
  const toUsd = (amount, curId) => {
    if (!amount) return 0;
    if (curId === "usd") return amount;
    const c = cur(curId);
    const mid = c.buyRate && c.sellRate ? (c.buyRate + c.sellRate) / 2 : (c.buyRate || c.sellRate);
    return mid ? amount / mid : 0;
  };
  const sumUsd = (map) => (data?.currencies || []).reduce((s, c) => s + toUsd(map?.[c.id] || 0, c.id), 0);
  const ratesReady = !!data && data.currencies.every((c) => c.id === "usd" || c.buyRate || c.sellRate);

  /* بەشی خاوەندارێتی — هەر دراوێک بەپێی سەرمایە دابەش دەبێت */
  const owners = useMemo(() => {
    if (!data || !calc) return { list: [], total: 0 };
    const invs = data.users.filter((u) => u.role === "investor" && !u.deleted);
    const mine = sumUsd(mySafe);
    const list = [{ id: "me", name: "خۆم", equity: mine, isMe: true }];
    invs.forEach((u) => {
      const cap = sumUsd(calc.invCap[u.id] || {});
      let unpaid = 0;
      data.currencies.forEach((c) => { unpaid += toUsd(invUnpaid(u.id, c.id), c.id); });
      const eq = cap + unpaid;
      if (eq !== 0) list.push({ id: u.id, name: u.name, equity: eq, cap, unpaid });
    });
    const total = list.reduce((s, x) => s + x.equity, 0);
    list.forEach((x) => (x.share = total > 0 ? x.equity / total : 0));
    return { list, total };
  }, [data, calc, mySafe]);

  /* مامناوەندی نرخی کڕین (بۆ حیسابی خێر لە کاتی فرۆشتن) */
  // مامناوەندی کێشدار — مامەڵەی ڕاستەوخۆ ناچێتە ناوی (چوونکە لە قاسەدا نامێنێتەوە)
  const avgRate = (curId, againstId) => {
    let a = 0, v = 0;
    for (const t of data.txs)
      if (!t.deleted && !t.direct && t.type === "buy" && t.curId === curId && t.againstId === againstId) { a += t.amount; v += t.amount * t.rate; }
    return a > 0 ? v / a : null;
  };

  /* نرخی ئۆتۆماتیکی لە نرخی ڕۆژانەوە */
  const autoRate = (type, curId, againstId) => {
    const c = cur(curId), a = cur(againstId);
    const side = (x) => (type === "buy" ? x.buyRate : x.sellRate);
    const pc = c.id === "usd" ? 1 : side(c);
    const pa = a.id === "usd" ? 1 : side(a);
    if (!pc || !pa) return null;
    return pa / pc;
  };

  /* ───────── کردارەکان ───────── */
  const addDeposit = (f) => run(async () => {
    if (!(Math.abs(+f.amount) > 0)) { flash("بڕ پێویستە"); return; }
    const amount = Math.round(f.dir === "in" ? Math.abs(+f.amount) : -Math.abs(+f.amount));
    const e = { id: uid(), type: f.dir === "in" ? "deposit" : "withdraw", owner: f.owner === "self" ? "self" : "investor", investorId: f.owner === "self" ? null : f.owner, curId: f.curId, amount, partnerId: null, txId: null, note: f.note, date: now() };
    const r = await supabase.from("ledger").insert(LR(e)); if (r.error) throw r.error;
    await A(f.dir === "in" ? "پارە داخڵکردن" : "پارە دەرهێنان", `${fmt(Math.abs(amount))} ${cur(f.curId).code} — ${f.owner === "self" ? "هی خۆم" : usr(f.owner).name}`);
    flash("تۆمار کرا ✓");
  });

  /* دروستکردنی تۆمارەکانی دەفتەر بۆ مامەڵەیەک */
  const buildEntries = (t) => {
    const es = [];
    // ── مامەڵەی ڕاستەوخۆ: کڕین و فرۆشتن پێکەوە، تەنها خێرەکەی دەمێنێتەوە ──
    if (t.direct) {
      // دراوەکە دێت و دەڕوات (لە قاسەدا نامێنێتەوە)
      es.push({ id: uid(), type: "buy", curId: t.curId, amount: +t.amount, partnerId: null, txId: t.id, date: t.date });
      es.push({ id: uid(), type: "sell", curId: t.curId, amount: -t.amount, partnerId: null, txId: t.id, date: t.date });
      // پارەی کڕین دەڕوات (گەر خۆم دابێتم)
      if (t.status === "completed" && t.buyTotal) es.push({ id: uid(), type: "buy", curId: t.againstId, amount: -t.buyTotal, partnerId: null, txId: t.id, date: t.date });
      // پارەی فرۆشتن دێت (گەر وەرمگرتبێت)
      if (t.status === "completed" && t.total) es.push({ id: uid(), type: "sell", curId: t.againstId, amount: +t.total, partnerId: null, txId: t.id, date: t.date });
      return es;
    }
    // مامەڵەی ئاسایی
    const feeRate = (!t.direct && t.partnerId) ? (usr(t.partnerId).rate || 0) : 0;
    if (t.type === "buy") {
      // دراوی کڕدراو دێتە ژوورەوە (لای خۆم یان لای هاوبەش)
      es.push({ id: uid(), type: "buy", curId: t.curId, amount: +t.amount, partnerId: t.partnerId || null, txId: t.id, date: t.date });
      // عمولەی هاوبەش دەستبەجێ کەم دەکرێتەوە
      if (feeRate > 0) es.push({ id: uid(), type: "partner_fee", curId: t.curId, amount: -Math.round(t.amount * feeRate / 100), partnerId: t.partnerId, txId: t.id, note: `عمولەی ${feeRate}٪`, date: t.date });
      // بەرامبەرەکەی لە قاسەی گشتی دەردەچێت (گەر خۆم پارەم دابێت)
      if (t.status === "completed") es.push({ id: uid(), type: "buy", curId: t.againstId, amount: -t.total, partnerId: null, txId: t.id, date: t.date });
    } else {
      es.push({ id: uid(), type: "sell", curId: t.curId, amount: -t.amount, partnerId: t.partnerId || null, txId: t.id, date: t.date });
      if (t.status === "completed") es.push({ id: uid(), type: "sell", curId: t.againstId, amount: +t.total, partnerId: null, txId: t.id, date: t.date });
    }
    return es;
  };

  const saveTx = async (f, existing) => {
    const amount = Math.round(+f.amount), rate = +f.rate, total = Math.round(amount * rate);
    if (!(amount > 0)) { flash("بڕ دەبێت لە سفر گەورەتر بێت"); return false; }
    if (f.curId === f.againstId) { flash("ناکرێت دراوەکە لەگەڵ خۆی مامەڵەی پێبکرێت"); return false; }

    // ── مامەڵەی ڕاستەوخۆ: کڕیار + فرۆشیار ──
    if (f.direct) {
      if (!(+f.buyQuote > 0)) { flash("ڕەیتی کڕین پێویستە"); return false; }
      if (!(+f.sellQuote > 0)) { flash("ڕەیتی فرۆشتن پێویستە"); return false; }
      if (!f.fromId && !f.fromName) { flash("لە کێ دەیکڕیت؟"); return false; }
      if (!f.toId && !f.toName) { flash("بە کێ دەیفرۆشیت؟"); return false; }

      return await run(async () => {
        const bq = Math.round((+f.buyQuote) * 1000) / 1000;
        const sq = Math.round((+f.sellQuote) * 1000) / 1000;
        const buyTotal = Math.round(amount / bq);
        const sellTotal = Math.round(amount / sq);
        const profit = sellTotal - buyTotal;
        const pair = uid();
        const base = Math.max(1000, ...data.txs.map((x) => x.code || 0));

        // مامەڵەی کڕین
        const t1 = {
          id: uid(), code: base + 1, type: "buy", direct: true, pairId: pair, directRole: "buy",
          ownMoney: true, cpId: f.fromId || null, cpName: f.fromId ? null : f.fromName,
          curId: f.curId, amount, rate: 1 / bq, againstId: f.againstId, total: buyTotal,
          partnerId: null, status: f.buyStatus || "completed", paidAt: null,
          profit: null, profitCurId: null, note: f.note || "", date: now(), edited: false,
        };
        // مامەڵەی فرۆشتن
        const t2 = {
          id: uid(), code: base + 2, type: "sell", direct: true, pairId: pair, directRole: "sell",
          ownMoney: true, cpId: f.toId || null, cpName: f.toId ? null : f.toName,
          curId: f.curId, amount, rate: 1 / sq, againstId: f.againstId, total: sellTotal,
          partnerId: null, status: f.sellStatus || "completed", paidAt: null,
          profit, profitCurId: f.againstId, note: f.note || "", date: now(), edited: false,
        };

        let r = await supabase.from("txs").insert([TR(t1), TR(t2)]); if (r.error) throw r.error;

        // تۆمارەکانی دەفتەر — بە پارەی خۆم، خێری ١٠٠٪ هی خۆم
        const es = [];
        es.push({ id: uid(), type: "buy", curId: t1.curId, amount: +amount, partnerId: null, txId: t1.id, date: t1.date });
        if (t1.status === "completed") es.push({ id: uid(), type: "direct_buy", curId: t1.againstId, amount: -buyTotal, partnerId: null, txId: t1.id, note: "بە پارەی خۆم", date: t1.date });
        es.push({ id: uid(), type: "sell", curId: t2.curId, amount: -amount, partnerId: null, txId: t2.id, date: t2.date });
        if (t2.status === "completed") es.push({ id: uid(), type: "direct_sell", curId: t2.againstId, amount: +sellTotal, partnerId: null, txId: t2.id, note: "بۆ پارەی خۆم", date: t2.date });
        r = await supabase.from("ledger").insert(es.map(LR)); if (r.error) throw r.error;

        await A("مامەڵەی ڕاستەوخۆ", `#${t1.code}/${t2.code} — ${fmt(amount)} ${cur(f.curId).code} · خێر ${fmt(profit)} ${cur(f.againstId).code}`);
        setEditTx(null);
        flash(`مامەڵە تۆمار کرا ✓ — خێر ${fmt(profit)} ${cur(f.againstId).code}`);
      });
    }

    // ── مامەڵەی ئاسایی ──
    if (!(rate > 0)) { flash("نرخ دەبێت لە سفر گەورەتر بێت"); return false; }
    if (!f.cpId && !f.cpName) { flash("لایەنی بەرامبەر دیاری بکە"); return false; }
    if (!(total > 0)) { flash("کۆی گشتی ناتوانێت سفر بێت"); return false; }
    // دراوی دەرەوە: دەبێت لای تەرەفێک بێت
    if (cur(f.curId).external && !f.partnerId) { flash(`${cur(f.curId).name} دەبێت لای تەرەفێک دابنرێت`); return false; }

    return await run(async () => {
      let profit = null, profitCurId = null;
      if (f.type === "sell") {
        const av = avgRate(f.curId, f.againstId);
        if (av !== null) { profit = Math.round(total - av * amount); profitCurId = f.againstId; }
      }
      const code = existing ? existing.code : Math.max(1000, ...data.txs.map((x) => x.code || 0)) + 1;
      const t = { id: existing ? existing.id : uid(), code, type: f.type, cpId: f.cpId || null,
        cpName: f.cpId ? null : f.cpName, curId: f.curId, amount, rate, againstId: f.againstId, total,
        partnerId: f.partnerId || null, direct: false, status: f.status || "completed",
        paidAt: existing ? existing.paidAt : null, profit, profitCurId, note: f.note || "",
        date: existing ? existing.date : now(), edited: !!existing };
      if (existing) {
        let r = await supabase.from("ledger").delete().eq("tx_id", t.id); if (r.error) throw r.error;
        r = await supabase.from("txs").update(TR(t)).eq("id", t.id); if (r.error) throw r.error;
      } else {
        let ok = false;
        for (let k = 0; k < 8 && !ok; k++) {
          const r = await supabase.from("txs").insert(TR({ ...t, code: t.code + k }));
          if (!r.error) { t.code = t.code + k; ok = true; }
          else if (!String(r.error.message).match(/duplicate|unique/i)) throw r.error;
        }
        if (!ok) throw new Error("نەتوانرا کۆدێکی بەردەست بدۆزرێتەوە");
      }
      const r2 = await supabase.from("ledger").insert(buildEntries(t).map(LR)); if (r2.error) throw r2.error;
      if (f.batchId) {
        await supabase.from("receipt_batches").update({
          status: "linked", tx_id: t.id, partner_id: t.partnerId || null, linked_at: now(),
        }).eq("id", f.batchId);
        setPendingBatch(null);
      }
      if (existing) await supabase.from("receipt_batches").update({ partner_id: t.partnerId || null }).eq("tx_id", t.id);
      reloadBatches();
      await A(existing ? "ئیدیتی مامەڵە" : (t.type === "buy" ? "کڕین" : "فرۆشتن"), `#${t.code} — ${fmt(amount)} ${cur(f.curId).code} — ${t.cpId ? usr(t.cpId).name : t.cpName}`);
      setEditTx(null);
      flash(existing ? "ئیدیت کرا ✓" : "مامەڵە تۆمار کرا ✓");
    });
  };

  const delTx = (t) => {
    if (!window.confirm("دڵنیایت لە سڕینەوەی ئەم مامەڵەیە؟ باڵانسەکان ئۆتۆماتیکی ڕاست دەبنەوە.")) return;
    run(async () => {
      let r = await supabase.from("ledger").delete().eq("tx_id", t.id); if (r.error) throw r.error;
      r = await supabase.from("txs").update({ deleted: true }).eq("id", t.id); if (r.error) throw r.error;
      // کۆمەڵەی فیشی بەستراو ئازاد بکەرەوە
      await supabase.from("receipt_batches").update({ status: "new", tx_id: null, partner_id: null, linked_at: null }).eq("tx_id", t.id);
      reloadBatches();
      await A("سڕینەوەی مامەڵە", `#${t.code || "—"} — ${fmt(t.amount)} ${cur(t.curId).code}`);
      flash("سڕایەوە");
    });
  };

  const settle = (t, byOffice) => run(async () => {
    const isBuy = t.type === "buy";
    const e = {
      id: uid(), type: isBuy ? "office_payment" : "customer_payment",
      curId: t.againstId, amount: isBuy ? -t.total : +t.total, txId: t.id,
      note: isBuy ? (byOffice ? "پارەدانی نووسینگە" : "پارە درا") : "پارە وەرگیرا", date: now(),
    };
    let r = await supabase.from("ledger").insert(LR(e)); if (r.error) throw r.error;
    r = await supabase.from("txs").update({ status: "completed", paid_at: now() }).eq("id", t.id); if (r.error) throw r.error;
    await A(isBuy ? (byOffice ? "نووسینگە پارەی دا" : "پارە درا") : "پارە وەرگیرا", `#${t.code || "—"} — ${fmt(t.total)} ${cur(t.againstId).code}`);
    flash(isBuy ? "پارەدان تۆمار کرا ✓" : "وەرگرتن تۆمار کرا ✓");
  });
  const officePay = (t) => settle(t, true);

  const addExpense = (f) => {
    const amt = Math.round(Math.abs(+f.amount));
    if (!(amt > 0)) return flash("بڕی خەرجی پێویستە");
    if (f.category === "خێری وەبەرهێنەر" && !f.investorId) return flash("وەبەرهێنەر هەڵبژێرە");
    run(async () => {
      const isPayout = f.category === "خێری وەبەرهێنەر";
      const e = {
        id: uid(), type: isPayout ? "investor_payout" : "expense",
        owner: null, investorId: isPayout ? f.investorId : null,
        curId: f.curId, amount: -amt, partnerId: null, txId: null,
        note: `${f.category}${f.note ? " — " + f.note : ""}`, date: now(),
      };
      const r = await supabase.from("ledger").insert(LR(e)); if (r.error) throw r.error;
      await A(isPayout ? "پارەدانی خێری وەبەرهێنەر" : "خەرجی", `${fmt(amt)} ${cur(f.curId).code} — ${isPayout ? usr(f.investorId).name : f.category}`);
      flash("تۆمار کرا ✓");
    });
  };

  const transfer = (f) => {
    const amt = Math.round(Math.abs(+f.amount));
    if (!amt || !f.partnerId) return flash("بڕ و هاوبەش دیاری بکە");
    run(async () => {
      const base = { curId: f.curId, txId: null, date: now() };
      const es = f.dir === "to"
        ? [{ ...base, id: uid(), type: "transfer", amount: -amt, partnerId: null },
           { ...base, id: uid(), type: "transfer", amount: +amt, partnerId: f.partnerId }]
        : [{ ...base, id: uid(), type: "transfer", amount: +amt, partnerId: null },
           { ...base, id: uid(), type: "transfer", amount: -amt, partnerId: f.partnerId }];
      // عمولە تەنها لە کاتی تێکردندا
      const fr = usr(f.partnerId).rate || 0;
      if (f.dir === "to" && fr > 0) es.push({ ...base, id: uid(), type: "partner_fee", amount: -Math.round(amt * fr / 100), partnerId: f.partnerId, note: `عمولەی ${fr}٪` });
      const r = await supabase.from("ledger").insert(es.map(LR)); if (r.error) throw r.error;
      await A("گواستنەوە", `${fmt(amt)} ${cur(f.curId).code} ${f.dir === "to" ? "بۆ لای" : "لە لای"} ${usr(f.partnerId).name}`);
      flash("گواستنەوە تۆمار کرا ✓");
    });
  };

  const saveRates = (rows) => run(async () => {
    for (const r of rows) {
      const r3 = (v) => (v === "" || v == null ? null : Math.round(+v * 1000) / 1000);
      const e = await supabase.from("currencies").update({ buy_rate: r3(r.buyRate), sell_rate: r3(r.sellRate), rate_updated: now() }).eq("id", r.id);
      if (e.error) throw e.error;
    }
    // مێژووی نرخ تۆمار بکە
    const hist = rows.filter((r) => r.buyRate !== "" || r.sellRate !== "").map((r) => ({
      id: uid(), cur_id: r.id, buy_rate: r.buyRate === "" ? null : +r.buyRate,
      sell_rate: r.sellRate === "" ? null : +r.sellRate, changed_by: profile?.id || null,
    }));
    if (hist.length) await supabase.from("rate_history").insert(hist).then(() => {}).catch(() => {});
    await A("گۆڕینی نرخی ڕۆژ", rows.map((r) => `${cur(r.id).code}: ${r.buyRate}/${r.sellRate}`).join("، "));
    flash("نرخەکان پاشەکەوت کران ✓");
  });

  const addCurrency = (nc) => run(async () => {
    const r = await supabase.from("currencies").insert({ id: nc.code.toLowerCase(), code: nc.code, name: nc.name, symbol: nc.symbol, dec: +nc.dec || 2, external: !!nc.external });
    if (r.error) throw r.error;
    await A("زیادکردنی دراو", nc.code);
    flash("دراو زیاد کرا ✓");
  });

  const createUser = (f) => run(async () => {
    if (!f.name || !f.phone || !f.password || f.password.length < 6) { flash("ناو، ژمارە، و وشەی نهێنی (٦ پیت) پێویستن"); return; }
    const fakeEmail = f.phone.replace(/\s/g, "") + "@sarraf.local";
    const temp = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: sd, error: se } = await temp.auth.signUp({ email: fakeEmail, password: f.password });
    if (se && !String(se.message).includes("already registered")) throw se;
    const r = await supabase.from("app_users").insert({ id: uid(), auth_id: sd?.user?.id || null, name: f.name, role: f.role, rate: +f.rate || 0, scope_curs: f.scope || [], phone: f.phone, address: f.address || null, note: f.note || null });
    if (r.error) throw r.error;
    await A("درووستکردنی ئەکاونت", `${f.name} (${ROLE_KU[f.role]}) — ${f.phone}`);
    flash("ئەکاونت درووست کرا ✓");
  });

  const deleteUser = (u) => {
    if (!window.confirm(`سڕینەوەی ئەکاونتی «${u.name}»؟ مێژووی مامەڵەکانی دەمێنێتەوە.`)) return;
    run(async () => {
      const r = await supabase.from("app_users").update({ deleted: true }).eq("id", u.id); if (r.error) throw r.error;
      await A("سڕینەوەی ئەکاونت", u.name);
      flash("سڕایەوە");
    });
  };
  const setUserRate = (u, rate) => run(async () => {
    const r = await supabase.from("app_users").update({ rate: +rate || 0 }).eq("id", u.id); if (r.error) throw r.error;
    await A("گۆڕینی ڕێژە", `${u.name} → ${rate}%`);
  });

  /* ── پارە دانان/دەرهێنان لە حسابی هەر کەسێک ── */
  //  دوو لای هەیە: قاسەی گشتی + قاسەی خودی ئەو کەسە
  const accountMove = (f) => run(async () => {
    const amt = Math.round(Math.abs(+f.amount));
    if (!(amt > 0)) { flash("بڕ پێویستە"); return; }
    if (!f.userId) { flash("کەسەکە دیاری بکە"); return; }
    const u = usr(f.userId);
    const sign = f.dir === "in" ? 1 : -1;      // in = پارە دەخەمە سەر حسابی

    // ١) قاسەی خودی ئەو کەسە
    const ae = {
      id: uid(), user_id: f.userId, kind: "cash", cur_id: f.curId, amount: sign * amt,
      type: f.dir === "in" ? "deposit" : "withdraw", note: f.note || null,
      created_by: profile?.id || null,
    };
    let r = await supabase.from("account_ledger").insert(ae); if (r.error) throw r.error;

    // ٢) قاسەی گشتی — پارەکە دێت یان دەڕوات
    const ge = { id: uid(), type: sign > 0 ? "acc_in" : "acc_out", curId: f.curId,
      amount: sign * amt, note: `${sign > 0 ? "دانان لە" : "دەرهێنان بۆ"} ${u.name}`, date: now() };
    r = await supabase.from("ledger").insert(LR(ge)); if (r.error) throw r.error;

    // ٣) وەبەرهێنەر: سەرمایەشی نوێ دەبێتەوە
    if (u.role === "investor") {
      const ie = { id: uid(), type: sign > 0 ? "deposit" : "withdraw", owner: "investor",
        investorId: f.userId, curId: f.curId, amount: sign * amt, note: f.note, date: now() };
      r = await supabase.from("ledger").insert(LR(ie)); if (r.error) throw r.error;
    }

    await A(f.dir === "in" ? "دانانی پارە" : "دەرهێنانی پارە", `${fmt(amt)} ${cur(f.curId).code} — ${u.name}`);
    flash("تۆمار کرا ✓");
  });

  /* ── گواستنەوەی پارە: حساب بۆ حساب ── */
  //  لای یەکێک کەم، لای ئەوی تر زیاد — قاسەی گشتی نەگۆڕ دەمێنێتەوە
  const accountTransfer = (f) => run(async () => {
    const amt = Math.round(Math.abs(+f.amount));
    if (!(amt > 0)) { flash("بڕ پێویستە"); return; }
    if (!f.fromId || !f.toId) { flash("هەردوو لایەن دیاری بکە"); return; }
    if (f.fromId === f.toId) { flash("ناکرێت بۆ هەمان کەس بگوازرێتەوە"); return; }
    const a = usr(f.fromId), b = usr(f.toId);
    const ref = uid();

    const rows = [
      { id: uid(), user_id: f.fromId, kind: "cash", cur_id: f.curId, amount: -amt, type: "transfer_out",
        ref_id: ref, note: `بۆ ${b.name}${f.note ? " — " + f.note : ""}`, created_by: profile?.id || null },
      { id: uid(), user_id: f.toId, kind: "cash", cur_id: f.curId, amount: +amt, type: "transfer_in",
        ref_id: ref, note: `لە ${a.name}${f.note ? " — " + f.note : ""}`, created_by: profile?.id || null },
    ];
    let r = await supabase.from("account_ledger").insert(rows); if (r.error) throw r.error;

    // تۆماری مێژوو
    r = await supabase.from("account_transfers").insert({
      id: ref, from_id: f.fromId, from_name: a.name, to_id: f.toId, to_name: b.name,
      cur_id: f.curId, amount: amt, note: f.note || null, created_by: profile?.id || null,
    });
    if (r.error) throw r.error;

    // وەبەرهێنەر: سەرمایە نوێ بکەرەوە
    const inv = [];
    if (a.role === "investor") inv.push({ id: uid(), type: "withdraw", owner: "investor", investorId: f.fromId, curId: f.curId, amount: -amt, note: `بۆ ${b.name}`, date: now() });
    if (b.role === "investor") inv.push({ id: uid(), type: "deposit", owner: "investor", investorId: f.toId, curId: f.curId, amount: +amt, note: `لە ${a.name}`, date: now() });
    if (inv.length) { r = await supabase.from("ledger").insert(inv.map(LR)); if (r.error) throw r.error; }

    await A("گواستنەوەی حساب", `${fmt(amt)} ${cur(f.curId).code} — لە ${a.name} بۆ ${b.name}`);
    flash("گواستنەوە تۆمار کرا ✓");
  });

  /* ── بەستنی ڕۆژ ── */
  /* ── بەستنی ڕۆژ ── */
  const closeDay = (lines, note, adjust) => run(async () => {
    const totalDiff = lines.reduce((s2, l) => s2 + (l.diff || 0), 0);
    const r = await supabase.from("day_closes").insert({
      id: uid(), close_date: new Date().toISOString().slice(0, 10),
      lines, total_diff: totalDiff, has_diff: lines.some((l) => l.diff), note: note || null,
      closed_by: profile?.id || null,
    });
    if (r.error) throw r.error;
    // ڕاستکردنەوەی قاسە بەپێی ژماردنی ڕاستەقینە
    if (adjust) {
      const es = lines.filter((l) => l.diff).map((l) => ({
        id: uid(), type: "adjustment", curId: l.cur, amount: Math.round(l.diff),
        note: `ڕاستکردنەوەی بەستنی ڕۆژ${note ? " — " + note : ""}`, date: now(),
      }));
      if (es.length) { const e2 = await supabase.from("ledger").insert(es.map(LR)); if (e2.error) throw e2.error; }
    }
    await A("بەستنی ڕۆژ", lines.map((l) => `${cur(l.cur).code}: ${l.diff >= 0 ? "+" : ""}${fmt(l.diff, 0)}`).join("، ") || "بێ جیاوازی");
    flash(totalDiff === 0 ? "ڕۆژ بەسترا — هیچ جیاوازییەک نییە ✓" : "ڕۆژ بەسترا ✓");
  });

  /* ── هەڵوەشاندنەوەی پارەدان ── */
  const unsettle = (t) => {
    if (!window.confirm("پارەدانەکە هەڵبوەشێنرێتەوە؟ مامەڵەکە دەگەڕێتەوە بۆ «چاوەڕوان».")) return;
    run(async () => {
      let r = await supabase.from("ledger").delete().eq("tx_id", t.id).in("type", ["office_payment", "customer_payment"]);
      if (r.error) throw r.error;
      r = await supabase.from("txs").update({ status: "pending", paid_at: null }).eq("id", t.id);
      if (r.error) throw r.error;
      await A("هەڵوەشاندنەوەی پارەدان", `#${t.code || "—"} — ${fmt(t.total)} ${cur(t.againstId).code}`);
      flash("هەڵوەشێندرایەوە ✓");
    });
  };

  /* ── باکئەپ ── */
  const snapshot = async (kind = "auto") => {
    const [c, u, l, t, a, rc] = await Promise.all([
      supabase.from("currencies").select("*"),
      supabase.from("app_users").select("*"),
      supabase.from("ledger").select("*"),
      supabase.from("txs").select("*"),
      supabase.from("audit").select("*"),
      supabase.from("receipts").select("*"),
    ]);
    const payload = {
      version: 2, takenAt: now(), kind,
      currencies: c.data || [], app_users: u.data || [], ledger: l.data || [],
      txs: t.data || [], audit: a.data || [], receipts: rc.data || [],
    };
    const counts = {
      currencies: payload.currencies.length, users: payload.app_users.length,
      ledger: payload.ledger.length, txs: payload.txs.length,
      audit: payload.audit.length, receipts: payload.receipts.length,
    };
    return { payload, counts };
  };

  const saveBackup = (kind = "manual") => run(async () => {
    const { payload, counts } = await snapshot(kind);
    const r = await supabase.from("backups").insert({ id: uid(), kind, counts, data: payload });
    if (r.error) throw r.error;
    // تەنها ٤٠ی دوایی بهێڵەرەوە
    const old = await supabase.from("backups").select("id").order("created_at", { ascending: false }).range(40, 999);
    if (old.data?.length) await supabase.from("backups").delete().in("id", old.data.map((x) => x.id));
    if (kind === "manual") { await A("باکئەپ", `${counts.txs} مامەڵە · ${counts.ledger} تۆماری دەفتەر`); flash("باکئەپ درووست کرا ✓"); }
  });

  const downloadBackup = async () => {
    const { payload } = await snapshot("download");
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `backup_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    a.click();
    flash("فایلی باکئەپ دابەزێندرا ✓");
  };

  // باکئەپی ئۆتۆماتیکی: ئەگەر دوا باکئەپ کۆنتر بێت لە ٦ کاتژمێر
  const autoBackup = async () => {
    try {
      const { data: last } = await supabase.from("backups").select("created_at").order("created_at", { ascending: false }).limit(1);
      const t = last?.[0]?.created_at ? new Date(last[0].created_at).getTime() : 0;
      if (Date.now() - t > 6 * 3600 * 1000) {
        const { payload, counts } = await snapshot("auto");
        await supabase.from("backups").insert({ id: uid(), kind: "auto", counts, data: payload });
      }
    } catch { /* خشتەکە هێشتا درووست نەکراوە */ }
  };

  const signOut = () => supabase.auth.signOut();

  /* ───────── ڕەندەر ───────── */
  if (session === undefined) return <Splash t="بارکردنی سیستەم..." />;
  if (!session) return <Login />;
  if (!data || !calc) return <Splash t="بارکردنی داتا..." />;
  if (!profile) return <Splash t="ئەکاونتەکەت بە سیستەمەکە نەبەستراوە — پەیوەندی بە ئەدمینەوە بکە." signOut={signOut} />;

  const isAdmin = profile.role === "admin";
  const va = viewAs ? usr(viewAs) : null;
  const portalUser = !isAdmin ? profile : va;

  const NAV = [
    ["dash", "داشبۆرد", LayoutDashboard],
    ["newtx", "مامەڵەی نوێ", ArrowLeftRight],
    ["txs", "مامەڵەکان", ListOrdered],
    ["receipts", "پشکنینی فیش", ScanLine],
    ["people", "بەکارهێنەران", Users],
    ["report", "ڕاپۆرت", PieChart],
    ["audit", "تۆمار", History],
    ["close", "بەستنی ڕۆژ", ClipboardCheck],
    ["backup", "پاراستنی داتا", Database],
  ];


  const shared = { data, calc, cur, usr, mySafe, profitAll, profitIn, ownProfitIn, ownProfitAll,
    inScope, scopedCap, investorsProfitIn, invShare, invUnpaid, autoRate, avgRate,
    toUsd, sumUsd, ratesReady, owners };

  return (
    <div dir="rtl" className="min-h-screen bg-[#F5F5F3] text-slate-800" style={{ fontFamily: "'Segoe UI', Tahoma, sans-serif" }}>
      <style>{`
        @keyframes fadeUp { from { opacity:0; transform: translateY(8px) } to { opacity:1; transform:none } }
        @keyframes popIn { 0% { transform: scale(.7); opacity:0 } 60% { transform: scale(1.08) } 100% { transform: scale(1); opacity:1 } }
        @keyframes slideDown { from { opacity:0; transform: translateY(-14px) } to { opacity:1; transform:none } }
        @keyframes shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
        .fade-up { animation: fadeUp .32s cubic-bezier(.2,.8,.2,1) both }
        .cur-pop { animation: popIn .4s cubic-bezier(.2,1.2,.3,1) both }
        .toast-in { animation: slideDown .3s cubic-bezier(.2,.9,.2,1) both }
        .press:active { transform: scale(.97) }
        .lift { transition: transform .18s ease, box-shadow .18s ease }
        .lift:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(15,23,42,.08) }
        ::-webkit-scrollbar { width: 8px; height: 8px }
        ::-webkit-scrollbar-thumb { background: #d6d3d1; border-radius: 8px }
      `}</style>
      {msg && (
        <div className="fixed top-0 right-0 left-0 z-[60] flex justify-center px-4" style={{ paddingTop: "calc(env(safe-area-inset-top) + 12px)" }}>
          <div className={`toast-in flex items-center gap-2.5 px-5 py-3.5 rounded-2xl shadow-xl text-white font-bold text-sm max-w-md w-full justify-center ${/✓|کرا|تۆمار|نێردرا|وەرگ/.test(msg) ? "bg-emerald-600" : "bg-slate-900"}`}>
            {/✓|کرا|تۆمار|نێردرا|وەرگ/.test(msg) ? <CheckCircle2 className="w-5 h-5 shrink-0" /> : <AlertTriangle className="w-5 h-5 shrink-0" />}
            <span>{msg.replace(" ✓", "")}</span>
          </div>
        </div>
      )}
      {busy && <div className="fixed top-0 right-0 left-0 h-0.5 bg-emerald-600 animate-pulse z-50" />}

      <header className="bg-slate-900 text-white sticky top-0 z-40" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <div className="px-3 md:px-4 py-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <Vault className="w-6 h-6 text-amber-400 shrink-0" />
            <div className="min-w-0">
              <div className="font-bold leading-tight text-sm md:text-base truncate">سیستەمی دراو</div>
              <div className="text-[11px] text-slate-400 truncate">{profile.name} — {ROLE_KU[profile.role]}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isAdmin && va && (
              <button onClick={() => setViewAs(null)} className="flex items-center gap-1 text-xs bg-amber-600 hover:bg-amber-700 px-2.5 py-1.5 rounded-lg">
                <LogOut className="w-3.5 h-3.5" /> گەڕانەوە
              </button>
            )}
            <button onClick={signOut} className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {portalUser ? (
        <main className="p-3 md:p-5 pb-10 max-w-3xl mx-auto"><Portal user={portalUser} {...shared} officePay={officePay} settle={settle} flash={flash} reloadBatches={reloadBatches} accountMove={accountMove} accountTransfer={accountTransfer} /></main>
      ) : (
        <div className="flex flex-col md:flex-row">
          {/* لیستی لاتەنیشت — تەنها لە شاشەی گەورە */}
          <nav className="hidden md:flex md:w-56 bg-white border-l border-stone-200 md:min-h-screen p-2 flex-col gap-1 sticky top-[57px] self-start">
            {NAV.map(([id, t, Ic]) => (
              <button key={id} onClick={() => { setPage(id); setDetailId(null); setEditTx(null); }}
                className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl text-sm whitespace-nowrap transition ${page === id ? "bg-emerald-700 text-white font-semibold shadow-sm" : "hover:bg-stone-100 text-slate-600"}`}>
                <Ic className="w-[18px] h-[18px]" /> {t}
              </button>
            ))}
            {isAdmin && (
              <div className="mt-4 pt-3 border-t border-stone-200">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400 mb-1.5 px-1">
                  <Eye className="w-3.5 h-3.5" /> بینین وەک
                </div>
                <ViewAsPicker users={data.users} onPick={setViewAs} compact />
              </div>
            )}
          </nav>
          <main className="flex-1 p-3 pb-24 md:p-6 md:pb-6 max-w-5xl w-full mx-auto">
            {page === "dash" && <Dashboard {...shared} batches={batches} go={setPage} />}
            {page === "safes" && <><Back onClick={() => setPage("dash")} t="گەڕانەوە بۆ داشبۆرد" /><Safes {...shared} addDeposit={addDeposit} addExpense={addExpense} addCurrency={addCurrency} /></>}
            {page === "rates" && <><Back onClick={() => setPage("dash")} t="گەڕانەوە بۆ داشبۆرد" /><Rates {...shared} saveRates={saveRates} /></>}
            {page === "profit" && <><Back onClick={() => setPage("dash")} t="گەڕانەوە بۆ داشبۆرد" /><ProfitPage {...shared} /></>}
            {page === "newtx" && <TxForm {...shared} onSave={saveTx} batch={pendingBatch} onClearBatch={() => setPendingBatch(null)} busy={busy} />}
            {page === "txs" && (editTx
              ? <TxForm {...shared} onSave={saveTx} editing={editTx} onCancel={() => setEditTx(null)} />
              : <TxList {...shared} onEdit={setEditTx} onDel={delTx} settle={settle} unsettle={unsettle} />)}
            {page === "receipts" && <ReceiptsHub {...shared} batches={batches} reloadBatches={reloadBatches} flash={flash} profile={profile}
              onMakeTx={(b) => { setPendingBatch(b); setPage("newtx"); }} />}
            {page === "people" && <PeopleHub {...shared} accountMove={accountMove} accountTransfer={accountTransfer} profile={profile} detailId={detailId} setDetailId={setDetailId} onSave={saveTx} transfer={transfer} officePay={officePay} settle={settle} createUser={createUser} deleteUser={deleteUser} setUserRate={setUserRate} flash={flash} />}
            {page === "report" && <Report {...shared} />}
            {page === "audit" && <Audit data={data} />}
            {page === "close" && <DayClose data={data} calc={calc} cur={cur} usr={usr} closeDay={closeDay} sumUsd={sumUsd} />}
            {page === "backup" && <Backup data={data} calc={calc} cur={cur} saveBackup={saveBackup} downloadBackup={downloadBackup} flash={flash} sumUsd={sumUsd} mySafe={mySafe} owners={owners} ratesReady={ratesReady} />}
          </main>

          {/* لیستی خوارەوە — تەنها لە مۆبایل */}
          <nav className="md:hidden fixed bottom-0 right-0 left-0 z-40 bg-white border-t border-stone-200 flex" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 4px)" }}>
            {NAV.slice(0, 4).map(([id, t, Ic]) => (
              <button key={id} onClick={() => { setPage(id); setDetailId(null); setEditTx(null); setMore(false); }}
                className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-semibold transition ${page === id ? "text-emerald-700" : "text-slate-400"}`}>
                <Ic className="w-5 h-5" /> {t}
              </button>
            ))}
            <button onClick={() => setMore(!more)}
              className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-semibold ${NAV.slice(4).some(([id]) => id === page) ? "text-emerald-700" : "text-slate-400"}`}>
              <MoreHorizontal className="w-5 h-5" /> زیاتر
            </button>
          </nav>

          {more && (
            <div className="md:hidden fixed inset-0 z-50 bg-slate-900/40" onClick={() => setMore(false)}>
              <div className="absolute bottom-0 right-0 left-0 bg-white rounded-t-3xl p-4 pb-8" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-3">
                  <div className="font-bold text-slate-800">بەشەکانی تر</div>
                  <button onClick={() => setMore(false)} className="p-1.5 text-slate-400"><X className="w-5 h-5" /></button>
                </div>
                {NAV.slice(4).map(([id, t, Ic]) => (
                  <button key={id} onClick={() => { setPage(id); setDetailId(null); setEditTx(null); setMore(false); }}
                    className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-xl text-sm mb-1 ${page === id ? "bg-emerald-700 text-white font-semibold" : "text-slate-700 hover:bg-stone-100"}`}>
                    <Ic className="w-5 h-5" /> {t}
                  </button>
                ))}
                {isAdmin && (
                  <div className="mt-3 pt-3 border-t border-stone-200">
                    <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 mb-2 px-1">
                      <Eye className="w-4 h-4" /> بینین وەک بەکارهێنەرێکی تر
                    </div>
                    <ViewAsPicker users={data.users} onPick={(id) => { setViewAs(id); setMore(false); }} />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* هەڵبژاردنی بەکارهێنەر بە گەڕان */
function ViewAsPicker({ users, onPick, compact }) {
  const [q, setQ] = useState("");
  const list = users.filter((u) => u.role !== "admin" && !u.deleted)
    .filter((u) => !q || (u.name || "").includes(q) || (u.phone || "").includes(q) || (ROLE_KU[u.role] || "").includes(q));
  return (
    <div>
      <Inp value={q} onChange={(e) => setQ(e.target.value)} placeholder="گەڕان بە ناو، ژمارە، یان ڕۆڵ..."
        className={compact ? "text-xs py-2" : ""} />
      <div className={`mt-1.5 space-y-1 overflow-y-auto ${compact ? "max-h-44" : "max-h-64"}`}>
        {list.length === 0 ? <div className="text-xs text-slate-400 py-2 text-center">هیچ نەدۆزرایەوە</div> :
          list.map((u) => (
            <button key={u.id} onClick={() => onPick(u.id)}
              className="w-full text-right px-3 py-2 rounded-lg hover:bg-emerald-700 hover:text-white transition group">
              <div className={`font-semibold ${compact ? "text-xs" : "text-sm"} text-slate-800 group-hover:text-white`}>{u.name}</div>
              <div className="text-[10px] text-slate-400 group-hover:text-emerald-100">
                {ROLE_KU[u.role]}{u.phone && <span style={num}> · {u.phone}</span>}
              </div>
            </button>
          ))}
      </div>
    </div>
  );
}

/* ══════════════════ لۆگین ══════════════════ */
function Splash({ t, signOut }) {
  return (
    <div dir="rtl" className="min-h-screen flex flex-col items-center justify-center bg-[#F6F5F2] text-slate-500 gap-4 p-6 text-center">
      <Vault className="w-10 h-10 text-amber-500" />
      <div>{t}</div>
      {signOut && <Btn kind="ghost" onClick={signOut}>دەرچوون</Btn>}
    </div>
  );
}

function Login() {
  const [phone, setPhone] = useState(""); const [pw, setPw] = useState("");
  const [err, setErr] = useState(null); const [loading, setLoading] = useState(false);
  const toEmail = (p) => (p.includes("@") ? p.trim() : p.replace(/\s/g, "") + "@sarraf.local");
  const go = async () => {
    if (!phone || !pw) return setErr("ژمارە و وشەی نهێنی پێویستە");
    setLoading(true); setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email: toEmail(phone), password: pw });
    if (error) setErr("ژمارە یان وشەی نهێنی هەڵەیە");
    setLoading(false);
  };
  return (
    <div dir="rtl" className="min-h-screen flex items-center justify-center bg-slate-900 p-4" style={{ fontFamily: "'Segoe UI', Tahoma, sans-serif" }}>
      <div className="bg-white rounded-2xl shadow-2xl p-7 w-full max-w-sm space-y-5">
        <div className="text-center">
          <Vault className="w-11 h-11 text-amber-500 mx-auto mb-3" />
          <div className="font-bold text-lg text-slate-900">سیستەمی کڕین و فرۆشتنی دراو</div>
          <div className="text-xs text-slate-400 mt-1">چوونە ژوورەوە</div>
        </div>
        <div><Lbl>ژمارەی مۆبایل</Lbl><Inp type="text" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07701234567" /></div>
        <div><Lbl>وشەی نهێنی</Lbl><Inp type="password" dir="ltr" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} /></div>
        {err && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3">{err}</div>}
        <Btn className="w-full" onClick={go} disabled={loading}>{loading ? "..." : "چوونە ژوورەوە"}</Btn>
      </div>
    </div>
  );
}

/* ══════════════════ داشبۆرد ══════════════════ */
function Dashboard({ data, calc, cur, mySafe, profitIn, investorsProfitIn, sumUsd, ratesReady, owners, batches, go }) {
  const today = dOnly(new Date().toISOString());
  const todayTxs = data.txs.filter((t) => !t.deleted && dOnly(t.date) === today);
  const pTod = profitIn(today, today);
  const invTod = investorsProfitIn(pTod);
  const pendBuy = data.txs.filter((t) => !t.deleted && t.status === "pending" && t.type === "buy").length;
  const pendSell = data.txs.filter((t) => !t.deleted && t.status === "pending" && t.type === "sell").length;
  const pendingCount = pendBuy + pendSell;
  const noRates = data.currencies.some((c) => c.id !== "usd" && (!c.buyRate || !c.sellRate));

  /* ئاگادارییەکان — ئەوەی پێویستە سەرنجی بدەیت */
  const alerts = [];
  if (noRates) alerts.push({ tone: "amber", Ic: AlertTriangle, t: "نرخی هەموو دراوەکان دانەنراوە — کلیک بکە", go: () => go("rates") });
  const newBatches = (batches || []).filter((b) => b.status === "new").length;
  const waBatches = (batches || []).filter((b) => b.status === "new" && b.source === "whatsapp").length;
  if (newBatches) alerts.push({ tone: "green", Ic: waBatches ? MessageCircle : ScanLine,
    t: waBatches ? `${newBatches} کۆمەڵەی فیشی نوێ (${waBatches} لە واتساپەوە)` : `${newBatches} کۆمەڵەی فیشی نوێ چاوەڕوانی پشکنینن`,
    go: () => go("receipts") });
  const oldPend = data.txs.filter((t) => !t.deleted && t.status === "pending" && (Date.now() - new Date(t.date).getTime()) > 3 * 86400000).length;
  if (oldPend) alerts.push({ tone: "amber", Ic: AlertTriangle, t: `${oldPend} مامەڵە زیاتر لە ٣ ڕۆژە چاوەڕوانی پارەن`, go: () => go("txs") });
  const negP = data.users.filter((u) => u.role === "partner" && !u.deleted && Object.values(calc.partner[u.id] || {}).some((v) => v < 0));
  if (negP.length) alerts.push({ tone: "red", Ic: TrendingDown, t: `قەرزارت لای ${negP.map((u) => u.name).join("، ")}`, go: () => go("people") });

  const Stat = ({ t, v, tone, i = 0 }) => (
    <Card className="p-4 fade-up" style={{ animationDelay: `${i * 50}ms` }}>
      <div className="text-xs text-slate-500 mb-1">{t}</div>
      <div className={`text-2xl font-bold ${tone || ""}`} style={num}>{v}</div>
    </Card>
  );

  return (
    <div className="space-y-4">
      <H sub={new Date().toLocaleDateString("en-GB")}>داشبۆرد</H>

      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((a, i) => (
            <Card key={i} onClick={a.go} style={{ animationDelay: `${i * 50}ms` }}
              className={`fade-up p-3.5 ${a.tone === "red" ? "border-rose-300 bg-rose-50/60" : a.tone === "amber" ? "border-amber-300 bg-amber-50/60" : "border-emerald-300 bg-emerald-50/50"}`}>
              <div className={`flex items-center gap-2 text-sm font-semibold ${a.tone === "red" ? "text-rose-900" : a.tone === "amber" ? "text-amber-900" : "text-emerald-900"}`}>
                <a.Ic className="w-4 h-4 shrink-0" />
                <span className="flex-1">{a.t}</span>
                <ChevronLeft className="w-4 h-4 opacity-40" />
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat t="مامەڵەی ئەمڕۆ" v={todayTxs.length} i={0} />
        <Stat t="کڕین" v={todayTxs.filter((t) => t.type === "buy").length} tone="text-emerald-700" i={1} />
        <Stat t="فرۆشتن" v={todayTxs.filter((t) => t.type === "sell").length} tone="text-rose-700" i={2} />
        <Stat t="چاوەڕوانی پارە" v={pendingCount} tone={pendingCount ? "text-amber-600" : ""} i={3} />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-5" onClick={() => go("profit")}>
          <div className="flex items-center justify-between mb-3">
            <SecLbl>خێری ئەمڕۆ</SecLbl>
            <span className="text-xs text-emerald-700 font-semibold">وردەکاری ←</span>
          </div>
          {Object.keys(pTod).length === 0 ? <div className="text-sm text-slate-400">هێشتا فرۆشتنێک نەکراوە</div> :
            Object.entries(pTod).map(([cid, v]) => (
              <div key={cid} className="py-2 border-b border-stone-100 last:border-0">
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-slate-600">{cur(cid).name}</span>
                  <span className="text-lg"><Money v={v} dec={cur(cid).dec} pos /></span>
                </div>
                <div className="flex gap-4 text-[11px] text-slate-400 mt-1">
                  <span>خۆم: <span style={num}>{fmt(v - (invTod[cid] || 0), cur(cid).dec)}</span></span>
                  <span>وەبەرهێنەران: <span style={num}>{fmt(invTod[cid] || 0, cur(cid).dec)}</span></span>
                </div>
              </div>
            ))}
        </Card>

        <Card className="p-5" onClick={() => go("rates")}>
          <div className="flex items-center justify-between mb-3">
            <SecLbl>نرخی ئەمڕۆ</SecLbl>
            <span className="text-xs text-emerald-700 font-semibold">گۆڕین ←</span>
          </div>
          {data.currencies.filter((c) => c.id !== "usd").map((c) => (
            <div key={c.id} className="flex justify-between items-center py-1.5 border-b border-stone-100 last:border-0 text-sm">
              <span className="text-slate-600 flex items-center gap-2"><CurBadge c={c} size="sm" /> {c.name}</span>
              <span style={num} className="text-slate-800">
                <span className="text-emerald-700 font-semibold">{c.buyRate ? fmt(c.buyRate, 3) : "—"}</span>
                <span className="text-slate-300 mx-1.5">/</span>
                <span className="text-rose-700 font-semibold">{c.sellRate ? fmt(c.sellRate, 3) : "—"}</span>
              </span>
            </div>
          ))}
          <div className="text-[11px] text-slate-400 mt-2">کڕین / فرۆشتن — ١ دۆلار بە چەند</div>
        </Card>
      </div>

      <SafeCards data={data} calc={calc} cur={cur} mySafe={mySafe} sumUsd={sumUsd} ratesReady={ratesReady} owners={owners} go={go} />
    </div>
  );
}

/* قاسەی گشتی + دابەشبوونی هەر دراوێک */
function SafeCards({ data, calc, cur, mySafe, sumUsd, ratesReady, owners, go }) {
  const [open, setOpen] = useState(null);
  const [view, setView] = useState("where");
  const partners = data.users.filter((u) => u.role === "partner" && !u.deleted);
  const c = open ? cur(open) : null;
  const bal = open ? (calc.phys[open] || 0) : 0;

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-3">
        <SecLbl>قاسەی گشتی</SecLbl>
        <button onClick={() => go("safes")} className="text-xs text-emerald-700 font-semibold">پارە و خەرجی ←</button>
      </div>

      {ratesReady && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="bg-slate-900 text-white rounded-xl p-4">
            <div className="text-[11px] text-slate-400">کۆی گشتی بە دۆلار</div>
            <div className="text-2xl font-bold"><CountUp v={sumUsd(calc.phys)} /> <span className="text-sm text-amber-400">$</span></div>
          </div>
          <div className="bg-emerald-700 text-white rounded-xl p-4">
            <div className="text-[11px] text-emerald-100">ماڵی خۆم بە دۆلار</div>
            <div className="text-2xl font-bold"><CountUp v={sumUsd(mySafe)} /> <span className="text-sm text-amber-300">$</span></div>
          </div>
        </div>
      )}

      <div className="text-[11px] text-slate-400 mb-2">کلیک لە هەر دراوێک بکە بۆ وردەکاری</div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5">
        {data.currencies.map((cc, i) => {
          const isOpen = open === cc.id;
          const v = calc.phys[cc.id] || 0;
          return (
            <button key={cc.id} onClick={() => { setOpen(isOpen ? null : cc.id); setView("where"); }}
              style={{ animationDelay: `${i * 45}ms` }}
              className={`fade-up press text-right border rounded-2xl p-3.5 transition ${isOpen ? "border-emerald-600 bg-emerald-50/60 ring-2 ring-emerald-600/15" : "border-stone-200 bg-white hover:border-emerald-400 lift"}`}>
              <div className="flex items-center gap-2.5">
                <CurBadge c={cc} pulse={isOpen} />
                <div className="min-w-0">
                  <div className="text-[11px] text-slate-500 truncate">
                    {cc.name}{cc.external && <span className="text-amber-600 mr-1">· دەرەوە</span>}
                  </div>
                  <div className={`text-lg font-bold ${v < 0 ? "text-rose-700" : "text-slate-900"}`}>
                    <CountUp v={v} />
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {open && (
        <div className="mt-4 border-t border-stone-200 pt-4">
          <div className="flex items-baseline justify-between mb-3">
            <div className="font-bold text-slate-900">{c.name}</div>
            <div className="text-xl font-bold text-slate-900" style={num}>{fmt(bal, 0)} <span className="text-sm text-amber-600">{c.symbol}</span></div>
          </div>
          <CurrencyBreakdown curId={open} data={data} calc={calc} cur={cur} owners={owners} ratesReady={ratesReady} />
        </div>
      )}
    </Card>
  );
}

/* وردەکاری دراوێک — لای کێیە و هی کێیە */
function CurrencyBreakdown({ curId, data, calc, cur, owners, ratesReady }) {
  const [view, setView] = useState("where");
  const c = cur(curId);
  const bal = calc.phys[curId] || 0;
  const partners = data.users.filter((u) => u.role === "partner" && !u.deleted);
  return (
    <div>
      <div className="flex gap-1 bg-stone-100 rounded-xl p-1 mb-3">
        {[["where", "لای کێیە؟"], ["whose", "هی کێیە؟"]].map(([k, t]) => (
          <button key={k} onClick={() => setView(k)}
            className={`flex-1 py-2 rounded-lg text-sm transition ${view === k ? "bg-white text-emerald-700 font-bold shadow-sm" : "text-slate-500"}`}>{t}</button>
        ))}
      </div>

      {view === "where" ? (
        <div>
          <div className="flex justify-between items-center py-2.5 border-b border-stone-100">
            <span className="text-sm text-slate-600">لای خۆم (قاسەی سەرەکی)</span>
            <Money v={calc.atMe[curId] || 0} dec={0} />
          </div>
          {partners.map((p) => {
            const v = (calc.partner[p.id] || {})[curId];
            if (!v) return null;
            return (
              <div key={p.id} className="flex justify-between items-center py-2.5 border-b border-stone-100">
                <span className="text-sm text-slate-600">لای {p.name}{v < 0 && <span className="text-rose-700 text-xs mr-1">(قەرز)</span>}</span>
                <Money v={v} dec={0} />
              </div>
            );
          })}
          {partners.every((p) => !((calc.partner[p.id] || {})[curId])) && (
            <div className="text-xs text-slate-400 py-2">هیچی لای هاوبەشەکان نییە</div>
          )}
          <div className="flex justify-between items-center pt-3 font-bold">
            <span className="text-sm">کۆی گشتی</span><Money v={bal} dec={0} />
          </div>
        </div>
      ) : (
        <div>
          {!ratesReady && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2.5 mb-2">
              بۆ وردی زیاتر، نرخی هەموو دراوەکان دابنێ
            </div>
          )}
          {!owners || owners.total <= 0 ? <Empty t="هێشتا سەرمایە دانەنراوە" /> :
            owners.list.map((o) => (
              <div key={o.id} className="flex justify-between items-center py-2.5 border-b border-stone-100 last:border-0">
                <div>
                  <span className={`text-sm ${o.isMe ? "font-bold text-emerald-800" : "text-slate-600"}`}>{o.name}</span>
                  <span className="text-xs text-slate-400 mr-2" style={num}>{(o.share * 100).toFixed(1)}٪</span>
                </div>
                <Money v={bal * o.share} dec={0} pos={o.isMe} />
              </div>
            ))}
          <div className="text-[11px] text-slate-400 mt-2.5">
            بەشی هەرکەس بەپێی ڕێژەی سەرمایەکەیەتی — چوونکە هەموو دراوەکان بە پارەی هاوبەش کڕدراون
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════ نرخی ڕۆژانە ══════════════════ */
function Rates({ data, saveRates }) {
  const [rows, setRows] = useState(data.currencies.filter((c) => c.id !== "usd").map((c) => ({ id: c.id, code: c.code, name: c.name, c, buyRate: c.buyRate ?? "", sellRate: c.sellRate ?? "" })));
  const upd = (id, k, v) => setRows(rows.map((r) => (r.id === id ? { ...r, [k]: v } : r)));
  const last = data.currencies.find((c) => c.rateUpdated)?.rateUpdated;
  return (
    <div className="space-y-4">
      <H sub="ڕەیتی هەر دراوێک بەرامبەر ١ دۆلار — لە مامەڵەکاندا ئۆتۆماتیکی بەکاردێت">نرخی ئەمڕۆ</H>
      <Card className="p-5">
        <div className="text-xs text-slate-500 mb-4 bg-stone-50 rounded-xl p-3 leading-relaxed">
          <b className="text-slate-700">١ دۆلار = چەند؟</b> — نموونە: گەر ١ دۆلار بە <b>٧.٢٠</b> یەن بکڕیت و بە <b>٧.١٥</b> یەن بیفرۆشیت، ئەو دوو ژمارەیە بنووسە.
        </div>
        <div className="space-y-4">
          {rows.map((r) => (
            <div key={r.id} className="pb-4 border-b border-stone-100 last:border-0 last:pb-0">
              <div className="flex items-center gap-2.5 mb-2.5">
                <CurBadge c={r.c} size="sm" />
                <span className="text-sm font-semibold text-slate-800">{r.name}</span>
                <span className="text-xs text-slate-400">({r.code})</span>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <div className="text-[11px] font-semibold text-emerald-700 mb-1">١ دۆلار بە چەند دەکڕم</div>
                  <Inp type="number" step="any" dir="ltr" value={r.buyRate}
                    onChange={(e) => upd(r.id, "buyRate", e.target.value)}
                    className="text-center font-bold text-base" placeholder="7.20" />
                </div>
                <div>
                  <div className="text-[11px] font-semibold text-rose-700 mb-1">١ دۆلار بە چەند دەفرۆشم</div>
                  <Inp type="number" step="any" dir="ltr" value={r.sellRate}
                    onChange={(e) => upd(r.id, "sellRate", e.target.value)}
                    className="text-center font-bold text-base" placeholder="7.15" />
                </div>
              </div>
              {r.buyRate && r.sellRate && (
                <div className="text-[11px] text-slate-400 mt-1.5" style={num}>
                  جیاوازی: {fmt(Math.abs(+r.buyRate - +r.sellRate), 3)} — خێری تۆ لە هەر دۆلارێک
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Btn onClick={() => saveRates(rows)}>پاشەکەوتکردنی نرخەکان</Btn>
          {last && <span className="text-xs text-slate-400">دوا نوێکردنەوە: {new Date(last).toLocaleString("en-GB")}</span>}
        </div>
      </Card>

    </div>
  );
}

/* ══════════════════ پەڕەی خێر ══════════════════ */
function ProfitPage({ data, cur, profitIn, investorsProfitIn, invShare }) {
  const [mode, setMode] = useState("day");
  const t = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const day = iso(t);
  const w = new Date(t); w.setDate(w.getDate() - w.getDay());
  const m = new Date(t.getFullYear(), t.getMonth(), 1);
  const from = mode === "day" ? day : mode === "week" ? iso(w) : iso(m);
  const pm = profitIn(from, day);
  const inv = investorsProfitIn(pm);
  const investors = data.users.filter((u) => u.role === "investor" && !u.deleted);

  return (
    <div className="space-y-4">
      <H>خێر بە وردی</H>
      <div className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1 w-fit">
        {[["day", "ئەمڕۆ"], ["week", "ئەم هەفتەیە"], ["month", "ئەم مانگە"]].map(([k, t2]) => (
          <button key={k} onClick={() => setMode(k)}
            className={`px-4 py-2 rounded-lg text-sm ${mode === k ? "bg-emerald-700 text-white font-semibold" : "text-slate-600 hover:bg-stone-100"}`}>{t2}</button>
        ))}
      </div>

      {Object.keys(pm).length === 0 ? <Card><Empty t="هیچ خێرێک نییە لەم ماوەیەدا" /></Card> :
        Object.entries(pm).map(([cid, tot]) => {
          const c = cur(cid);
          const invTot = inv[cid] || 0;
          return (
            <Card key={cid} className="p-5">
              <div className="flex justify-between items-baseline mb-4">
                <div className="font-bold text-slate-800">{c.name}</div>
                <div className="text-2xl"><Money v={tot} dec={c.dec} pos /></div>
              </div>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="bg-emerald-50/70 rounded-xl p-3">
                  <div className="text-xs text-emerald-800/70">خێری خۆم</div>
                  <div className="text-lg"><Money v={tot - invTot} dec={c.dec} pos /></div>
                </div>
                <div className="bg-stone-100/70 rounded-xl p-3">
                  <div className="text-xs text-slate-500">خێری وەبەرهێنەران</div>
                  <div className="text-lg"><Money v={invTot} dec={c.dec} /></div>
                </div>
              </div>
              {invTot > 0 && (
                <div className="border-t border-stone-100 pt-3">
                  <div className="text-xs font-semibold text-slate-500 mb-2">دابەشبوون بەسەر وەبەرهێنەران</div>
                  {investors.map((u) => {
                    const s = invShare(u.id, cid, tot);
                    if (!s) return null;
                    return (
                      <div key={u.id} className="flex justify-between py-1.5 text-sm border-b border-stone-50 last:border-0">
                        <span className="text-slate-600">{u.name} <span className="text-xs text-slate-400">({u.rate}٪)</span></span>
                        <Money v={s} dec={c.dec} />
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          );
        })}
    </div>
  );
}

/* ══════════════════ قاسە و خەرجی ══════════════════ */
function Safes({ data, calc, cur, usr, mySafe, invUnpaid, owners, ratesReady, addDeposit, addExpense, addCurrency }) {
  const [openCur, setOpenCur] = useState(null);
  const [f, setF] = useState({ dir: "in", owner: "self", curId: data.currencies[0]?.id, amount: "", note: "" });
  const [xf, setXf] = useState({ category: "کرێی شوێن", investorId: "", curId: data.currencies[0]?.id, amount: "", note: "" });
  const [nc, setNc] = useState({ code: "", name: "", symbol: "", dec: 2 });
  const investors = data.users.filter((u) => u.role === "investor" && !u.deleted);
  const XCATS = ["کرێی شوێن", "مووچە", "گواستنەوە و حەواڵە", "کارەبا و ئینتەرنێت", "خەرجی تر", "خێری وەبەرهێنەر"];
  const isPayout = xf.category === "خێری وەبەرهێنەر";
  const unpaid = isPayout && xf.investorId ? invUnpaid(xf.investorId, xf.curId) : null;

  return (
    <div className="space-y-4">
      <H>قاسە، پارە و خەرجی</H>

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="flex items-center justify-between mb-1">
            <SecLbl>قاسەی گشتی (هەمووی)</SecLbl>
            <span className="text-[11px] text-slate-400">کلیک بۆ وردەکاری</span>
          </div>
          {data.currencies.map((c) => (
            <div key={c.id}>
              <button onClick={() => setOpenCur(openCur === c.id ? null : c.id)}
                className={`w-full flex justify-between items-center py-2.5 border-b border-stone-100 transition ${openCur === c.id ? "text-emerald-700" : "hover:text-emerald-700"}`}>
                <span className="text-sm flex items-center gap-2">
                  <ChevronLeft className={`w-3.5 h-3.5 transition-transform ${openCur === c.id ? "-rotate-90" : "rotate-180"}`} />
                  <CurBadge c={c} size="sm" />
                  {c.name}
                </span>
                <Money v={calc.phys[c.id] || 0} dec={0} />
              </button>
              {openCur === c.id && (
                <div className="py-3 px-1 bg-stone-50/70 rounded-xl my-2">
                  <CurrencyBreakdown curId={c.id} data={data} calc={calc} cur={cur} owners={owners} ratesReady={ratesReady} />
                </div>
              )}
            </div>
          ))}
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-1.5 mb-3">
            <Wallet className="w-4 h-4 text-emerald-700" />
            <SecLbl>قاسەی تایبەتی خۆم</SecLbl>
          </div>
          {data.currencies.map((c) => (
            <div key={c.id} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
              <span className="text-sm text-slate-600">{c.name}</span>
              <Money v={mySafe[c.id] || 0} dec={c.dec} />
            </div>
          ))}
          <div className="text-[11px] text-slate-400 mt-2">سەرمایەی خۆت + خێری خۆت − خەرجی و عمولەکان</div>
        </Card>
      </div>

      <Card className="p-5">
        <SecLbl>پارە داخڵکردن / دەرهێنان</SecLbl>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div><Lbl>جۆر</Lbl><Sel value={f.dir} onChange={(e) => setF({ ...f, dir: e.target.value })}><option value="in">داخڵکردن</option><option value="out">دەرهێنان</option></Sel></div>
          <div><Lbl>خاوەنی پارە</Lbl><Sel value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}><option value="self">هی خۆم</option>{investors.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Sel></div>
          <div><Lbl>دراو</Lbl><Sel value={f.curId} onChange={(e) => setF({ ...f, curId: e.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
          <div><Lbl>بڕ</Lbl><Inp type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="0" /></div>
          <div className="flex items-end"><Btn className="w-full" onClick={() => { if (+f.amount > 0) { addDeposit(f); setF({ ...f, amount: "" }); } }}>تۆمارکردن</Btn></div>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-1.5 mb-3"><Receipt className="w-4 h-4 text-rose-700" /><SecLbl>تۆمارکردنی خەرجی</SecLbl></div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div><Lbl>جۆری خەرجی</Lbl><Sel value={xf.category} onChange={(e) => setXf({ ...xf, category: e.target.value, investorId: "" })}>{XCATS.map((c) => <option key={c} value={c}>{c}</option>)}</Sel></div>
          {isPayout && (
            <div><Lbl>وەبەرهێنەر</Lbl><Sel value={xf.investorId} onChange={(e) => setXf({ ...xf, investorId: e.target.value })}><option value="">—</option>{investors.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Sel></div>
          )}
          <div><Lbl>دراو</Lbl><Sel value={xf.curId} onChange={(e) => setXf({ ...xf, curId: e.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
          <div><Lbl>بڕ</Lbl><Inp type="number" value={xf.amount} onChange={(e) => setXf({ ...xf, amount: e.target.value })} placeholder="0" /></div>
          {!isPayout && <div><Lbl>تێبینی</Lbl><Inp value={xf.note} onChange={(e) => setXf({ ...xf, note: e.target.value })} /></div>}
          <div className="flex items-end"><Btn kind="danger" className="w-full" onClick={() => { if (+xf.amount > 0) { addExpense(xf); setXf({ ...xf, amount: "", note: "" }); } }}>تۆمارکردن</Btn></div>
        </div>
        {isPayout && xf.investorId && (
          <div className="mt-3 bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm flex items-center justify-between flex-wrap gap-2">
            <span className="text-amber-900">خێری نەدراوی {usr(xf.investorId).name}: <b style={num}>{fmt(unpaid, cur(xf.curId).dec)}</b> {cur(xf.curId).code}</span>
            <button onClick={() => setXf({ ...xf, amount: String(Math.max(0, Math.round(unpaid * 100) / 100)) })} className="text-xs font-semibold text-emerald-700">دانانی ئەم بڕە ←</button>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <SecLbl>زیادکردنی دراوی نوێ</SecLbl>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div><Lbl>کۆد</Lbl><Inp dir="ltr" value={nc.code} onChange={(e) => setNc({ ...nc, code: e.target.value.toUpperCase() })} placeholder="EUR" /></div>
          <div><Lbl>ناو</Lbl><Inp value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} /></div>
          <div><Lbl>هێما</Lbl><Inp value={nc.symbol} onChange={(e) => setNc({ ...nc, symbol: e.target.value })} /></div>
          <div><Lbl>خانەی دەیمی</Lbl><Inp type="number" value={nc.dec} onChange={(e) => setNc({ ...nc, dec: +e.target.value })} /></div>
          <div className="col-span-2 md:col-span-5">
            <label className="flex items-start gap-2.5 cursor-pointer bg-stone-50 border border-stone-200 rounded-xl p-3">
              <input type="checkbox" checked={!!nc.external} onChange={(e) => setNc({ ...nc, external: e.target.checked })}
                className="mt-0.5 w-4 h-4 accent-emerald-700" />
              <span className="text-sm text-slate-700">
                <b>دراوی دەرەوە</b>
                <div className="text-xs text-slate-500 mt-0.5">لای تەرەفەکان هەڵدەگیرێت، لە قاسەی گشتیدا نامێنێتەوە (وەک یەن)</div>
              </span>
            </label>
          </div>
          <div className="flex items-end"><Btn kind="gold" className="w-full" onClick={() => { if (nc.code && nc.name) { addCurrency(nc); setNc({ code: "", name: "", symbol: "", dec: 2 }); } }}>زیادکردن</Btn></div>
        </div>
      </Card>
    </div>
  );
}

/* ══════════════════ فۆرمی مامەڵە ══════════════════ */
function TxForm({ data, cur, calc, usr, avgRate, autoRate, onSave, editing, onCancel, lockCp, batch, onClearBatch, busy }) {
  const e = editing;
  const [sending, setSending] = useState(false);
  const bCur = batch ? data.currencies.find((c) => c.code === batch.currency)?.id : null;
  const [f, setF] = useState({
    type: e ? e.type : (batch?.direction === "out" ? "sell" : "buy"),
    curId: e ? e.curId : (bCur || data.currencies.find((c) => c.id !== "usd")?.id || data.currencies[0]?.id),
    amount: e ? e.amount : (batch ? Math.round(batch.total_net) : ""),
    againstId: e ? e.againstId : "usd",
    quote: e && e.rate ? 1 / e.rate : "",
    manualRate: !!e,
    cpMode: e ? (e.cpId ? "acc" : "free") : "acc",
    cpId: e ? e.cpId || "" : (lockCp || batch?.customer_id || ""),
    cpName: e ? e.cpName || "" : "",
    partnerId: e ? e.partnerId || "" : (batch?.partner_id || ""),
    direct: e ? !!e.direct : false,
    buyQuote: e && e.buyRate ? Math.round((1 / e.buyRate) * 1000) / 1000 : "",
    sellQuote: e && e.direct && e.rate ? Math.round((1 / e.rate) * 1000) / 1000 : "",
    fromId: "", fromName: "", toId: "", toName: "",
    buyStatus: "completed", sellStatus: "completed",
    status: e ? e.status : "completed",
    note: e ? e.note : "",
  });
  const customers = data.users.filter((u) => u.role === "customer" && !u.deleted);
  const partners = data.users.filter((u) => u.role === "partner" && !u.deleted);

  const auto = autoRate(f.type, f.curId, f.againstId);          // نرخی یەک یەکە (ناوەکی)
  const autoQuote = auto ? Math.round((1 / auto) * 1000) / 1000 : null;   // یەک بەرامبەر چەند — ٣ خانە
  // نرخی ڕۆژ خۆکار دادەنرێت، بەڵام هەر کاتێک دەتوانیت بیگۆڕیت
  useEffect(() => {
    if (!f.manualRate && autoQuote) setF((x) => (+x.quote === autoQuote ? x : { ...x, quote: autoQuote }));
  }, [autoQuote, f.manualRate]);
  const quote = +f.quote || 0;                                    // ئەوەی بەکارهێنەر دەینووسێت (٣ خانە)
  const rate = quote ? 1 / quote : 0;                             // بۆ حیسابی ناوەکی
  const offDay = autoQuote && quote && Math.abs(quote - autoQuote) > autoQuote * 0.0001;
  // ── مامەڵەی ڕاستەوخۆ ──
  const bq = +f.buyQuote || 0, sq = +f.sellQuote || 0;
  const dBuyTotal = bq ? Math.round((Math.round(+f.amount || 0)) / bq) : 0;
  const dSellTotal = sq ? Math.round((Math.round(+f.amount || 0)) / sq) : 0;
  const dProfit = bq && sq ? dSellTotal - dBuyTotal : null;
  const amtR = Math.round(+f.amount || 0);
  const total = quote ? Math.round(amtR / quote) : 0;             // بەشکردن، نەک لێکدان
  const av = f.type === "sell" ? avgRate(f.curId, f.againstId) : null;
  const estProfit = f.type === "sell" && av !== null ? Math.round(total - av * amtR) : null;
  const srcBal = f.partnerId ? ((calc.partner[f.partnerId] || {})[f.curId] || 0) : (calc.atMe[f.curId] || 0);
  const willBeNeg = f.type === "sell" && srcBal - amtR < 0;
  const feeRate = f.partnerId ? (usr(f.partnerId).rate || 0) : 0;

  const blank = {
    type: f.type, curId: f.curId, amount: "", againstId: f.againstId, quote: f.quote,
    manualRate: f.manualRate, cpMode: "acc", cpId: lockCp || "", cpName: "",
    partnerId: "", status: "completed", note: "",
    direct: f.direct, buyQuote: f.buyQuote, sellQuote: f.sellQuote,
  };
  const submit = async () => {
    if (sending || busy) return;                       // ڕێگری لە دوو جار کلیک
    setSending(true);
    try {
      const q3 = Math.round(quote * 1000) / 1000;
      const ok = await onSave({ ...f, rate: q3 ? 1 / q3 : 0, batchId: batch?.id }, e);
      if (ok !== false && !e) setF(blank);              // سفرکردنەوەی خانەکان
    } finally { setTimeout(() => setSending(false), 400); }
  };

  return (
    <div className="space-y-4">
      <H>{e ? `ئیدیتی مامەڵە #${e.code}` : "مامەڵەی نوێ"}</H>
      {batch && (
        <Card className="p-4 border-emerald-400 bg-emerald-50/60">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-bold text-emerald-900">لە فیشەکانی {batch.customer_name}</div>
              <div className="text-xs text-emerald-800 mt-1" style={num}>
                {batch.n} فیش · بێ فی {fmt(batch.total_net, 0)} {batch.currency}
                {batch.total_fee > 0 && ` · بە فی ${fmt(batch.total_gross, 0)}`}
              </div>
              <div className="text-[11px] text-emerald-700 mt-1">بڕەکە خۆی دانراوە — تەنها نرخ و شوێنی دانان پڕ بکەرەوە</div>
            </div>
            <button onClick={onClearBatch} className="p-1.5 text-emerald-700/60 hover:text-emerald-900"><X className="w-4 h-4" /></button>
          </div>
        </Card>
      )}
      <Card className="p-5 space-y-5">
        <div className="flex gap-2">
          {["buy", "sell"].map((t) => {
            const locked = !!batch;                       // لە فیشەوە: جۆر قوفڵە
            const active = f.type === t;
            if (locked && !active) return null;
            return (
              <button key={t} disabled={locked}
                onClick={() => !locked && setF({ ...f, type: t, manualRate: false, quote: "", status: "completed" })}
                className={`flex-1 py-2.5 rounded-xl font-bold text-sm transition ${active ? (t === "buy" ? "bg-emerald-700 text-white shadow-sm" : "bg-rose-700 text-white shadow-sm") : "bg-stone-100 text-slate-500 hover:bg-stone-200"} ${locked ? "cursor-default" : ""}`}>
                {t === "buy" ? "کڕین" : "فرۆشتن"}{locked && " (لە فیشەکانەوە)"}
              </button>
            );
          })}
        </div>

        {!batch && (
          <label className="flex items-start gap-2.5 cursor-pointer bg-stone-50 border border-stone-200 rounded-xl p-3">
            <input type="checkbox" checked={f.direct}
              onChange={(ev) => setF({ ...f, direct: ev.target.checked, partnerId: "" })}
              className="mt-0.5 w-4 h-4 accent-emerald-700" />
            <span className="text-sm text-slate-700">
              <b>مامەڵەی ڕاستەوخۆ</b>
              <div className="text-xs text-slate-500 mt-0.5">پارەکە لای هیچ کەس هەڵناگیرێت — ڕاستەوخۆ دەکڕدرێت و دەفرۆشرێت، بێ عمولە</div>
            </span>
          </label>
        )}

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div><Lbl>دراو</Lbl><Sel value={f.curId} onChange={(ev) => setF({ ...f, curId: ev.target.value, manualRate: false, quote: "" })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
          <div><Lbl>بڕ</Lbl><Inp type="number" value={f.amount} onChange={(ev) => setF({ ...f, amount: ev.target.value })} placeholder="0" /></div>
          <div><Lbl>بەرامبەر دراوی</Lbl><Sel value={f.againstId} onChange={(ev) => setF({ ...f, againstId: ev.target.value, manualRate: false, quote: "" })}>{data.currencies.filter((c) => c.id !== f.curId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
        </div>

        {f.direct ? (
          <div className="bg-violet-50/60 border border-violet-200 rounded-xl p-4 space-y-3">
            <div className="text-xs font-bold text-violet-900">ڕەیتی کڕین و فرۆشتن</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[11px] font-semibold text-emerald-700 mb-1">بە چەند دەیکڕم</div>
                <Inp type="number" step="any" dir="ltr" value={f.buyQuote}
                  onChange={(ev) => setF({ ...f, buyQuote: ev.target.value })}
                  className="text-center font-bold text-base" placeholder={autoQuote ? String(autoQuote) : "7.20"} />
              </div>
              <div>
                <div className="text-[11px] font-semibold text-rose-700 mb-1">بە چەند دەیفرۆشم</div>
                <Inp type="number" step="any" dir="ltr" value={f.sellQuote}
                  onChange={(ev) => setF({ ...f, sellQuote: ev.target.value })}
                  className="text-center font-bold text-base" placeholder="7.15" />
              </div>
            </div>
            {bq > 0 && sq > 0 && amtR > 0 && (
              <div className="bg-white rounded-xl p-3 space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">دەدەم (کڕین)</span>
                  <span className="font-bold text-rose-700" style={num}>{fmt(dBuyTotal, 0)} {cur(f.againstId).code}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">وەردەگرم (فرۆشتن)</span>
                  <span className="font-bold text-emerald-700" style={num}>{fmt(dSellTotal, 0)} {cur(f.againstId).code}</span>
                </div>
                <div className="flex justify-between pt-2 mt-1 border-t border-stone-200">
                  <span className="text-sm font-bold text-slate-900">خێر</span>
                  <span className={`text-xl font-bold ${dProfit >= 0 ? "text-emerald-700" : "text-rose-700"}`} style={num}>
                    {dProfit > 0 ? "+" : ""}{fmt(dProfit, 0)} {cur(f.againstId).code}
                  </span>
                </div>
                {dProfit < 0 && <div className="text-[11px] text-rose-700 font-semibold">ئاگاداری: بە زەرەر دەفرۆشیت</div>}
              </div>
            )}
            {autoQuote && (
              <div className="text-[11px] text-slate-500 flex items-center gap-2">
                <span style={num}>نرخی ڕۆژ: {fmt(autoQuote, 3)}</span>
                <button onClick={() => setF({ ...f, buyQuote: autoQuote, sellQuote: autoQuote })}
                  className="text-emerald-700 font-semibold underline">بەکارهێنانی نرخی ڕۆژ</button>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-3 border-t border-violet-200">
              <div>
                <Lbl>لە کێ دەیکڕم؟</Lbl>
                <Sel value={f.fromId} onChange={(ev) => setF({ ...f, fromId: ev.target.value, fromName: "" })}>
                  <option value="">— ناوێکی ئازاد —</option>
                  {customers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </Sel>
                {!f.fromId && <Inp className="mt-1.5" value={f.fromName} onChange={(ev) => setF({ ...f, fromName: ev.target.value })} placeholder="ناوی فرۆشیار..." />}
                <Sel className="mt-1.5" value={f.buyStatus} onChange={(ev) => setF({ ...f, buyStatus: ev.target.value })}>
                  <option value="completed">پارەم داوە</option>
                  <option value="pending">چاوەڕوانی پارەدان</option>
                </Sel>
              </div>
              <div>
                <Lbl>بە کێ دەیفرۆشم؟</Lbl>
                <Sel value={f.toId} onChange={(ev) => setF({ ...f, toId: ev.target.value, toName: "" })}>
                  <option value="">— ناوێکی ئازاد —</option>
                  {customers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </Sel>
                {!f.toId && <Inp className="mt-1.5" value={f.toName} onChange={(ev) => setF({ ...f, toName: ev.target.value })} placeholder="ناوی کڕیار..." />}
                <Sel className="mt-1.5" value={f.sellStatus} onChange={(ev) => setF({ ...f, sellStatus: ev.target.value })}>
                  <option value="completed">پارەم وەرگرتووە</option>
                  <option value="pending">چاوەڕوانی وەرگرتن</option>
                </Sel>
              </div>
            </div>
            <div className="text-[11px] text-violet-800 bg-violet-100/60 rounded-lg p-2.5">
              دوو مامەڵە تۆمار دەکرێت: کڕینێک و فرۆشتنێک · بە پارەی خۆت · خێرەکەی ١٠٠٪ هی خۆتە
            </div>
          </div>
        ) : (
        <div className="bg-stone-50 border border-stone-200 rounded-xl p-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className="text-xs text-slate-500">کۆی گشتی</div>
              <div className="text-2xl"><Money v={total} dec={cur(f.againstId).dec} /> <span className="text-sm text-slate-500">{cur(f.againstId).code}</span></div>
            </div>
            <div className="text-left">
              <div className="text-xs text-slate-500 mb-1">
                یەک {cur(f.againstId).code} چەند {cur(f.curId).code}ە؟
              </div>
              <Inp type="number" step="any" dir="ltr" value={f.quote}
                onChange={(ev) => setF({ ...f, quote: ev.target.value, manualRate: true })}
                className={`w-36 text-center font-bold text-lg ${offDay ? "border-amber-500 bg-amber-50" : ""}`} />
            </div>
          </div>

          <div className="flex items-center justify-between flex-wrap gap-2 mt-3 pt-3 border-t border-stone-200 text-xs">
            <span className="text-slate-500">
              نرخی ڕۆژ: <b style={num} className="text-slate-700">{autoQuote ? fmt(autoQuote, 3) : "دانەنراوە"}</b>
              {quote > 0 && amtR > 0 && (
                <span className="text-slate-400 mr-2" style={num}>
                  · {fmt(amtR, 0)} ÷ {fmt(quote, 3)} = {fmt(total, 0)}
                </span>
              )}
            </span>
            {offDay && (
              <div className="flex items-center gap-2">
                <span className="text-amber-700 font-semibold">نرخێکی تایبەت بەکاردێت</span>
                <button onClick={() => setF({ ...f, manualRate: false, quote: autoQuote })}
                  className="text-emerald-700 font-semibold underline">گەڕانەوە بۆ نرخی ڕۆژ</button>
              </div>
            )}
          </div>

          {(av !== null || estProfit !== null) && (
            <div className="flex gap-5 flex-wrap text-sm mt-3 pt-3 border-t border-stone-200">
              {av !== null && av > 0 && <span className="text-slate-500">مامناوەندی کڕین: <span style={num}>{fmt(1 / av, 3)}</span></span>}
              {estProfit !== null && <span className="text-slate-500">خێری خەمڵێنراو: <Money v={estProfit} dec={cur(f.againstId).dec} pos /></span>}
            </div>
          )}
        </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className={f.direct ? "hidden" : ""}>
            <Lbl>{f.type === "buy" ? "لە کوێ دای دەنێیت؟" : "لە کوێوە دەفرۆشیت؟"}</Lbl>
            <Sel value={f.partnerId} onChange={(ev) => setF({ ...f, partnerId: ev.target.value })}>
              {!cur(f.curId).external && <option value="">قاسەی گشتی — {fmt(calc.atMe[f.curId] || 0, 0)} {cur(f.curId).code}</option>}
              {cur(f.curId).external && <option value="">— تەرەفێک هەڵبژێرە —</option>}
              {partners.map((p) => {
                const b = (calc.partner[p.id] || {})[f.curId] || 0;
                return <option key={p.id} value={p.id}>{p.name} — {fmt(Math.abs(b), cur(f.curId).dec)} {cur(f.curId).code}{b < 0 ? " (قەرز)" : ""}</option>;
              })}
            </Sel>
          </div>
          <div>
            <Lbl>دۆخی پارە</Lbl>
            <Sel value={f.status} onChange={(ev) => setF({ ...f, status: ev.target.value })}>
              {f.type === "buy"
                ? <><option value="completed">پارەم داوە</option><option value="pending">چاوەڕوانی پارە (نووسینگە دەیدات)</option></>
                : <><option value="completed">پارەم وەرگرتووە</option><option value="pending">چاوەڕوانی وەرگرتنی پارە</option></>}
            </Sel>
          </div>
        </div>

        {batch && (
          <div>
            <Lbl>لایەنی بەرامبەر</Lbl>
            <div className="flex items-center gap-2 border border-stone-300 bg-stone-100 rounded-xl px-3 py-2.5">
              <Users className="w-4 h-4 text-slate-400" />
              <span className="text-sm font-semibold text-slate-700">{batch.customer_name || usr(batch.customer_id).name || "—"}</span>
              <span className="text-[11px] text-slate-400 mr-auto">لە فیشەکانەوە — ناگۆڕدرێت</span>
            </div>
          </div>
        )}
        {!lockCp && !batch && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Lbl>لایەنی بەرامبەر</Lbl>
              <Sel value={f.cpMode} onChange={(ev) => setF({ ...f, cpMode: ev.target.value, cpId: "", cpName: "" })}>
                <option value="acc">کڕیارێکی تۆمارکراو</option><option value="free">ئۆزەر (بێ ئەکاونت)</option>
              </Sel>
            </div>
            <div>
              <Lbl>{f.cpMode === "acc" ? "کڕیار هەڵبژێرە" : "ناوی کەسەکە"}</Lbl>
              {f.cpMode === "acc"
                ? <Sel value={f.cpId} onChange={(ev) => setF({ ...f, cpId: ev.target.value })}><option value="">—</option>{customers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Sel>
                : <Inp value={f.cpName} onChange={(ev) => setF({ ...f, cpName: ev.target.value })} placeholder="ناو..." />}
            </div>
          </div>
        )}

        {cur(f.curId).external && !f.partnerId && !f.direct && (
          <div className="flex items-start gap-2 text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            {cur(f.curId).name} لە قاسەی گشتیدا هەڵناگیرێت — دەبێت تەرەفێک هەڵبژێریت
          </div>
        )}
        {f.type === "sell" && av === null && amtR > 0 && (
          <div className="flex items-start gap-2 text-slate-600 bg-stone-50 border border-stone-200 rounded-xl p-3 text-sm">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
            هیچ کڕینێکی پێشووی ئەم دراوە نییە بەرامبەر {cur(f.againstId).code} — بۆیە خێری ئەم فرۆشتنە ناژمێردرێت.
          </div>
        )}
        {feeRate > 0 && f.type === "buy" && +f.amount > 0 && (
          <div className="text-sm bg-stone-50 border border-stone-200 rounded-xl p-3 text-slate-600">
            عمولەی {usr(f.partnerId).name} ({feeRate}٪): <b style={num}>{fmt(Math.round(amtR * feeRate / 100), 0)}</b> {cur(f.curId).code} — دەستبەجێ کەم دەکرێتەوە، باڵانسی دوایی: <b style={num}>{fmt(amtR - Math.round(amtR * feeRate / 100), 0)}</b>
          </div>
        )}
        {willBeNeg && (
          <div className="flex items-start gap-2 text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> دوای ئەم فرۆشتنە باڵانسەکە دەبێتە سالب — قەرزار دەبیت و لە تێکردنی داهاتوودا ئۆتۆماتیکی دەبڕدرێتەوە.
          </div>
        )}

        <div><Lbl>تێبینی</Lbl><Inp value={f.note} onChange={(ev) => setF({ ...f, note: ev.target.value })} /></div>

        <div className="flex gap-2">
          <Btn kind={f.direct ? "gold" : f.type === "buy" ? "primary" : "danger"} onClick={submit} disabled={sending || busy}>
            {sending || busy ? "تۆمارکردن..." : e ? "پاشەکەوتی ئیدیت" : f.direct ? "تۆمارکردنی مامەڵەی ڕاستەوخۆ" : f.type === "buy" ? "تۆمارکردنی کڕین" : "تۆمارکردنی فرۆشتن"}
          </Btn>
          {e && <Btn kind="ghost" onClick={onCancel}>پاشگەزبوونەوە</Btn>}
        </div>
      </Card>
    </div>
  );
}

/* ══════════════════ فلتەری مامەڵەکان ══════════════════ */
const emptyFilter = { q: "", type: "all", status: "all", cur: "all", from: "", to: "" };

function useTxFilter(list, cur, usr) {
  const [f, setF] = useState(emptyFilter);
  const out = list.filter((t) => {
    if (f.type !== "all" && t.type !== f.type) return false;
    if (f.status === "pending" && t.status !== "pending") return false;
    if (f.status === "completed" && t.status !== "completed") return false;
    if (f.cur !== "all" && t.curId !== f.cur && t.againstId !== f.cur) return false;
    const d = dOnly(t.date);
    if (f.from && d < f.from) return false;
    if (f.to && d > f.to) return false;
    if (f.q) {
      const name = t.cpId ? (usr(t.cpId).name || "") : (t.cpName || "");
      const hay = `${t.code || ""} ${name} ${cur(t.curId).code || ""} ${cur(t.againstId).code || ""} ${t.note || ""}`.toLowerCase();
      if (!hay.includes(f.q.toLowerCase().replace("#", ""))) return false;
    }
    return true;
  });
  return [out, f, setF];
}

function TxFilterBar({ data, f, setF, count, total }) {
  const [open, setOpen] = useState(false);
  const active = JSON.stringify(f) !== JSON.stringify(emptyFilter);
  const quick = (days) => {
    const t = new Date(); const to = t.toISOString().slice(0, 10);
    const x = new Date(t); x.setDate(x.getDate() - days);
    setF({ ...f, from: x.toISOString().slice(0, 10), to });
  };
  return (
    <Card className="p-3 md:p-4">
      <div className="flex gap-2 items-center">
        <Inp value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="گەڕان بە کۆد، ناو، دراو..." className="flex-1" />
        <button onClick={() => setOpen(!open)}
          className={`shrink-0 px-3 py-2.5 rounded-xl border text-sm font-semibold flex items-center gap-1.5 transition ${active ? "bg-emerald-700 text-white border-emerald-700" : "bg-white border-stone-300 text-slate-600"}`}>
          <SlidersHorizontal className="w-4 h-4" /> فلتەر
        </button>
      </div>
      {open && (
        <div className="mt-3 pt-3 border-t border-stone-100 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
            <div><Lbl>جۆر</Lbl><Sel value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="all">هەمووی</option><option value="buy">کڕین</option><option value="sell">فرۆشتن</option></Sel></div>
            <div><Lbl>دۆخ</Lbl><Sel value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="all">هەمووی</option><option value="pending">چاوەڕوان</option><option value="completed">تەواوکراو</option></Sel></div>
            <div><Lbl>دراو</Lbl><Sel value={f.cur} onChange={(e) => setF({ ...f, cur: e.target.value })}>
              <option value="all">هەمووی</option>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
            <div className="flex items-end"><Btn kind="ghost" className="w-full" onClick={() => setF(emptyFilter)}>سڕینەوەی فلتەر</Btn></div>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div><Lbl>لە بەرواری</Lbl><Inp type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></div>
            <div><Lbl>بۆ بەرواری</Lbl><Inp type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {[["ئەمڕۆ", 0], ["٧ ڕۆژ", 7], ["٣٠ ڕۆژ", 30], ["٩٠ ڕۆژ", 90]].map(([t, d]) => (
              <button key={t} onClick={() => quick(d)} className="px-3 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-xs font-semibold text-slate-600">{t}</button>
            ))}
          </div>
        </div>
      )}
      {(count != null) && (
        <div className="mt-2.5 pt-2.5 border-t border-stone-100 flex gap-4 flex-wrap text-xs text-slate-500">
          <span><b style={num}>{count}</b> مامەڵە</span>
          {total && Object.entries(total).map(([c, v]) => <span key={c}>{c}: <b style={num}>{fmt(v, 0)}</b></span>)}
        </div>
      )}
    </Card>
  );
}

/* ══════════════════ لیستی مامەڵەکان ══════════════════ */
function TxList({ data, cur, usr, onEdit, onDel, settle, unsettle }) {
  const base = [...data.txs].filter((t) => !t.deleted).reverse();
  const [list, f, setF] = useTxFilter(base, cur, usr);
  const total = {};
  list.forEach((t) => { total[cur(t.againstId).code || "?"] = (total[cur(t.againstId).code || "?"] || 0) + t.total; });
  return (
    <div className="space-y-3">
      <H>مامەڵەکان</H>
      <TxFilterBar data={data} f={f} setF={setF} count={list.length} total={total} />
      {list.length === 0 ? <Card><Empty t="هیچ مامەڵەیەک نەدۆزرایەوە" /></Card> :
        list.map((t) => <TxRow key={t.id} t={t} cur={cur} usr={usr} onEdit={onEdit} onDel={onDel} settle={settle} unsettle={unsettle} />)}
    </div>
  );
}

/* flip = بینینی مامەڵەکە لە ڕوانگەی لایەنی بەرامبەرەوە / lite = بێ وردەکاری ناوخۆیی */
function TxRow({ t, cur, usr, onEdit, onDel, flip, lite, settle, unsettle }) {
  const name = t.cpId ? usr(t.cpId).name : t.cpName;
  const shown = flip ? (t.type === "buy" ? "sell" : "buy") : t.type;
  const pend = t.status === "pending";
  const pendLbl = flip
    ? (t.type === "buy" ? "چاوەڕوانی وەرگرتنی پارە" : "چاوەڕوانی پارەدان")
    : (t.type === "buy" ? "پارە نەدراوە" : "پارە وەرنەگیراوە");
  return (
    <Card className={`p-3.5 ${pend ? "border-amber-300 bg-amber-50/40" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            {t.direct
              ? <Pill tone="amber">ڕاستەوخۆ</Pill>
              : <Pill tone={shown === "buy" ? "green" : "red"}>{shown === "buy" ? "کڕین" : "فرۆشتن"}</Pill>}
            <span className="font-bold text-slate-900" style={num}>{fmt(t.amount, 0)}</span>
            <span className="text-sm text-slate-500">{cur(t.curId).code}</span>
            <span className="text-slate-300 mx-0.5">←</span>
            <span className="font-bold text-slate-900" style={num}>{fmt(t.total, 0)}</span>
            <span className="text-sm text-slate-500">{cur(t.againstId).code}</span>
          </div>
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap mt-1.5 text-xs text-slate-500">
            {t.code && <span className="font-bold text-slate-400" style={num}>#{t.code}</span>}
            {!lite && name && <span className="text-slate-700 font-semibold">{name}</span>}
<span style={num}>ڕەیت {t.rate ? fmt(1 / t.rate, 3) : "—"}</span>
            {!lite && t.partnerId && <span className="text-amber-700">لای {usr(t.partnerId).name}</span>}
            {!lite && t.direct && t.buyRate && <span style={num} className="text-slate-500">کڕی {fmt(1 / t.buyRate, 3)}</span>}
            {!lite && t.profit != null && <span>خێر <b className="text-emerald-700" style={num}>{fmt(t.profit, 0)}</b></span>}
            {!lite && t.edited && <span className="text-slate-400">(ئیدیت)</span>}
            <span className="text-slate-400" style={num}>{new Date(t.date).toLocaleDateString("en-GB")}</span>
          </div>
          {pend && <div className="mt-2"><Pill tone="amber">{pendLbl}</Pill></div>}
        </div>
        {(onEdit || onDel) && (
          <div className="flex flex-col gap-1 shrink-0">
            {onEdit && <button onClick={() => onEdit(t)} className="p-2 rounded-lg text-slate-400 hover:text-emerald-700 hover:bg-emerald-50"><Pencil className="w-4 h-4" /></button>}
            {onDel && <button onClick={() => onDel(t)} className="p-2 rounded-lg text-slate-400 hover:text-rose-700 hover:bg-rose-50"><Trash2 className="w-4 h-4" /></button>}
          </div>
        )}
      </div>
      {pend && settle && (
        <div className="mt-2.5 pt-2.5 border-t border-amber-200/70">
          <button onClick={() => settle(t)} className="flex items-center gap-1.5 text-sm font-semibold text-emerald-700 hover:text-emerald-800">
            <CheckCircle2 className="w-4 h-4" /> {t.type === "buy" ? "پارەکەم دا" : "پارەکەم وەرگرت"}
          </button>
        </div>
      )}
      {!pend && t.paidAt && unsettle && (
        <div className="mt-2.5 pt-2.5 border-t border-stone-100">
          <button onClick={() => unsettle(t)} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-amber-700">
            <RotateCcw className="w-3.5 h-3.5" /> هەڵوەشاندنەوەی پارەدان
          </button>
        </div>
      )}
    </Card>
  );
}/* ══════════════════ فیشەکان ══════════════════ */

async function prepImage(file) {
  const bmp = await createImageBitmap(file);
  const MAX = 1400;
  const s = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const cv = document.createElement("canvas");
  cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
  cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
  const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.8));
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  const hb = await crypto.subtle.digest("SHA-256", buf);
  const hash = [...new Uint8Array(hb)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return { b64: btoa(bin), hash, blob, url: URL.createObjectURL(blob) };
}
const normRef = (r) => String(r || "").replace(/[\s\-_.]/g, "").toUpperCase();
const DIR_KU = { in: "پارە هاتووە", out: "پارە نێردراوە" };
const PLATFORMS = {
  Alipay:   { ku: "ئەلی پەی", cls: "bg-blue-50 text-blue-800 border-blue-200" },
  WeChat:   { ku: "وی چات",  cls: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  Bank:     { ku: "بانک",     cls: "bg-slate-50 text-slate-700 border-slate-200" },
  FIB:      { ku: "FIB",      cls: "bg-violet-50 text-violet-800 border-violet-200" },
  FastPay:  { ku: "FastPay",  cls: "bg-amber-50 text-amber-800 border-amber-200" },
  ZainCash: { ku: "Zain Cash", cls: "bg-rose-50 text-rose-800 border-rose-200" },
};
const platMeta = (p) => PLATFORMS[p] || { ku: p || "نەزانراو", cls: "bg-stone-50 text-slate-600 border-stone-200" };
const detectPlatform = (bank) => {
  const b = String(bank || "").toLowerCase();
  if (/alipay|支付宝/.test(b)) return "Alipay";
  if (/wechat|weixin|微信/.test(b)) return "WeChat";
  if (/\bfib\b/.test(b)) return "FIB";
  if (/fastpay/.test(b)) return "FastPay";
  if (/zain/.test(b)) return "ZainCash";
  if (/bank|بانک|مصرف/.test(b)) return "Bank";
  return null;
};
const REJECT_KU = {
  no_ref: "ژمارەی مامەڵەی نییە",
  same_image: "هەمان وێنە پێشتر ناردراوە",
  same_ref: "هەمان ژمارەی مامەڵە پێشتر تۆمار کراوە",
  same_batch: "لەم کۆمەڵەیەدا دووبارە بووەتەوە",
  same_amount_time: "هەمان بڕ لە هەمان کاتدا",
  old_date: "ڕێکەوتی کۆن",
  unreadable: "نەخوێندرایەوە",
  not_receipt: "فیشی پارەدان نییە",
  tampered: "نیشانەی دەستکاری تێدایە",
  low_confidence: "خوێندنەوەکە دڵنیا نییە",
};

function ReceiptImg({ path, className }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!path) return;
    supabase.storage.from("receipts").createSignedUrl(path, 3600)
      .then(({ data }) => { if (alive && data) setUrl(data.signedUrl); }).catch(() => {});
    return () => { alive = false; };
  }, [path]);
  if (!url) return <div className={`bg-stone-200 animate-pulse ${className}`} />;
  return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="فیش" className={className} /></a>;
}

/* ─────────── کۆکردنەوەی فیشەکان — بە فی و بێ فی ─────────── */
function ReceiptTotals({ rows, data, title, compact }) {
  const u = usdConv(data);
  // پاراستن: هەرگیز فیشی ڕەتکراو هەژمار ناکرێت
  const counted = (rows || []).filter((r) => r.counted !== false && r.status !== "dup" && r.status !== "error");
  const rejected = (rows || []).filter((r) => r.counted === false || r.status === "dup" || r.status === "error");
  const gross = {}, fees = {}, net = {}, byWho = {}, byPlat = {};
  counted.forEach((r) => {
    const c = r.currency || "?";
    const g = +(r.amount) || 0;
    const f = +(r.fee) || 0;
    const n = r.net != null ? +r.net : (r.net_amount != null ? +r.net_amount : g - f);
    gross[c] = (gross[c] || 0) + g;
    fees[c] = (fees[c] || 0) + f;
    net[c] = (net[c] || 0) + n;
    const k = (r.receiver || r.sender || "نەزانراو").trim();
    byWho[k] = byWho[k] || { n: 0, cur: {} };
    byWho[k].n++;
    byWho[k].cur[c] = (byWho[k].cur[c] || 0) + n;
    const pl = r.platform || detectPlatform(r.bank) || "نەزانراو";
    byPlat[pl] = byPlat[pl] || { n: 0, cur: {} };
    byPlat[pl].n++;
    byPlat[pl].cur[c] = (byPlat[pl].cur[c] || 0) + n;
  });
  const whoList = Object.entries(byWho).sort((a, b) => b[1].n - a[1].n);
  const curs = Object.keys(gross);

  return (
    <>
      <Card className="p-5">
        {title && <SecLbl>{title}</SecLbl>}
        {curs.length === 0 ? <Empty t="هیچ فیشێک نییە" /> :
          curs.map((c) => {
            const cc = (data?.currencies || []).find((x) => x.code === c);
            const mid = cc && cc.id !== "usd" ? (cc.buyRate && cc.sellRate ? (cc.buyRate + cc.sellRate) / 2 : (cc.buyRate || cc.sellRate)) : null;
            return (
              <div key={c} className="bg-stone-50 border border-stone-200 rounded-2xl p-4 mb-2.5 last:mb-0">
                <div className="flex items-center gap-2 mb-3">
                  {cc && <CurBadge c={cc} size="sm" />}
                  <span className="text-xs font-bold text-slate-500">{cc?.name || c}</span>
                  {mid && <span className="text-[10px] text-slate-400 mr-auto" style={num}>نرخی ڕۆژ {fmt(mid, 3)}</span>}
                </div>
                <div className="flex justify-between py-1.5 text-sm">
                  <span className="text-slate-600">کۆی گشتی (بە فییەوە)</span>
                  <span className="font-bold text-slate-800" style={num}>{fmt(gross[c], 0)}</span>
                </div>
                <div className="flex justify-between py-1.5 text-sm">
                  <span className="text-slate-600">فی</span>
                  <span className={`font-bold ${fees[c] ? "text-rose-700" : "text-slate-300"}`} style={num}>
                    {fees[c] ? `− ${fmt(fees[c], 0)}` : "0"}
                  </span>
                </div>
                <div className="flex justify-between pt-3 mt-1.5 border-t-2 border-stone-200 items-baseline">
                  <span className="text-sm font-bold text-slate-900">گەیشتوو (بێ فی)</span>
                  <div className="text-left">
                    <div className="text-2xl font-bold text-emerald-700"><CountUp v={net[c]} /></div>
                    {u(net[c], c) != null && <div className="text-[11px]"><UsdHint v={u(net[c], c)} /></div>}
                  </div>
                </div>
              </div>
            );
          })}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs mt-2">
          <span className="text-slate-500" style={num}>{counted.length} فیش هەژمار کراوە</span>
          {rejected.length > 0 && <span className="text-rose-700 font-semibold" style={num}>{rejected.length} فیش ڕەت کراوەتەوە (هەژمار نەکراون)</span>}
        </div>
      </Card>

      {!compact && Object.keys(byPlat).length > 1 && (
        <Card className="p-5">
          <SecLbl>بەپێی پلاتفۆرم</SecLbl>
          {Object.entries(byPlat).sort((a, b) => b[1].n - a[1].n).map(([pl, v]) => {
            const m = platMeta(pl);
            return (
              <div key={pl} className="flex items-center justify-between py-2.5 border-b border-stone-100 last:border-0">
                <span className={`px-2.5 py-1 rounded-lg text-xs font-bold border ${m.cls}`}>{m.ku}</span>
                <div className="text-left">
                  {Object.entries(v.cur).map(([c, a]) => (
                    <div key={c}>
                      <div className="font-bold text-slate-900" style={num}>{fmt(a, 0)} <span className="text-xs font-normal text-slate-500">{c}</span></div>
                      <div className="text-[11px] text-slate-400" style={num}>{v.n} فیش</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </Card>
      )}

      {!compact && whoList.length > 0 && (
        <Card className="p-5">
          <SecLbl>وردەکاری بەپێی ناو</SecLbl>
          {whoList.map(([name, v]) => (
            <div key={name} className="flex items-center justify-between py-2.5 border-b border-stone-100 last:border-0">
              <div>
                <div className="font-semibold text-slate-800">{name}</div>
                <div className="text-xs text-slate-400" style={num}>{v.n} فیش</div>
              </div>
              <div className="text-left">
                {Object.entries(v.cur).map(([c, a]) => (
                  <div key={c}>
                    <div className="font-bold text-slate-900" style={num}>{fmt(a, 0)} <span className="text-xs font-normal text-slate-500">{c}</span></div>
                    <div className="text-[11px]"><UsdHint v={u(a, c)} /></div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}

/* ─────────── فیشە ڕەتکراوەکان — بە هۆکارەوە ─────────── */
function RejectedReceipts({ rows, title = "فیشە ڕەتکراوەکان" }) {
  const bad = (rows || []).filter((r) => r.counted === false || r.status === "dup" || r.status === "error");
  const [open, setOpen] = useState(false);
  if (!bad.length) return null;

  // کۆکردنەوە بەپێی هۆکار
  const byCode = {};
  bad.forEach((r) => { const k = r.reject_code || r.rejectCode || "other"; byCode[k] = (byCode[k] || 0) + 1; });

  return (
    <Card className="p-5 border-rose-300 bg-rose-50/40">
      <button onClick={() => setOpen(!open)} className="w-full text-right">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 font-bold text-rose-900">
              <AlertTriangle className="w-4 h-4" /> {title}
            </div>
            <div className="text-xs text-rose-800/80 mt-1.5" style={num}>
              {bad.length} فیش هەژمار نەکراون
            </div>
            <div className="flex gap-1.5 mt-2 flex-wrap">
              {Object.entries(byCode).map(([k, n]) => (
                <Pill key={k} tone="red">{REJECT_KU[k] || "هۆکاری تر"} ({n})</Pill>
              ))}
            </div>
          </div>
          <ChevronLeft className={`w-5 h-5 text-rose-400 transition-transform shrink-0 ${open ? "-rotate-90" : "rotate-180"}`} />
        </div>
      </button>

      {open && (
        <div className="mt-4 pt-4 border-t border-rose-200 space-y-2.5">
          {bad.map((r) => (
            <div key={r.id} className="bg-white rounded-xl border border-rose-200 p-3">
              <div className="flex gap-3">
                {r.image_path
                  ? <ReceiptImg path={r.image_path} className="w-16 h-16 object-cover rounded-lg border border-stone-200 shrink-0 opacity-70" />
                  : r.url
                    ? <img src={r.url} alt="" className="w-16 h-16 object-cover rounded-lg border border-stone-200 shrink-0 opacity-70" />
                    : <div className="w-16 h-16 bg-stone-100 rounded-lg shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-base font-bold text-slate-400 line-through" style={num}>
                      {r.amount ? fmt(r.net_amount ?? r.net ?? r.amount, 0) : "—"}
                    </span>
                    <span className="text-xs text-slate-400">{r.currency || ""}</span>
                    <Pill tone="red">هەژمار نەکراوە</Pill>
                  </div>
                  <div className="mt-1.5 text-xs text-rose-900 bg-rose-50 rounded-lg px-2.5 py-1.5 leading-relaxed">
                    <b>هۆکار:</b> {r.reject_reason || r.rejectReason || r.note || "نەزانراو"}
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                    {(r.ref_no || r.refNo) && <div style={num}>ژمارەی مامەڵە: <b>{r.ref_no || r.refNo}</b></div>}
                    {(r.tx_time || r.txTime) && <div>کاتی مامەڵە: <b>{r.tx_time || r.txTime}</b></div>}
                    {(r.receiver) && <div>وەرگر: <b>{r.receiver}</b></div>}
                    {(r.sender) && <div>ناردەر: <b>{r.sender}</b></div>}
                    {(r.bank) && <div>ئەپ/بانک: <b>{r.bank}</b></div>}
                    {r.created_at && <div style={num}>کاتی ناردن: <b>{new Date(r.created_at).toLocaleString("en-GB")}</b></div>}
                  </div>
                  {(r.dup_of_date || r.dupOfDate) && (
                    <div className="mt-1.5 text-[11px] text-slate-500 bg-stone-50 rounded-lg px-2.5 py-1.5">
                      فیشە ڕەسەنەکە: <b style={num}>{new Date(r.dup_of_date || r.dupOfDate).toLocaleString("en-GB")}</b>
                      {(r.dup_of_who || r.dupOfWho) && <> · لەلایەن <b>{r.dup_of_who || r.dupOfWho}</b></>}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ─────────── لیستی فیشەکان + گەلەری ─────────── */
function ReceiptList({ rows, showFrom }) {
  const [view, setView] = useState("list");
  const all = rows || [];
  rows = all.filter((r) => r.counted !== false && r.status !== "dup" && r.status !== "error");
  if (!all.length) return <Card><Empty t="هیچ فیشێک نییە" /></Card>;
  if (!rows.length) return <Card><Empty t="هەموو فیشەکان ڕەت کراونەتەوە" /></Card>;
  return (
    <div className="space-y-3">
      <div className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1">
        {[["list", "وردەکاری"], ["gallery", "وێنەکان"]].map(([k, lbl]) => (
          <button key={k} onClick={() => setView(k)}
            className={`flex-1 py-2.5 rounded-lg text-sm ${view === k ? "bg-emerald-700 text-white font-semibold" : "text-slate-600"}`}>{lbl}</button>
        ))}
      </div>
      {view === "gallery" ? (
        <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
          {rows.filter((r) => r.image_path).map((r) => (
            <div key={r.id} className="relative fade-up">
              <ReceiptImg path={r.image_path} className="w-full aspect-square object-cover rounded-xl border border-stone-200" />
              <div className="absolute bottom-1 right-1 left-1 bg-slate-900/80 text-white text-[10px] rounded-lg px-1.5 py-0.5 text-center" style={num}>
                {fmt(r.net_amount ?? r.amount, 0)}
              </div>
            </div>
          ))}
          {rows.filter((r) => r.image_path).length === 0 && <div className="col-span-full"><Empty t="هیچ وێنەیەک نییە" /></div>}
        </div>
      ) : rows.map((r) => (
        <Card key={r.id} className={`p-3 ${r.status === "dup" ? "bg-rose-50/50 border-rose-200" : ""}`}>
          <div className="flex gap-3">
            {r.image_path
              ? <ReceiptImg path={r.image_path} className="w-16 h-16 object-cover rounded-xl border border-stone-200 shrink-0" />
              : <div className="w-16 h-16 bg-stone-100 rounded-xl shrink-0" />}
            <div className="min-w-0 flex-1 text-sm">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-lg font-bold text-slate-900" style={num}>{fmt(r.net_amount ?? r.amount, 0)}</span>
                <span className="text-xs text-slate-500">{r.currency}</span>
                {r.fee > 0 && <span className="text-[11px] text-slate-400" style={num}>بە فی {fmt(r.amount, 0)}</span>}
                {r.fee_discount > 0 && <span className="text-[10px] text-emerald-700 font-semibold" style={num}>داشکاندنی فی {fmt(r.fee_discount, 0)}</span>}
                {r.status === "dup" && <Pill tone="red">دووبارە</Pill>}
                {r.status === "suspect" && <Pill tone="amber">گومان</Pill>}
                {r.direction === "out" && <Pill tone="amber">نێردراو</Pill>}
                {(r.platform || detectPlatform(r.bank)) && (() => {
                  const m = platMeta(r.platform || detectPlatform(r.bank));
                  return <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold border ${m.cls}`}>{m.ku}</span>;
                })()}
              </div>
              <div className="text-xs text-slate-600 mt-0.5">
                {showFrom && r.customer_name && <>لە <b>{r.customer_name}</b> </>}
                {r.receiver && <>بۆ <b>{r.receiver}</b></>}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5" style={num}>
                ژمارە {r.ref_no || "—"} · {r.tx_time || new Date(r.created_at).toLocaleString("en-GB")}
              </div>
              {r.note && <div className="text-[11px] text-amber-700 mt-0.5">{r.note}</div>}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

/* ─────────── ئەپلۆدکەری فیش ─────────── */
function ReceiptUploader({ customerId, customerName, partnerId, uploaderId, direction = "in", onDone, flash, data, allowDirection }) {
  const [rows, setRows] = useState([]);
  const [dir, setDir] = useState(direction);
  const [working, setWorking] = useState(false);
  const [prog, setProg] = useState(null);
  const [sending, setSending] = useState(false);
  const [share, setShare] = useState(false);
  const maxAge = 7;

  const onFiles = async (files) => {
    const list = Array.from(files || []).filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    setWorking(true);
    const out = [...rows];
    try {
      for (let i = 0; i < list.length; i++) {
        setProg(`${i + 1} لە ${list.length}`);
        const f = list[i];
        let img;
        try { img = await prepImage(f); }
        catch { out.push({ id: uid(), status: "error", note: "نەتوانرا وێنەکە بکرێتەوە" }); setRows([...out]); continue; }

        let inOld = null;
        try {
          const { data: hit } = await supabase.rpc("check_receipt_dupe", { p_hash: img.hash, p_ref: null });
          if (hit?.length) inOld = hit[0];
        } catch {}
        const inBatch = out.find((r) => r.hash === img.hash);
        if (inBatch || inOld) {
          const code = inBatch ? "same_batch" : "same_image";
          const reason = inBatch
            ? `هەمان وێنە لەم کۆمەڵەیەدا دووبارە بووەتەوە (فیشی ژمارە ${out.findIndex((r) => r.hash === img.hash) + 1})`
            : `هەمان وێنە پێشتر ناردراوە لە ${inOld?.d ? new Date(inOld.d).toLocaleString("en-GB") : "پێشتر"}${inOld?.who ? ` لەلایەن ${inOld.who}` : ""}${inOld?.ref ? ` — ژمارەی مامەڵە ${inOld.ref}` : ""}`;
          out.push({ id: uid(), url: img.url, blob: img.blob, hash: img.hash, status: "dup", counted: false,
            rejectCode: code, rejectReason: reason, note: reason,
            dupOf: inOld?.id || null, dupOfDate: inOld?.d || null, dupOfWho: inOld?.who || null });
          setRows([...out]); continue;
        }

        let d;
        try {
          if (i > 0) await new Promise((r) => setTimeout(r, 1500));
          const resp = await fetch("/api/read-receipt", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ image: img.b64, mediaType: "image/jpeg" }),
          });
          const raw = await resp.text();
          if (resp.status === 404) throw new Error("خزمەتگوزاری خوێندنەوە بەردەست نییە");
          try { d = JSON.parse(raw); } catch { throw new Error(`وەڵامی نەناسراو (${resp.status})`); }
          if (d.error) throw new Error(d.error);
        } catch (e) {
          const reason = `نەتوانرا بخوێندرێتەوە: ${String(e.message || e)}`;
          out.push({ id: uid(), url: img.url, hash: img.hash, blob: img.blob, status: "error", counted: false,
            rejectCode: "unreadable", rejectReason: reason, note: reason });
          setRows([...out]); continue;
        }
        if (d.ok === false) {
          const reason = d.note || "ئەم وێنەیە فیشی پارەدان نییە";
          out.push({ id: uid(), url: img.url, hash: img.hash, blob: img.blob, status: "error", counted: false,
            rejectCode: "not_receipt", rejectReason: reason, note: reason });
          setRows([...out]); continue;
        }

        const rn = normRef(d.refNo);
        let status = "ok", note = "", rejectCode = null, rejectReason = null, dupOf = null, dupOfDate = null, dupOfWho = null;
        // بێ ژمارەی مامەڵە → نەژمێردرێت
        if (!rn) {
          status = "dup"; rejectCode = "no_ref";
          rejectReason = "ژمارەی مامەڵەی (Order No) نییە — ناتوانرێت پشتڕاست بکرێتەوە";
          note = rejectReason;
        }
        if (rn) {
          const bch = out.find((r) => r.refNo && normRef(r.refNo) === rn);
          let o = null;
          try { const { data: hit } = await supabase.rpc("check_receipt_dupe", { p_hash: null, p_ref: rn }); if (hit?.length) o = hit[0]; } catch {}
          if (bch || o) {
            status = "dup";
            rejectCode = bch ? "same_batch" : "same_ref";
            rejectReason = bch
              ? `هەمان ژمارەی مامەڵە (${d.refNo}) لەم کۆمەڵەیەدا دووبارە بووەتەوە`
              : `ژمارەی مامەڵەی ${d.refNo} پێشتر تۆمار کراوە لە ${o?.d ? new Date(o.d).toLocaleString("en-GB") : "پێشتر"}${o?.who ? ` لەلایەن ${o.who}` : ""}`;
            note = rejectReason;
            dupOf = o?.id || null; dupOfDate = o?.d || null; dupOfWho = o?.who || null;
          }
        }
        if (status === "ok") {
          const same = out.find((r) => r.counted !== false && r.amount && +r.amount === +d.amount && r.txTime && d.txTime && r.txTime === d.txTime);
          if (same) { status = "dup"; rejectCode = "same_amount_time";
            rejectReason = `هەمان بڕ (${fmt(d.amount, 0)}) لە هەمان کاتدا (${d.txTime}) — گومانی دووبارەبوونەوە`;
            note = rejectReason; }
        }
        let ageDays = null;
        if (d.txDate && /^\d{4}-\d{2}-\d{2}$/.test(d.txDate)) {
          ageDays = Math.floor((Date.now() - new Date(d.txDate + "T12:00:00").getTime()) / 86400000);
          if (status === "ok" && ageDays > maxAge) { status = "suspect"; note = `ڕێکەوتی کۆن — ${ageDays} ڕۆژ لەمەوبەر`; }
        }
        if (status === "ok" && d.confidence != null && d.confidence < 0.6) { status = "suspect"; note = "خوێندنەوەکە دڵنیا نییە — بە دەست بیپشکنە"; }
        if (status !== "dup" && d.note && /دەستکاری|فۆتۆشۆپ|tamper/i.test(d.note)) { status = "suspect"; note = `⚠️ ${d.note}`; }

        const feeV = +d.fee || 0;                          // فی دوای داشکاندن
        const feeOrig = d.feeOriginal != null ? +d.feeOriginal : feeV;
        const feeDisc = +d.feeDiscount || 0;
        const netV = d.netAmount != null ? +d.netAmount : (+d.amount || 0) - feeV;
        const plat = d.platform || detectPlatform(d.bank);
        if (feeDisc > 0) note = note || `داشکاندنی فی: ${fmt(feeOrig, 0)} → ${fmt(feeV, 0)}`;
        out.push({ id: uid(), url: img.url, blob: img.blob, hash: img.hash, status, note,
          counted: status !== "dup", rejectCode, rejectReason, dupOf, dupOfDate, dupOfWho,
          amount: +d.amount || 0, fee: feeV, feeOriginal: feeOrig, feeDiscount: feeDisc,
          net: netV, currency: d.currency, sender: d.sender, platform: plat,
          receiver: d.receiver, refNo: d.refNo, txTime: d.txTime, txDate: d.txDate, ageDays, bank: d.bank, raw: d });
        setRows([...out]);
      }
    } finally { setWorking(false); setProg(null); }
  };

  const good = rows.filter((r) => r.counted !== false && r.status !== "dup" && r.status !== "error");
  const bad = rows.filter((r) => r.counted === false || r.status === "dup" || r.status === "error");
  const dupN = rows.filter((r) => r.status === "dup").length;
  const errN = rows.filter((r) => r.status === "error").length;
  const agg = {};
  good.forEach((r) => { const c = r.currency || "?"; agg[c] = agg[c] || { g: 0, f: 0, n: 0 }; agg[c].g += +r.amount || 0; agg[c].f += +r.fee || 0; agg[c].n += +r.net || 0; });
  const mainCur = Object.keys(agg).sort((a, b) => agg[b].g - agg[a].g)[0] || null;

  const send = async () => {
    if (!good.length && !bad.length) return flash("هیچ فیشێک نییە");
    setSending(true);
    try {
      const batchId = uid();
      const folder = customerId || partnerId || "misc";
      const recs = [];
      // هەموو فیشەکان پاشەکەوت دەکرێن — ڕەتکراوەکانیش بۆ تۆمار مێژوویی
      for (const r of [...good, ...bad]) {
        let path = null;
        if (r.blob) {
          path = `${folder}/${batchId}/${r.id}.jpg`;
          const up = await supabase.storage.from("receipts").upload(path, r.blob, { contentType: "image/jpeg", upsert: false });
          if (up.error) { console.error(up.error); path = null; }
        }
        recs.push({
          id: r.id, batch_id: batchId, customer_id: customerId || null, customer_name: customerName || null,
          direction: dir, amount: r.amount || null, fee: r.fee || 0,
          fee_original: r.feeOriginal ?? null, fee_discount: r.feeDiscount || 0,
          platform: r.platform || null, net_amount: r.net ?? null,
          currency: r.currency || null, sender: r.sender || null, receiver: r.receiver || null,
          ref_no: r.refNo || null, tx_time: r.txTime || null, tx_date: r.txDate || null, bank: r.bank || null,
          note: r.note || null, image_hash: r.hash, image_path: path, status: r.status,
          counted: r.counted !== false, reject_code: r.rejectCode || null, reject_reason: r.rejectReason || null,
          dup_of: r.dupOf || null, dup_of_date: r.dupOfDate || null, dup_of_who: r.dupOfWho || null,
          uploaded_by: uploaderId || null, raw: r.raw || null,
        });
      }
      const a = mainCur ? agg[mainCur] : { g: 0, f: 0, n: 0 };
      const b = await supabase.from("receipt_batches").insert({
        id: batchId, customer_id: customerId || null, customer_name: customerName || null,
        partner_id: partnerId || null, direction: dir, status: "new", currency: mainCur,
        total_gross: a.g, total_fee: a.f, total_net: a.n, n: good.length, dup_n: dupN,
        rejected_n: bad.length, uploaded_by: uploaderId || null,
      });
      if (b.error) throw b.error;
      const rr = await supabase.from("receipts").insert(recs);
      if (rr.error) throw rr.error;
      flash(`${good.length} فیش نێردرا ✓${bad.length ? ` — ${bad.length} ڕەتکراو تۆمار کران` : ""}`);
      setRows([]);
      onDone && onDone();
    } catch (e) { console.error(e); flash("هەڵە لە ناردن — دووبارە هەوڵ بدە"); }
    finally { setSending(false); }
  };

  const ST = { ok: { tone: "green", t: "دروست" }, dup: { tone: "red", t: "دووبارە" }, suspect: { tone: "amber", t: "گومانلێکراو" }, error: { tone: "slate", t: "هەڵە" } };

  return (
    <div className="space-y-4">
      {allowDirection && (
        <Card className="p-4">
          <Lbl>جۆری فیشەکان</Lbl>
          <div className="flex gap-2">
            {[["in", "پارە هاتووە (کڕین)"], ["out", "پارە نێردراوە (فرۆشتن)"]].map(([k, t]) => (
              <button key={k} onClick={() => setDir(k)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition press ${dir === k ? (k === "in" ? "bg-emerald-700 text-white" : "bg-rose-700 text-white") : "bg-stone-100 text-slate-500"}`}>{t}</button>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-5">
        <label className={`block border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition ${working ? "border-stone-200 bg-stone-50" : "border-stone-300 hover:border-emerald-500 hover:bg-emerald-50/30"}`}>
          <input type="file" accept="image/*" multiple className="hidden" disabled={working}
            onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }} />
          <Upload className="w-8 h-8 mx-auto text-slate-400 mb-2" />
          <div className="text-sm font-semibold text-slate-700">{working ? `خوێندنەوە... ${prog || ""}` : "کلیک بکە بۆ هەڵبژاردنی فیشەکان"}</div>
          <div className="text-xs text-slate-400 mt-1">دەتوانیت چەندین وێنە بەیەکەوە هەڵبژێریت</div>
        </label>
      </Card>

      {rows.length > 0 && (
        <>
          {dupN > 0 && (
            <Card className="p-4 border-rose-300 bg-rose-50/60">
              <div className="flex items-center gap-2 text-sm text-rose-900 font-semibold">
                <AlertTriangle className="w-4 h-4" /> {dupN} فیشی دووبارە — ناژمێردرێن
              </div>
            </Card>
          )}
          {errN > 0 && (
            <Card className="p-4 border-amber-300 bg-amber-50/60">
              <div className="text-sm text-amber-900">
                <div className="font-semibold mb-1">{errN} فیش نەخوێندرایەوە:</div>
                {[...new Set(rows.filter((r) => r.status === "error").map((r) => r.note))].map((n, i) => <div key={i} className="text-xs">• {n}</div>)}
              </div>
            </Card>
          )}

          <Card className="p-4 space-y-2">
            {rows.map((r, i) => (
              <div key={r.id} className={`flex items-center gap-3 p-2.5 rounded-xl ${r.status === "dup" ? "bg-rose-50" : r.status === "suspect" ? "bg-amber-50" : "bg-stone-50"}`}>
                <span className="text-xs text-slate-400 w-5" style={num}>{i + 1}</span>
                {r.url ? <img src={r.url} alt="" className="w-11 h-11 object-cover rounded-lg border border-stone-200" /> : <div className="w-11 h-11 bg-stone-200 rounded-lg" />}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-bold text-slate-900" style={num}>{r.amount ? fmt(r.amount, 0) : "—"}</span>
                    <span className="text-xs text-slate-500">{r.currency || ""}</span>
                    {r.fee > 0 && <span className="text-[11px] text-rose-600" style={num}>فی {fmt(r.fee, 0)} → {fmt(r.net, 0)}</span>}
                  </div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {r.receiver && <>بۆ <b>{r.receiver}</b> · </>}
                    {r.refNo && <span style={num}>{r.refNo}</span>}
                  </div>
                  {r.note && <div className="text-[10px] text-slate-500 mt-0.5">{r.note}</div>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Pill tone={ST[r.status].tone}>{ST[r.status].t}</Pill>
                  <button onClick={() => setRows(rows.filter((x) => x.id !== r.id))} className="p-1 text-slate-300 hover:text-rose-700"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
            ))}
          </Card>

          <ReceiptTotals rows={rows} data={data} title="کۆی گشتی" />

          <Btn kind="gold" className="w-full flex items-center justify-center gap-2" onClick={() => setShare(true)}>
            <Share2 className="w-4 h-4" /> ناردنی خشتەی وردەکاری
          </Btn>
          {share && (
            <ShareTable rows={rows} data={data} who={customerName} title="وردەکاری فیشەکان"
              flash={flash} onClose={() => setShare(false)} />
          )}

          <RejectedReceipts rows={rows} title="ئەمانە هەژمار ناکرێن" />

          <Btn className="w-full" onClick={send} disabled={sending || (!good.length && !bad.length)}>
            {sending ? "ناردن..." : `ناردنی ${good.length} فیش${bad.length ? ` (+ ${bad.length} ڕەتکراو)` : ""}`}
          </Btn>
        </>
      )}
    </div>
  );
}

/* ─────────── ناوەندی فیشەکان (ئەدمین) ─────────── */
function ReceiptsHub({ data, usr, batches, reloadBatches, flash, onMakeTx, profile, calc, cur }) {
  const [tab, setTab] = useState("inbox");
  const [sel, setSel] = useState(null);
  const [loc, setLoc] = useState("me");
  const [addFor, setAddFor] = useState("");
  const [addDir, setAddDir] = useState("in");
  const customers = data.users.filter((u) => u.role === "customer" && !u.deleted);
  const partners = data.users.filter((u) => u.role === "partner" && !u.deleted);
  const u = usdConv(data);

  if (sel) return <BatchDetail id={sel} back={() => { setSel(null); reloadBatches(); }} usr={usr} data={data} onMakeTx={onMakeTx} flash={flash} reloadBatches={reloadBatches} />;

  const newN = (batches || []).filter((b) => b.status === "new").length;
  const inbox = (batches || []).filter((b) => (tab === "inbox" ? b.status === "new" : b.status !== "new"));

  const waN = (batches || []).filter((b) => b.status === "new" && b.source === "whatsapp").length;
  const TABS = [["inbox", `ئینباکس (${newN})`], ["done", "بەستراوەکان"], ["loc", "لای کێ"], ["add", "ناردنی فیش"], ["wa", "واتساپ"]];

  return (
    <div className="space-y-4">
      <H sub="فیشەکانی کڕیاران و هاوبەشان — پشکنین، کۆکردنەوە، و بەستنەوە بە مامەڵەوە">فیشەکان</H>

      <div className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1 overflow-x-auto">
        {TABS.map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-1 whitespace-nowrap px-3 py-2.5 rounded-lg text-sm ${tab === k ? "bg-emerald-700 text-white font-semibold" : "text-slate-600 hover:bg-stone-100"}`}>{t}</button>
        ))}
      </div>

      {(tab === "inbox" || tab === "done") && (
        inbox.length === 0 ? <Card><Empty t={tab === "inbox" ? "هیچ کۆمەڵەیەکی نوێ نییە" : "هیچ نییە"} /></Card> :
          inbox.map((b, i) => (
            <Card key={b.id} className="p-4 fade-up" style={{ animationDelay: `${i * 40}ms` }} onClick={() => setSel(b.id)}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-slate-800">{b.customer_name || (b.partner_id ? usr(b.partner_id).name : "—")}</div>
                  <div className="text-xs text-slate-500 mt-0.5" style={num}>{b.n} فیش · {new Date(b.created_at).toLocaleString("en-GB")}</div>
                  <div className="flex gap-1.5 mt-1.5 flex-wrap">
                    {b.source === "whatsapp" && (
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-600 text-white flex items-center gap-1">
                        <MessageCircle className="w-3 h-3" /> واتساپ
                      </span>
                    )}
                    <Pill tone={b.direction === "out" ? "amber" : "green"}>{DIR_KU[b.direction || "in"]}</Pill>
                    {b.status === "new" ? <Pill tone="green">نوێ</Pill> : <Pill tone="slate">بەستراوە</Pill>}
                    {(b.rejected_n || b.dup_n) > 0 && <Pill tone="red">{b.rejected_n || b.dup_n} ڕەتکراو</Pill>}
                    {b.partner_id && <Pill tone="amber">لای {usr(b.partner_id).name}</Pill>}
                  </div>
                </div>
                <div className="text-left shrink-0">
                  <div className="text-xl font-bold text-emerald-700" style={num}>{fmt(b.total_net, 0)}</div>
                  <div className="text-[11px] text-slate-400">{b.currency} بێ فی</div>
                  {u(b.total_net, b.currency) != null && <div className="text-[11px] text-slate-500" style={num}>≈ {fmt(u(b.total_net, b.currency), 0)} $</div>}
                  {b.total_fee > 0 && <div className="text-[10px] text-slate-400" style={num}>بە فی {fmt(b.total_gross, 0)}</div>}
                </div>
              </div>
            </Card>
          ))
      )}

      {tab === "loc" && (
        <>
          <div className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1 overflow-x-auto">
            <button onClick={() => setLoc("me")}
              className={`whitespace-nowrap px-4 py-2 rounded-lg text-sm ${loc === "me" ? "bg-slate-900 text-white font-semibold" : "text-slate-600"}`}>لای خۆم</button>
            {partners.map((p) => (
              <button key={p.id} onClick={() => setLoc(p.id)}
                className={`whitespace-nowrap px-4 py-2 rounded-lg text-sm ${loc === p.id ? "bg-emerald-700 text-white font-semibold" : "text-slate-600"}`}>{p.name}</button>
            ))}
          </div>
          <LocationReceipts partnerId={loc === "me" ? null : loc} data={data} flash={flash}
            title={loc === "me" ? "فیشەکانی لای خۆم" : `فیشەکانی لای ${usr(loc).name}`} />
        </>
      )}

      {tab === "wa" && <WhatsAppInfo batches={batches} waN={waN} />}

      {tab === "add" && (
        <Card className="p-5">
          <SecLbl>ناردنی فیش لە جیاتی کەسێک</SecLbl>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <div>
              <Lbl>کڕیار</Lbl>
              <Sel value={addFor} onChange={(e) => setAddFor(e.target.value)}>
                <option value="">هەڵبژێرە...</option>
                {customers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Sel>
            </div>
          </div>
          {addFor && (
            <ReceiptUploader customerId={addFor} customerName={usr(addFor).name} uploaderId={profile?.id}
              data={data} direction={addDir} allowDirection flash={flash}
              onDone={() => { setAddFor(""); reloadBatches(); setTab("inbox"); }} />
          )}
        </Card>
      )}
    </div>
  );
}

/* ─────────── خشتەی وردەکاری بۆ ناردن ─────────── */
function ShareTable({ rows, data, who, title, onClose, flash }) {
  const [mode, setMode] = useState("full");
  const [phone, setPhone] = useState("");
  const u = usdConv(data);
  const today = new Date().toLocaleDateString("en-GB");

  const counted = (rows || []).filter((r) => r.counted !== false && r.status !== "dup" && r.status !== "error");
  const rejected = (rows || []).filter((r) => r.counted === false || r.status === "dup" || r.status === "error");

  const gross = {}, fees = {}, net = {}, byWho = {}, byPlat = {};
  counted.forEach((r) => {
    const c = r.currency || "?";
    const g = +(r.amount) || 0, f = +(r.fee) || 0;
    const n = r.net != null ? +r.net : (r.net_amount != null ? +r.net_amount : g - f);
    gross[c] = (gross[c] || 0) + g; fees[c] = (fees[c] || 0) + f; net[c] = (net[c] || 0) + n;
    const k = (r.receiver || r.sender || "نەزانراو").trim();
    byWho[k] = byWho[k] || { n: 0, cur: {} };
    byWho[k].n++; byWho[k].cur[c] = (byWho[k].cur[c] || 0) + n;
    const pl = r.platform || detectPlatform(r.bank) || "نەزانراو";
    byPlat[pl] = byPlat[pl] || { n: 0, cur: {} };
    byPlat[pl].n++; byPlat[pl].cur[c] = (byPlat[pl].cur[c] || 0) + n;
  });
  const curs = Object.keys(gross);
  const whoList = Object.entries(byWho).sort((a, b) => b[1].n - a[1].n);
  const platList = Object.entries(byPlat).sort((a, b) => b[1].n - a[1].n);

  /* ── دەقی واتساپ ── */
  const text = (() => {
    const L = [];
    L.push(`*${title || "وردەکاری فیشەکان"}*`);
    if (who) L.push(`👤 ${who}`);
    L.push(`📅 ${today}`);
    L.push("");

    if (mode === "rej") {
      L.push(`⚠️ *${rejected.length} فیش ڕەت کراوەتەوە*`);
      L.push("");
      rejected.forEach((r, i) => {
        const amt = r.amount ? `${fmt(r.net_amount ?? r.net ?? r.amount, 0)} ${r.currency || ""}` : "—";
        L.push(`${i + 1}. ${amt}`);
        L.push(`   ❌ ${r.reject_reason || r.rejectReason || r.note || "نەزانراو"}`);
        const bits = [];
        if (r.ref_no || r.refNo) bits.push(`ژمارە: ${r.ref_no || r.refNo}`);
        if (r.tx_time || r.txTime) bits.push(`کات: ${r.tx_time || r.txTime}`);
        if (bits.length) L.push(`   ${bits.join(" · ")}`);
        const od = r.dup_of_date || r.dupOfDate;
        if (od) L.push(`   ↩️ ڕەسەنەکەی: ${new Date(od).toLocaleString("en-GB")}${(r.dup_of_who || r.dupOfWho) ? ` — ${r.dup_of_who || r.dupOfWho}` : ""}`);
        L.push("");
      });
      return L.join("\n");
    }

    if (mode !== "short") {
      L.push("```");
      L.push("#   بڕ         فی    گەیشتوو   وەرگر");
      L.push("───────────────────────────────────────");
      counted.forEach((r, i) => {
        const n = r.net != null ? +r.net : (r.net_amount ?? r.amount);
        const num2 = String(i + 1).padEnd(3);
        const am = fmt(r.amount, 0).padStart(9);
        const fe = (r.fee ? fmt(r.fee, 0) : "—").padStart(5);
        const nt = fmt(n, 0).padStart(9);
        const rc = String(r.receiver || "—").slice(0, 12);
        L.push(`${num2} ${am} ${fe} ${nt}  ${rc}`);
      });
      L.push("```");
      L.push("");
    }

    if (platList.length > 1) {
      L.push("*بەپێی پلاتفۆرم*");
      platList.forEach(([pl, v]) => {
        const t = Object.entries(v.cur).map(([c, a]) => `${fmt(a, 0)} ${c}`).join(" / ");
        L.push(`• ${platMeta(pl).ku}: ${t}  (${v.n})`);
      });
      L.push("");
    }

    L.push("*بەپێی وەرگر*");
    whoList.forEach(([n, v]) => {
      const t = Object.entries(v.cur).map(([c, a]) => `${fmt(a, 0)} ${c}`).join(" / ");
      L.push(`• ${n}: ${t}  (${v.n})`);
    });
    L.push("");

    L.push("*کۆی گشتی*");
    curs.forEach((c) => {
      L.push(`${c}:`);
      L.push(`   بە فییەوە: ${fmt(gross[c], 0)}`);
      if (fees[c] > 0) L.push(`   فی: −${fmt(fees[c], 0)}`);
      L.push(`   ✅ گەیشتوو: ${fmt(net[c], 0)}`);
      const usd = u(net[c], c);
      if (usd != null) L.push(`   ≈ ${fmt(usd, 0)} USD`);
    });
    L.push("");
    L.push(`📄 ${counted.length} فیش هەژمار کراوە`);

    if (rejected.length) {
      L.push("");
      L.push(`⚠️ *${rejected.length} فیش ڕەت کراوەتەوە — هەژمار نەکراون*`);
      L.push("");
      rejected.forEach((r, i) => {
        const amt = r.amount ? `${fmt(r.net_amount ?? r.net ?? r.amount, 0)} ${r.currency || ""}` : "—";
        L.push(`${i + 1}. ${amt}`);
        L.push(`   ❌ ${r.reject_reason || r.rejectReason || r.note || REJECT_KU[r.reject_code || r.rejectCode] || "نەزانراو"}`);
        const bits = [];
        if (r.ref_no || r.refNo) bits.push(`ژمارە: ${r.ref_no || r.refNo}`);
        if (r.tx_time || r.txTime) bits.push(`کات: ${r.tx_time || r.txTime}`);
        if (r.receiver) bits.push(`وەرگر: ${r.receiver}`);
        if (bits.length) L.push(`   ${bits.join(" · ")}`);
        const od = r.dup_of_date || r.dupOfDate;
        if (od) L.push(`   ↩️ ڕەسەنەکەی: ${new Date(od).toLocaleString("en-GB")}${(r.dup_of_who || r.dupOfWho) ? ` — ${r.dup_of_who || r.dupOfWho}` : ""}`);
      });
    }
    return L.join("\n");
  })();

  const cleanPhone = (p) => {
    let x = String(p).replace(/\D/g, "");
    if (x.startsWith("00")) x = x.slice(2);
    if (x.startsWith("0")) x = "964" + x.slice(1);       // عێراق
    return x;
  };

  const sendWa = () => {
    const p = cleanPhone(phone);
    const url = p
      ? `https://wa.me/${p}?text=${encodeURIComponent(text)}`
      : `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank");
  };
  const copy = () => navigator.clipboard.writeText(text).then(() => flash("کۆپی کرا ✓"));

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-end md:items-center justify-center md:p-6" onClick={onClose}>
      <div className="bg-white w-full max-w-lg rounded-t-3xl md:rounded-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-stone-200 px-5 py-3.5 flex items-center justify-between">
          <div className="font-bold text-slate-900">ناردنی خشتە</div>
          <button onClick={onClose} className="p-1.5 text-slate-400"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex gap-1 bg-stone-100 rounded-xl p-1">
            {[["full", "خشتەی تەواو"], ["short", "تەنها کۆکان"], ["rej", "تەنها ڕەتکراوەکان"]].map(([k, t]) => (
              <button key={k} onClick={() => setMode(k)}
                className={`flex-1 py-2 rounded-lg text-sm ${mode === k ? "bg-white text-emerald-700 font-bold shadow-sm" : "text-slate-500"}`}>{t}</button>
            ))}
          </div>

          {/* پێشبینین */}
          <div className="border border-stone-200 rounded-2xl overflow-hidden">
            <div className="bg-slate-900 text-white px-4 py-3">
              <div className="font-bold">{title || "وردەکاری فیشەکان"}</div>
              <div className="text-xs text-slate-400 mt-0.5">{who ? `${who} · ` : ""}<span style={num}>{today}</span></div>
            </div>
            <div className="p-4 space-y-3">
              {mode === "full" && counted.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-slate-400 border-b border-stone-200">
                        <th className="text-right py-1.5 w-6">#</th>
                        <th className="text-right">بڕ</th>
                        <th className="text-right">فی</th>
                        <th className="text-right">گەیشتوو</th>
                        <th className="text-right">وەرگر</th>
                      </tr>
                    </thead>
                    <tbody>
                      {counted.map((r, i) => (
                        <tr key={r.id || i} className="border-b border-stone-50">
                          <td className="py-1.5 text-slate-400" style={num}>{i + 1}</td>
                          <td style={num}>{fmt(r.amount, 0)}</td>
                          <td style={num} className={r.fee ? "text-rose-600" : "text-slate-300"}>{r.fee ? fmt(r.fee, 0) : "—"}</td>
                          <td style={num} className="font-bold">{fmt(r.net ?? r.net_amount ?? r.amount, 0)}</td>
                          <td className="text-slate-600 truncate max-w-[80px]">{r.receiver || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {platList.length > 1 && (
                <div>
                  <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">بەپێی پلاتفۆرم</div>
                  {platList.map(([pl, v]) => (
                    <div key={pl} className="flex justify-between text-xs py-1">
                      <span className="text-slate-600">{platMeta(pl).ku} <span className="text-slate-300">({v.n})</span></span>
                      <span className="font-bold" style={num}>{Object.entries(v.cur).map(([c, a]) => `${fmt(a, 0)} ${c}`).join(" / ")}</span>
                    </div>
                  ))}
                </div>
              )}

              <div>
                <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">بەپێی وەرگر</div>
                {whoList.map(([n, v]) => (
                  <div key={n} className="flex justify-between text-xs py-1">
                    <span className="text-slate-600">{n} <span className="text-slate-300">({v.n})</span></span>
                    <span className="font-bold" style={num}>{Object.entries(v.cur).map(([c, a]) => `${fmt(a, 0)} ${c}`).join(" / ")}</span>
                  </div>
                ))}
              </div>

              {curs.map((c) => (
                <div key={c} className="bg-stone-50 rounded-xl p-3">
                  <div className="text-[10px] font-bold text-slate-400 mb-1">{c}</div>
                  <div className="flex justify-between text-xs py-0.5"><span className="text-slate-600">بە فییەوە</span><span style={num}>{fmt(gross[c], 0)}</span></div>
                  {fees[c] > 0 && <div className="flex justify-between text-xs py-0.5"><span className="text-slate-600">فی</span><span style={num} className="text-rose-700">−{fmt(fees[c], 0)}</span></div>}
                  <div className="flex justify-between pt-1.5 mt-1 border-t border-stone-200 items-baseline">
                    <span className="text-xs font-bold">گەیشتوو</span>
                    <div className="text-left">
                      <div className="text-lg font-bold text-emerald-700" style={num}>{fmt(net[c], 0)}</div>
                      {u(net[c], c) != null && <div className="text-[10px] text-slate-400" style={num}>≈ {fmt(u(net[c], c), 0)} $</div>}
                    </div>
                  </div>
                </div>
              ))}

              <div className="text-[11px] text-slate-400" style={num}>{counted.length} فیش هەژمار کراوە</div>

              {rejected.length > 0 && (
                <div className="border border-rose-200 bg-rose-50/60 rounded-xl p-3 mt-2">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-rose-900 mb-2">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {rejected.length} فیش ڕەت کراوەتەوە — هەژمار نەکراون
                  </div>
                  <div className="space-y-2">
                    {rejected.map((r, i) => (
                      <div key={r.id || i} className="bg-white rounded-lg p-2.5">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[10px] text-slate-400" style={num}>{i + 1}.</span>
                          <span className="text-sm font-bold text-slate-400 line-through" style={num}>
                            {r.amount ? fmt(r.net_amount ?? r.net ?? r.amount, 0) : "—"}
                          </span>
                          <span className="text-[10px] text-slate-400">{r.currency || ""}</span>
                        </div>
                        <div className="text-[11px] text-rose-800 mt-1 leading-snug">
                          ❌ {r.reject_reason || r.rejectReason || r.note || REJECT_KU[r.reject_code || r.rejectCode] || "نەزانراو"}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-0.5 flex flex-wrap gap-x-2" style={num}>
                          {(r.ref_no || r.refNo) && <span>ژمارە {r.ref_no || r.refNo}</span>}
                          {(r.tx_time || r.txTime) && <span>· {r.tx_time || r.txTime}</span>}
                          {r.receiver && <span>· {r.receiver}</span>}
                        </div>
                        {(r.dup_of_date || r.dupOfDate) && (
                          <div className="text-[10px] text-slate-500 mt-1 bg-stone-50 rounded px-1.5 py-1" style={num}>
                            ↩️ ڕەسەنەکەی: {new Date(r.dup_of_date || r.dupOfDate).toLocaleString("en-GB")}
                            {(r.dup_of_who || r.dupOfWho) && ` — ${r.dup_of_who || r.dupOfWho}`}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ناردن */}
          <div>
            <Lbl>ژمارەی واتساپ (ئارەزوومەندانە)</Lbl>
            <Inp type="tel" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07701234567" />
            <div className="text-[11px] text-slate-400 mt-1">بەتاڵی بهێڵەرەوە بۆ هەڵبژاردنی کەس لە واتساپ</div>
          </div>

          <div className="flex gap-2">
            <Btn className="flex-1 flex items-center justify-center gap-1.5" onClick={sendWa}>
              <MessageCircle className="w-4 h-4" /> ناردن بە واتساپ
            </Btn>
            <Btn kind="ghost" className="flex-1" onClick={copy}>کۆپیکردن</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────── ڕێنمایی واتساپ ─────────── */
function WhatsAppInfo({ batches, waN }) {
  const wa = (batches || []).filter((b) => b.source === "whatsapp");
  const today = new Date().toISOString().slice(0, 10);
  const todayN = wa.filter((b) => (b.created_at || "").slice(0, 10) === today).length;
  return (
    <div className="space-y-4">
      <Card className="p-5 bg-emerald-600 border-emerald-600 text-white">
        <div className="flex items-center gap-2.5 mb-3">
          <MessageCircle className="w-6 h-6" />
          <div className="font-bold">وەرگرتنی فیش لە واتساپەوە</div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-[11px] text-emerald-100">کۆی کۆمەڵەکان</div>
            <div className="text-2xl font-bold" style={num}>{wa.length}</div>
          </div>
          <div>
            <div className="text-[11px] text-emerald-100">ئەمڕۆ</div>
            <div className="text-2xl font-bold" style={num}>{todayN}</div>
          </div>
          <div>
            <div className="text-[11px] text-emerald-100">چاوەڕوان</div>
            <div className="text-2xl font-bold" style={num}>{waN}</div>
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <SecLbl>چۆن کار دەکات</SecLbl>
        <div className="space-y-3 text-sm text-slate-600 leading-relaxed">
          <div className="flex gap-3">
            <span className="w-6 h-6 rounded-full bg-emerald-700 text-white flex items-center justify-center text-xs font-bold shrink-0">١</span>
            <span>کڕیار فیشەکان لە واتساپەوە <b>فۆرۆرد</b> دەکات بۆ ژمارەی کۆمپانیاکە</span>
          </div>
          <div className="flex gap-3">
            <span className="w-6 h-6 rounded-full bg-emerald-700 text-white flex items-center justify-center text-xs font-bold shrink-0">٢</span>
            <span>سیستەمەکە خۆکار وێنەکان دەخوێنێتەوە و دووبارەکان دەدۆزێتەوە</span>
          </div>
          <div className="flex gap-3">
            <span className="w-6 h-6 rounded-full bg-emerald-700 text-white flex items-center justify-center text-xs font-bold shrink-0">٣</span>
            <span>کۆمەڵەیەکی نوێ لە <b>ئینباکس</b> دەردەکەوێت — تۆ تەنها مامەڵەکەی لێ درووست دەکەیت</span>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-stone-100 text-xs text-slate-500 leading-relaxed">
          <b className="text-slate-700">تێبینی:</b> فیشەکان کە بە ماوەی ١٥ خولەک بنێردرێن، هەموویان لە یەک کۆمەڵەدا کۆدەبنەوە.
          کڕیارەکە بە ژمارەی مۆبایلەکەی دەناسرێتەوە — بۆیە دڵنیابە ژمارەکەی لە ئەکاونتەکەیدا دروستە.
        </div>
      </Card>

      <Card className="p-4 bg-stone-50/60">
        <div className="text-xs text-slate-500 leading-relaxed">
          <b className="text-slate-700">نرخ:</b> وەرگرتنی نامە لە کڕیارەکانەوە <b>بەخۆڕاییە</b> — تەنها ئەگەر تۆ وەڵامیان بدەیتەوە پارەی لەسەرە.
          سیستەمەکە بە شێوەی بنەڕەت وەڵام نادات.
        </div>
      </Card>
    </div>
  );
}

/* ─────────── فیشەکانی شوێنێک (لای خۆم یان لای هاوبەشێک) ─────────── */
function LocationReceipts({ partnerId, data, title, flash }) {
  const [recs, setRecs] = useState(null);
  const [mode, setMode] = useState("month");
  const [dir, setDir] = useState("all");
  const [share, setShare] = useState(false);

  useEffect(() => {
    (async () => {
      setRecs(null);
      // ١) فیشە دابەشکراوەکان (partner_id لەسەر خودی فیشەکە)
      let direct = [];
      try {
        const q1 = partnerId
          ? supabase.from("receipts").select("*").eq("partner_id", partnerId)
          : supabase.from("receipts").select("*").is("partner_id", null);
        const { data: d1 } = await q1;
        direct = d1 || [];
      } catch {}
      // ٢) کۆمەڵەکانی ئەم شوێنە
      let q = supabase.from("receipt_batches").select("id, customer_name, partner_id");
      q = partnerId ? q.eq("partner_id", partnerId) : q.is("partner_id", null);
      const { data: bs } = await q;
      const names = Object.fromEntries((bs || []).map((x) => [x.id, x.customer_name]));
      let fromBatch = [];
      if (bs?.length) {
        const { data: rs } = await supabase.from("receipts").select("*").in("batch_id", bs.map((x) => x.id));
        // ئەوانەی خۆیان partner_id ـی جیایان هەیە، لێرە نایەن
        fromBatch = (rs || []).filter((r) => !r.partner_id || r.partner_id === (partnerId || null));
      }
      const seen = new Set();
      const merged = [...direct, ...fromBatch].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      setRecs(merged.map((r) => ({ ...r, customer_name: r.customer_name || names[r.batch_id] })));
    })();
  }, [partnerId]);

  if (recs === null) return <Card><Empty t="بارکردن..." /></Card>;

  const t = new Date(), iso = (d) => d.toISOString().slice(0, 10);
  const w = new Date(t); w.setDate(w.getDate() - w.getDay());
  const m = new Date(t.getFullYear(), t.getMonth(), 1);
  const y = new Date(t.getFullYear(), 0, 1);
  const from = mode === "day" ? iso(t) : mode === "week" ? iso(w) : mode === "month" ? iso(m) : mode === "year" ? iso(y) : "0000-01-01";
  let list = recs.filter((r) => ((r.tx_date || r.created_at || "").slice(0, 10)) >= from);
  if (dir !== "all") list = list.filter((r) => (r.direction || "in") === dir);

  return (
    <div className="space-y-3">
      {title && <div className="font-bold text-slate-900">{title}</div>}
      <div className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1 overflow-x-auto">
        {[["day", "ئەمڕۆ"], ["week", "هەفتە"], ["month", "مانگ"], ["year", "ساڵ"], ["all", "هەمووی"]].map(([k, lbl]) => (
          <button key={k} onClick={() => setMode(k)}
            className={`flex-1 whitespace-nowrap py-2.5 px-3 rounded-lg text-sm ${mode === k ? "bg-emerald-700 text-white font-semibold" : "text-slate-600"}`}>{lbl}</button>
        ))}
      </div>
      <div className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1">
        {[["all", "هەمووی"], ["in", "هاتوو"], ["out", "نێردراو"]].map(([k, lbl]) => (
          <button key={k} onClick={() => setDir(k)}
            className={`flex-1 py-2 rounded-lg text-sm ${dir === k ? "bg-slate-900 text-white font-semibold" : "text-slate-600"}`}>{lbl}</button>
        ))}
      </div>
      <ReceiptTotals rows={list} data={data} />

      <Btn kind="gold" className="w-full flex items-center justify-center gap-2" onClick={() => setShare(true)}>
        <Share2 className="w-4 h-4" /> ناردنی خشتەی وردەکاری
      </Btn>
      {share && (
        <ShareTable rows={list} data={data} title={title || "فیشەکان"}
          flash={flash} onClose={() => setShare(false)} />
      )}

      <RejectedReceipts rows={list} />
      <ReceiptList rows={list} showFrom />
    </div>
  );
}

/* ─────────── وردەکاری کۆمەڵەیەک ─────────── */
function BatchDetail({ id, back, usr, data, onMakeTx, flash, reloadBatches }) {
  const [b, setB] = useState(null);
  const [recs, setRecs] = useState(null);
  const [split, setSplit] = useState(false);
  const [share, setShare] = useState(false);
  const [pick, setPick] = useState({});        // {receiptId: partnerId|""}
  const [saving, setSaving] = useState(false);
  const partners = data.users.filter((u) => u.role === "partner" && !u.deleted);

  const load = async () => {
    const [bb, rr] = await Promise.all([
      supabase.from("receipt_batches").select("*").eq("id", id).single(),
      supabase.from("receipts").select("*").eq("batch_id", id).order("created_at"),
    ]);
    setB(bb.data || null); setRecs(rr.data || []);
    setPick(Object.fromEntries((rr.data || []).map((r) => [r.id, r.partner_id || ""])));
  };
  useEffect(() => { load(); }, [id]);

  if (!b || !recs) return <Card><Empty t="بارکردن..." /></Card>;
  const good = recs.filter((r) => r.counted !== false && r.status !== "dup" && r.status !== "error");
  const isOut = (b.direction || "in") === "out";

  // گروپکردن بەپێی هاوبەش
  const groups = {};
  good.forEach((r) => {
    const k = pick[r.id] || "";
    groups[k] = groups[k] || { rows: [], n: 0 };
    groups[k].rows.push(r); groups[k].n++;
  });
  const groupKeys = Object.keys(groups);

  const saveSplit = async () => {
    setSaving(true);
    try {
      for (const r of good) {
        const p = pick[r.id] || null;
        if ((r.partner_id || null) !== p) {
          const e = await supabase.from("receipts").update({ partner_id: p }).eq("id", r.id);
          if (e.error) throw e.error;
        }
      }
      flash("دابەشکردن پاشەکەوت کرا ✓");
      setSplit(false); await load(); reloadBatches && reloadBatches();
    } catch (e) { console.error(e); flash("هەڵە لە پاشەکەوتکردن"); }
    finally { setSaving(false); }
  };

  const setAll = (pid) => setPick(Object.fromEntries(good.map((r) => [r.id, pid])));

  return (
    <div className="space-y-4">
      <Back onClick={back} t="گەڕانەوە" />
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold text-slate-900">{b.customer_name || (b.partner_id ? usr(b.partner_id).name : "—")}</h2>
          <div className="text-xs text-slate-500 mt-0.5" style={num}>{new Date(b.created_at).toLocaleString("en-GB")}</div>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <Pill tone={isOut ? "amber" : "green"}>{DIR_KU[b.direction || "in"]}</Pill>
          {b.status === "new" ? <Pill tone="green">چاوەڕوانی مامەڵە</Pill> : <Pill tone="slate">بەستراوە</Pill>}
        </div>
      </div>

      <ReceiptTotals rows={recs} data={data} />

      <Btn kind="gold" className="w-full flex items-center justify-center gap-2" onClick={() => setShare(true)}>
        <Share2 className="w-4 h-4" /> ناردنی خشتەی وردەکاری
      </Btn>
      {share && (
        <ShareTable rows={recs} data={data} who={b.customer_name || (b.partner_id ? usr(b.partner_id).name : "")}
          title="وردەکاری فیشەکان" flash={flash} onClose={() => setShare(false)} />
      )}

      <RejectedReceipts rows={recs} />

      {/* دابەشکردن بەسەر هاوبەشەکان */}
      {b.status === "new" && partners.length > 0 && (
        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <SecLbl>دابەشکردن بەسەر هاوبەشەکان</SecLbl>
            <button onClick={() => setSplit(!split)} className="text-xs font-semibold text-emerald-700">
              {split ? "داخستن" : "دەستکاری"}
            </button>
          </div>

          {!split ? (
            groupKeys.length <= 1 && !groupKeys[0] ? (
              <div className="text-sm text-slate-500">هەموو فیشەکان یەکجار وەردەگیرێن — گەر دەتەوێت بەسەر چەند هاوبەشێک دابەشیان بکەیت، «دەستکاری» لێبدە</div>
            ) : (
              <div className="space-y-2">
                {groupKeys.map((k) => {
                  const g = groups[k];
                  const tot = {};
                  g.rows.forEach((r) => { const c = r.currency || "?"; tot[c] = (tot[c] || 0) + (+(r.net_amount ?? r.amount) || 0); });
                  return (
                    <div key={k || "none"} className="flex items-center justify-between py-2.5 border-b border-stone-100 last:border-0">
                      <div>
                        <div className="font-semibold text-slate-800">{k ? usr(k).name : "قاسەی گشتی (لای خۆم)"}</div>
                        <div className="text-xs text-slate-400" style={num}>{g.n} فیش</div>
                      </div>
                      <div className="text-left">
                        {Object.entries(tot).map(([c, v]) => (
                          <div key={c} className="font-bold text-slate-900" style={num}>{fmt(v, 0)} <span className="text-xs font-normal text-slate-500">{c}</span></div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            <div className="space-y-2.5">
              <div className="flex gap-1.5 flex-wrap mb-2">
                <span className="text-xs text-slate-500 self-center">هەمووی بۆ:</span>
                <button onClick={() => setAll("")} className="px-2.5 py-1 rounded-lg bg-stone-100 hover:bg-stone-200 text-xs font-semibold">قاسەی گشتی</button>
                {partners.map((p) => (
                  <button key={p.id} onClick={() => setAll(p.id)} className="px-2.5 py-1 rounded-lg bg-stone-100 hover:bg-emerald-700 hover:text-white text-xs font-semibold transition">{p.name}</button>
                ))}
              </div>
              {good.map((r, i) => (
                <div key={r.id} className="flex items-center gap-2.5 p-2.5 bg-stone-50 rounded-xl">
                  <span className="text-xs text-slate-400 w-5" style={num}>{i + 1}</span>
                  {r.image_path && <ReceiptImg path={r.image_path} className="w-10 h-10 object-cover rounded-lg border border-stone-200 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-slate-900" style={num}>{fmt(r.net_amount ?? r.amount, 0)} <span className="text-xs font-normal text-slate-500">{r.currency}</span></div>
                    <div className="text-[11px] text-slate-400 truncate">{r.receiver || "—"}</div>
                  </div>
                  <select value={pick[r.id] ?? ""} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}
                    className="border border-stone-300 rounded-lg px-2 py-1.5 text-xs bg-white shrink-0 max-w-[130px]">
                    <option value="">قاسەی گشتی</option>
                    {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              ))}
              <Btn className="w-full" onClick={saveSplit} disabled={saving}>{saving ? "..." : "پاشەکەوتکردنی دابەشکردن"}</Btn>
            </div>
          )}
        </Card>
      )}

      {b.status === "new" && (
        <Card className={`p-5 ${isOut ? "border-rose-300 bg-rose-50/40" : "border-emerald-300 bg-emerald-50/40"}`}>
          {groupKeys.length > 1 ? (
            <>
              <div className="text-sm text-slate-700 mb-3">
                فیشەکان بەسەر <b>{groupKeys.length}</b> شوێندا دابەش کراون — بۆ هەریەکەیان مامەڵەیەکی جیا درووست بکە:
              </div>
              <div className="space-y-2">
                {groupKeys.map((k) => {
                  const g = groups[k];
                  const cu = g.rows[0]?.currency;
                  const tot = g.rows.reduce((s2, r) => s2 + (+(r.net_amount ?? r.amount) || 0), 0);
                  return (
                    <Btn key={k || "none"} kind={isOut ? "danger" : "primary"} className="w-full flex items-center justify-between"
                      onClick={() => onMakeTx({ ...b, total_net: tot, currency: cu, n: g.n, partner_id: k || null, _group: k || null })}>
                      <span>{k ? usr(k).name : "قاسەی گشتی"}</span>
                      <span style={num}>{fmt(tot, 0)} {cu}</span>
                    </Btn>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className={`text-sm mb-3 ${isOut ? "text-rose-900" : "text-emerald-900"}`}>
                {isOut
                  ? <>ئەم بڕە نێردراوە: <b style={num}>{fmt(b.total_net, 0)} {b.currency}</b> — فرۆشتنێکی لێ درووست بکە</>
                  : <>ئەم کەسە ئەم بڕەی ناردووە: <b style={num}>{fmt(b.total_net, 0)} {b.currency}</b> — کڕینێکی لێ درووست بکە</>}
              </div>
              <Btn kind={isOut ? "danger" : "primary"} className="w-full"
                onClick={() => onMakeTx({ ...b, partner_id: groupKeys[0] || null })}>
                {isOut ? "درووستکردنی فرۆشتن لەم فیشانەوە" : "درووستکردنی کڕین لەم فیشانەوە"}
              </Btn>
            </>
          )}
        </Card>
      )}
      {b.tx_id && (
        <Card className="p-4">
          <div className="text-sm text-slate-600">
            بەستراوە بە مامەڵەی <b style={num}>#{(data.txs.find((t) => t.id === b.tx_id) || {}).code || "—"}</b>
          </div>
        </Card>
      )}

      <ReceiptList rows={recs} />
    </div>
  );
}

/* ─────────── ئەرشیفی فیشەکانی کڕیارێک ─────────── */
function ReceiptArchive({ customerId, data, flash }) {
  const [recs, setRecs] = useState(null);
  const [share, setShare] = useState(false);
  const [q, setQ] = useState(""); const [from, setFrom] = useState(""); const [to, setTo] = useState("");

  useEffect(() => {
    supabase.from("receipts").select("*").eq("customer_id", customerId).order("created_at", { ascending: false }).limit(500)
      .then(({ data: d }) => setRecs(d || []));
  }, [customerId]);

  if (!recs) return <Card><Empty t="بارکردن..." /></Card>;
  const list = recs.filter((r) => {
    const d = (r.tx_date || r.created_at || "").slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (!q) return true;
    return `${r.receiver || ""} ${r.sender || ""} ${r.ref_no || ""} ${r.amount || ""} ${r.bank || ""}`.includes(q);
  });

  return (
    <div className="space-y-3">
      <Card className="p-4 space-y-2.5">
        <Inp value={q} onChange={(e) => setQ(e.target.value)} placeholder="گەڕان بە ناو، ژمارەی مامەڵە، بڕ..." />
        <div className="grid grid-cols-2 gap-2.5">
          <div><Lbl>لە</Lbl><Inp type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><Lbl>بۆ</Lbl><Inp type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
      </Card>
      <ReceiptTotals rows={list} data={data} compact />

      <Btn kind="gold" className="w-full flex items-center justify-center gap-2" onClick={() => setShare(true)}>
        <Share2 className="w-4 h-4" /> ناردنی خشتەی وردەکاری
      </Btn>
      {share && <ShareTable rows={list} data={data} title="ئەرشیفی فیشەکان" flash={flash} onClose={() => setShare(false)} />}

      <RejectedReceipts rows={list} />
      <ReceiptList rows={list} />
    </div>
  );
}

/* ─────────── فیشەکانی هاوبەشێک (پۆرتاڵی خۆی) ─────────── */
function PartnerReceipts({ partnerId, data, flash }) {
  return <LocationReceipts partnerId={partnerId} data={data} flash={flash} />;
}

/* کەشف حساب — پوختەی حیسابی کڕیارێک بۆ ناردن */
function Statement({ u, txs, c, cur, onClose, flash }) {
  const today = new Date().toLocaleDateString("en-GB");
  const [mode, setMode] = useState("all");
  const owe = Object.entries(c.owe || {}).filter(([, v]) => v);
  const due = Object.entries(c.due || {}).filter(([, v]) => v);
  // لە ڕوانگەی کڕیارەوە: کڕینی من = فرۆشتنی ئەو
  const filtered = mode === "all" ? txs : txs.filter((t) => (mode === "buy" ? t.type === "sell" : t.type === "buy"));
  const last = filtered.slice(0, 20);
  const MODE_KU = { all: "هەموو مامەڵەکان", buy: "کڕینەکانی ئەو", sell: "فرۆشتنەکانی ئەو" };
  // کۆکردنەوە
  const sums = {};
  filtered.forEach((t) => {
    const k = t.type === "buy" ? "sold" : "bought";      // ئەو فرۆشتوویەتی / کڕیویەتی
    sums[k] = sums[k] || {};
    sums[k][t.curId] = (sums[k][t.curId] || 0) + t.amount;
  });

  const text = (() => {
    const L = ["📄 کەشف حساب", `👤 ${u.name}`, `📅 ${today}`, `📋 ${MODE_KU[mode]}`, ""];
    if (sums.sold) { L.push("── ئەو فرۆشتوویەتی بە من ──"); Object.entries(sums.sold).forEach(([cid, v]) => L.push(`   ${fmt(v, 0)} ${cur(cid).code}`)); L.push(""); }
    if (sums.bought) { L.push("── ئەو کڕیویەتی لە من ──"); Object.entries(sums.bought).forEach(([cid, v]) => L.push(`   ${fmt(v, 0)} ${cur(cid).code}`)); L.push(""); }
    L.push("── دوا مامەڵەکان ──");
    last.forEach((t) => {
      const kind = t.type === "buy" ? "فرۆشتنت" : "کڕینت";
      L.push(`${new Date(t.date).toLocaleDateString("en-GB")} · ${kind} ${fmt(t.amount, 0)} ${cur(t.curId).code} = ${fmt(t.total, 0)} ${cur(t.againstId).code}${t.status === "pending" ? " (چاوەڕوان)" : ""}`);
    });
    L.push("");
    L.push("── حیسابی کۆتایی ──");
    if (owe.length) { L.push("پارەی تۆ لای من:"); owe.forEach(([cid, v]) => L.push(`   ${fmt(v, 0)} ${cur(cid).code}`)); }
    if (due.length) { L.push("قەرزی تۆ:"); due.forEach(([cid, v]) => L.push(`   ${fmt(v, 0)} ${cur(cid).code}`)); }
    if (!owe.length && !due.length) L.push("حیساب پاکە ✅");
    return L.join("\n");
  })();

  const copy = () => navigator.clipboard.writeText(text).then(() => flash("کۆپی کرا ✓"));
  const share = async () => { if (navigator.share) { try { await navigator.share({ text }); } catch {} } else copy(); };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-end md:items-center justify-center md:p-6" onClick={onClose}>
      <div className="bg-white w-full max-w-lg rounded-t-3xl md:rounded-2xl max-h-[88vh] overflow-y-auto" onClick={(ev) => ev.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-stone-200 px-5 py-3.5 flex items-center justify-between">
          <div className="font-bold text-slate-900">کەشف حساب</div>
          <button onClick={onClose} className="p-1.5 text-slate-400"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5">
          <div className="flex gap-1 bg-stone-100 rounded-xl p-1 mb-4">
            {[["all", "هەمووی"], ["buy", "کڕینی ئەو"], ["sell", "فرۆشتنی ئەو"]].map(([k, t]) => (
              <button key={k} onClick={() => setMode(k)}
                className={`flex-1 py-2 rounded-lg text-sm ${mode === k ? "bg-white text-emerald-700 font-bold shadow-sm" : "text-slate-500"}`}>{t}</button>
            ))}
          </div>
          <div className="border border-stone-200 rounded-2xl overflow-hidden">
            <div className="bg-slate-900 text-white px-4 py-3">
              <div className="font-bold">{u.name}</div>
              <div className="text-xs text-slate-400 mt-0.5" style={num}>{today} · {MODE_KU[mode]}</div>
            </div>
            <div className="p-4">
              {(sums.sold || sums.bought) && (
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div className="bg-emerald-50 rounded-xl p-2.5">
                    <div className="text-[10px] text-emerald-800/70">فرۆشتوویەتی بە من</div>
                    {sums.sold ? Object.entries(sums.sold).map(([cid, v]) => (
                      <div key={cid} className="text-sm font-bold text-emerald-800" style={num}>{fmt(v, 0)} {cur(cid).code}</div>
                    )) : <div className="text-sm text-slate-300">—</div>}
                  </div>
                  <div className="bg-rose-50 rounded-xl p-2.5">
                    <div className="text-[10px] text-rose-800/70">کڕیویەتی لە من</div>
                    {sums.bought ? Object.entries(sums.bought).map(([cid, v]) => (
                      <div key={cid} className="text-sm font-bold text-rose-800" style={num}>{fmt(v, 0)} {cur(cid).code}</div>
                    )) : <div className="text-sm text-slate-300">—</div>}
                  </div>
                </div>
              )}
              <div className="text-[11px] font-bold text-slate-400 uppercase mb-2">دوا مامەڵەکان</div>
              {last.length === 0 ? <div className="text-sm text-slate-400">هیچ</div> :
                last.map((t) => (
                  <div key={t.id} className="flex justify-between items-center py-1.5 border-b border-stone-100 last:border-0 text-sm">
                    <span className="text-slate-600">
                      <span style={num} className="text-xs text-slate-400">{new Date(t.date).toLocaleDateString("en-GB")}</span>
                      <span className="mr-2">{t.type === "buy" ? "فرۆشتنت" : "کڕینت"}</span>
                      {t.status === "pending" && <Pill tone="amber">چاوەڕوان</Pill>}
                    </span>
                    <span className="font-bold" style={num}>{fmt(t.amount, 0)} {cur(t.curId).code}</span>
                  </div>
                ))}
              <div className="mt-3 pt-3 border-t border-stone-200 space-y-1.5">
                {owe.map(([cid, v]) => (
                  <div key={cid} className="flex justify-between text-sm">
                    <span className="text-slate-600">پارەی تۆ لای من</span>
                    <span className="font-bold text-rose-700" style={num}>{fmt(v, 0)} {cur(cid).code}</span>
                  </div>
                ))}
                {due.map(([cid, v]) => (
                  <div key={cid} className="flex justify-between text-sm">
                    <span className="text-slate-600">قەرزی تۆ</span>
                    <span className="font-bold text-emerald-700" style={num}>{fmt(v, 0)} {cur(cid).code}</span>
                  </div>
                ))}
                {!owe.length && !due.length && <div className="text-sm text-emerald-700 font-semibold text-center py-1">حیساب پاکە ✅</div>}
              </div>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Btn className="flex-1" onClick={share}>ناردن</Btn>
            <Btn kind="ghost" className="flex-1" onClick={copy}>کۆپیکردن</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════ ناوەندی بەکارهێنەران ══════════════════ */
function PeopleHub(p) {
  const [tab, setTab] = useState("customers");
  const TABS = [["customers", "کڕیاران", Users], ["partners", "هاوبەشان", Handshake], ["investors", "وەبەرهێنەران", TrendingUp],
    ["money", "پارە و گواستنەوە", ArrowLeftRight], ["office", "نووسینگە", Building2], ["manage", "بەڕێوەبردن", UserCog]];
  return (
    <div className="space-y-4">
      <div className="flex gap-1 flex-wrap bg-white border border-stone-200 rounded-2xl p-1.5">
        {TABS.map(([id, t, Ic]) => (
          <button key={id} onClick={() => { setTab(id); p.setDetailId(null); }}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm whitespace-nowrap transition ${tab === id ? "bg-emerald-700 text-white font-semibold shadow-sm" : "text-slate-600 hover:bg-stone-100"}`}>
            <Ic className="w-4 h-4" /> {t}
          </button>
        ))}
      </div>
      {tab === "customers" && <Customers {...p} />}
      {tab === "partners" && <Partners {...p} />}
      {tab === "investors" && <Investors {...p} />}
      {tab === "money" && <AccountMoney {...p} />}
      {tab === "office" && <Office {...p} officeId={(p.data.users.find((x) => x.role === "office" && !x.deleted) || {}).id} />}
      {tab === "manage" && <UsersAdmin {...p} />}
    </div>
  );
}

/* ══════════════════ پارە دانان/دەرهێنان + گواستنەوەی حساب ══════════════════ */
function AccountMoney({ data, cur, usr, accountMove, accountTransfer, flash }) {
  const [mode, setMode] = useState("move");
  const all = data.users.filter((u) => u.role !== "admin" && !u.deleted);
  const [mv, setMv] = useState({ dir: "in", userId: "", curId: data.currencies[0]?.id, amount: "", note: "" });
  const [tr, setTr] = useState({ fromId: "", toId: "", curId: data.currencies[0]?.id, amount: "", note: "" });
  const [hist, setHist] = useState(null);

  const load = async () => {
    try {
      const [m, t] = await Promise.all([
        supabase.from("account_moves").select("*").order("created_at", { ascending: false }).limit(50),
        supabase.from("account_transfers").select("*").order("created_at", { ascending: false }).limit(50),
      ]);
      const rows = [
        ...(m.data || []).map((x) => ({ ...x, kind: "move" })),
        ...(t.data || []).map((x) => ({ ...x, kind: "transfer" })),
      ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 60);
      setHist(rows);
    } catch { setHist([]); }
  };
  useEffect(() => { load(); }, []);

  const roleLbl = (u) => `${u.name} (${ROLE_KU[u.role]})`;

  return (
    <div className="space-y-4">
      <div className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1">
        {[["move", "پارە دانان / دەرهێنان"], ["transfer", "گواستنەوەی حساب"]].map(([k, t]) => (
          <button key={k} onClick={() => setMode(k)}
            className={`flex-1 py-2.5 rounded-lg text-sm ${mode === k ? "bg-emerald-700 text-white font-semibold" : "text-slate-600 hover:bg-stone-100"}`}>{t}</button>
        ))}
      </div>

      {mode === "move" ? (
        <Card className="p-5">
          <SecLbl>پارە داخڵکردن یان دەرهێنان لە حسابی هەر کەسێک</SecLbl>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <Lbl>جۆر</Lbl>
              <Sel value={mv.dir} onChange={(e) => setMv({ ...mv, dir: e.target.value })}>
                <option value="in">وەرگرتن (پارە دێت)</option>
                <option value="out">دان (پارە دەڕوات)</option>
              </Sel>
            </div>
            <div>
              <Lbl>کەس</Lbl>
              <Sel value={mv.userId} onChange={(e) => setMv({ ...mv, userId: e.target.value })}>
                <option value="">هەڵبژێرە...</option>
                {all.map((u) => <option key={u.id} value={u.id}>{roleLbl(u)}</option>)}
              </Sel>
            </div>
            <div><Lbl>دراو</Lbl><Sel value={mv.curId} onChange={(e) => setMv({ ...mv, curId: e.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
            <div><Lbl>بڕ</Lbl><Inp type="number" value={mv.amount} onChange={(e) => setMv({ ...mv, amount: e.target.value })} placeholder="0" /></div>
            <div><Lbl>تێبینی</Lbl><Inp value={mv.note} onChange={(e) => setMv({ ...mv, note: e.target.value })} /></div>
            <div className="flex items-end">
              <Btn className="w-full" onClick={() => { accountMove(mv); setMv({ ...mv, amount: "", note: "" }); setTimeout(load, 1200); }}>تۆمارکردن</Btn>
            </div>
          </div>
          {mv.userId && (
            <div className="text-xs text-slate-500 mt-3 bg-stone-50 rounded-xl p-3">
              {usr(mv.userId).role === "investor" && "سەرمایەی وەبەرهێنەرەکە زیاد/کەم دەکرێت"}
              {usr(mv.userId).role === "partner" && "باڵانسی هاوبەشەکە زیاد/کەم دەکرێت"}
              {usr(mv.userId).role === "customer" && "پارە لە قاسەی گشتی دەچێت یان دێت"}
              {usr(mv.userId).role === "office" && "پارە لە قاسەی گشتی دەچێت یان دێت"}
            </div>
          )}
        </Card>
      ) : (
        <Card className="p-5">
          <SecLbl>گواستنەوەی پارە لە حسابێکەوە بۆ حسابێکی تر</SecLbl>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <Lbl>لە حسابی</Lbl>
              <Sel value={tr.fromId} onChange={(e) => setTr({ ...tr, fromId: e.target.value })}>
                <option value="">هەڵبژێرە...</option>
                {all.map((u) => <option key={u.id} value={u.id}>{roleLbl(u)}</option>)}
              </Sel>
            </div>
            <div>
              <Lbl>بۆ حسابی</Lbl>
              <Sel value={tr.toId} onChange={(e) => setTr({ ...tr, toId: e.target.value })}>
                <option value="">هەڵبژێرە...</option>
                {all.filter((u) => u.id !== tr.fromId).map((u) => <option key={u.id} value={u.id}>{roleLbl(u)}</option>)}
              </Sel>
            </div>
            <div><Lbl>دراو</Lbl><Sel value={tr.curId} onChange={(e) => setTr({ ...tr, curId: e.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
            <div><Lbl>بڕ</Lbl><Inp type="number" value={tr.amount} onChange={(e) => setTr({ ...tr, amount: e.target.value })} placeholder="0" /></div>
            <div><Lbl>تێبینی</Lbl><Inp value={tr.note} onChange={(e) => setTr({ ...tr, note: e.target.value })} /></div>
            <div className="flex items-end">
              <Btn kind="gold" className="w-full" onClick={() => { accountTransfer(tr); setTr({ ...tr, amount: "", note: "" }); setTimeout(load, 1200); }}>گواستنەوە</Btn>
            </div>
          </div>
          {tr.fromId && tr.toId && +tr.amount > 0 && (
            <div className="text-sm text-slate-700 mt-3 bg-emerald-50 border border-emerald-200 rounded-xl p-3">
              <b style={num}>{fmt(+tr.amount, 0)} {cur(tr.curId).code}</b> لە <b>{usr(tr.fromId).name}</b> دەبڕدرێت و دەچێتە حسابی <b>{usr(tr.toId).name}</b>
            </div>
          )}
        </Card>
      )}

      <SecLbl>مێژوو</SecLbl>
      {hist === null ? <Card><Empty t="بارکردن..." /></Card> :
        hist.length === 0 ? (
          <Card className="p-4">
            <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3">
              هێشتا هیچ نییە — ئایا خشتەکانی <b>account_moves</b> و <b>account_transfers</b> درووست کراون؟
            </div>
          </Card>
        ) : hist.map((h) => (
          <Card key={h.id} className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {h.kind === "transfer"
              ? <><Pill tone="amber">گواستنەوە</Pill>
                  <span className="text-slate-700">{h.from_name} <span className="text-slate-300">←</span> {h.to_name}</span></>
              : <><Pill tone={h.dir === "in" ? "green" : "red"}>{h.dir === "in" ? "وەرگرتن" : "دان"}</Pill>
                  <span className="text-slate-700">{h.user_name}</span></>}
            <span className="font-bold" style={num}>{fmt(h.amount, 0)} {cur(h.cur_id).code}</span>
            {h.note && <span className="text-xs text-slate-500">{h.note}</span>}
            <span className="text-[11px] text-slate-400 mr-auto" style={num}>{new Date(h.created_at).toLocaleString("en-GB")}</span>
          </Card>
        ))}
    </div>
  );
}

/* ══════════════════ قاسەی ئەکاونتێک ══════════════════ */
function AccountSafe({ userId, data, calc, cur, usr, accountMove, accountTransfer, flash, compact, readOnly }) {
  const [tab, setTab] = useState("balance");
  const u = usr(userId);
  const bal = calc.acctCash[userId] || {};
  const debt = calc.acctDebt[userId] || {};
  const moves = (data.acct || []).filter((e) => e.userId === userId).slice().reverse();
  const all = data.users.filter((x) => x.role !== "admin" && !x.deleted && x.id !== userId);
  const [mv, setMv] = useState({ dir: "in", curId: data.currencies[0]?.id, amount: "", note: "" });
  const [tr, setTr] = useState({ toId: "", curId: data.currencies[0]?.id, amount: "", note: "" });
  const [q, setQ] = useState("");

  const rows = data.currencies.map((c) => ({ c, v: bal[c.id] || 0 })).filter((r) => r.v || !compact);
  const TY = { deposit: "دانان", withdraw: "دەرهێنان", transfer_in: "هاتووە", transfer_out: "نێردراوە", settle: "حیسابکردنەوە" };

  return (
    <div className="space-y-4">
      <div className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1 overflow-x-auto">
        {(readOnly ? [["balance", "قاسە"], ["hist", "مێژوو"]] : [["balance", "قاسە"], ["move", "زیادکردن / کەمکردن"], ["transfer", "گواستنەوە"], ["hist", "مێژوو"]]).map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-1 whitespace-nowrap px-3 py-2.5 rounded-lg text-sm ${tab === k ? "bg-emerald-700 text-white font-semibold" : "text-slate-600 hover:bg-stone-100"}`}>{t}</button>
        ))}
      </div>

      {tab === "balance" && (
        <div className="grid md:grid-cols-2 gap-4">
          <Card className="p-5">
            <SecLbl>قاسە — پارەی لای من</SecLbl>
            {rows.length === 0 ? <Empty t="بەتاڵە" /> :
              rows.map(({ c, v }) => (
                <div key={c.id} className="flex items-center justify-between py-2.5 border-b border-stone-100 last:border-0">
                  <span className="text-sm text-slate-600 flex items-center gap-2"><CurBadge c={c} size="sm" /> {c.name}</span>
                  <Money v={v} dec={0} />
                </div>
              ))}
            <div className="text-[11px] text-slate-400 mt-3">
              {readOnly ? "بۆ زیادکردن یان دەرهێنانی پارە، پەیوەندی بە نووسینگە بکە" : "پارەی ڕاستەقینەی ئەم کەسە کە لای من دانراوە"}
            </div>
          </Card>

          <Card className="p-5">
            <SecLbl>قەرز — حیسابی مامەڵەکان</SecLbl>
            {data.currencies.filter((c) => debt[c.id]).length === 0 ? <Empty t="حیساب پاکە" /> :
              data.currencies.filter((c) => debt[c.id]).map((c) => {
                const v = debt[c.id];
                return (
                  <div key={c.id} className="flex items-center justify-between py-2.5 border-b border-stone-100 last:border-0">
                    <span className="text-sm text-slate-600 flex items-center gap-2"><CurBadge c={c} size="sm" /> {c.name}</span>
                    <div className="text-left">
                      <Money v={Math.abs(v)} dec={0} />
                      <div className={`text-[10px] font-semibold ${v > 0 ? "text-rose-700" : "text-emerald-700"}`}>
                        {v > 0 ? "قەرزاری ئەوم" : "ئەو قەرزارە"}
                      </div>
                    </div>
                  </div>
                );
              })}
            <div className="text-[11px] text-slate-400 mt-3">لە مامەڵە چاوەڕوانەکانەوە</div>
          </Card>
        </div>
      )}

      {tab === "move" && !readOnly && (
        <Card className="p-5">
          <SecLbl>زیادکردن یان کەمکردنی پارە</SecLbl>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Lbl>جۆر</Lbl>
              <Sel value={mv.dir} onChange={(e) => setMv({ ...mv, dir: e.target.value })}>
                <option value="in">زیادکردن (پارە دەخەمە سەری)</option>
                <option value="out">کەمکردن (پارە دەردەهێنم)</option>
              </Sel>
            </div>
            <div><Lbl>دراو</Lbl><Sel value={mv.curId} onChange={(e) => setMv({ ...mv, curId: e.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
            <div><Lbl>بڕ</Lbl><Inp type="number" value={mv.amount} onChange={(e) => setMv({ ...mv, amount: e.target.value })} placeholder="0" /></div>
            <div><Lbl>تێبینی</Lbl><Inp value={mv.note} onChange={(e) => setMv({ ...mv, note: e.target.value })} /></div>
          </div>
          {+mv.amount > 0 && (
            <div className="mt-3 text-sm bg-stone-50 border border-stone-200 rounded-xl p-3">
              باڵانسی ئێستا <b style={num}>{fmt(bal[mv.curId] || 0, 0)}</b>
              <span className="mx-2 text-slate-300">←</span>
              دوای ئەمە <b style={num} className={mv.dir === "in" ? "text-emerald-700" : "text-rose-700"}>
                {fmt((bal[mv.curId] || 0) + (mv.dir === "in" ? 1 : -1) * Math.round(+mv.amount), 0)}
              </b> {cur(mv.curId).code}
            </div>
          )}
          <Btn className="w-full mt-4" onClick={() => { accountMove({ ...mv, userId }); setMv({ ...mv, amount: "", note: "" }); }}>
            تۆمارکردن
          </Btn>
        </Card>
      )}

      {tab === "transfer" && !readOnly && (
        <Card className="p-5">
          <SecLbl>گواستنەوە بۆ حسابێکی تر</SecLbl>
          <Inp value={q} onChange={(e) => setQ(e.target.value)} placeholder="گەڕان بە ناو یان ژمارە..." className="mb-2" />
          <div className="max-h-40 overflow-y-auto mb-3 space-y-1">
            {all.filter((x) => !q || (x.name || "").includes(q) || (x.phone || "").includes(q)).map((x) => (
              <button key={x.id} onClick={() => setTr({ ...tr, toId: x.id })}
                className={`w-full text-right px-3 py-2 rounded-lg transition ${tr.toId === x.id ? "bg-emerald-700 text-white" : "hover:bg-stone-100"}`}>
                <div className="text-sm font-semibold">{x.name}</div>
                <div className={`text-[10px] ${tr.toId === x.id ? "text-emerald-100" : "text-slate-400"}`}>{ROLE_KU[x.role]}</div>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Lbl>دراو</Lbl><Sel value={tr.curId} onChange={(e) => setTr({ ...tr, curId: e.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
            <div><Lbl>بڕ</Lbl><Inp type="number" value={tr.amount} onChange={(e) => setTr({ ...tr, amount: e.target.value })} placeholder="0" /></div>
          </div>
          {tr.toId && +tr.amount > 0 && (
            <div className="mt-3 text-sm bg-emerald-50 border border-emerald-200 rounded-xl p-3">
              <b style={num}>{fmt(+tr.amount, 0)} {cur(tr.curId).code}</b> لە <b>{u.name}</b> دەبڕدرێت و دەچێتە حسابی <b>{usr(tr.toId).name}</b>
            </div>
          )}
          <Btn kind="gold" className="w-full mt-4" disabled={!tr.toId}
            onClick={() => { accountTransfer({ ...tr, fromId: userId }); setTr({ ...tr, amount: "", note: "" }); }}>
            گواستنەوە
          </Btn>
        </Card>
      )}

      {tab === "hist" && (
        moves.length === 0 ? <Card><Empty t="هیچ جوڵانەوەیەک نییە" /></Card> :
          moves.map((e) => (
            <Card key={e.id} className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <Pill tone={e.amount >= 0 ? "green" : "red"}>{TY[e.type] || e.type}</Pill>
              <span className="font-bold" style={num}>{e.amount >= 0 ? "+" : ""}{fmt(e.amount, 0)} {cur(e.curId).code}</span>
              {e.note && <span className="text-xs text-slate-500">{e.note}</span>}
              <span className="text-[11px] text-slate-400 mr-auto" style={num}>{new Date(e.date).toLocaleString("en-GB")}</span>
            </Card>
          ))
      )}
    </div>
  );
}

/* ══════════════════ کڕیاران ══════════════════ */
function Customers({ data, calc, cur, usr, detailId, setDetailId, onSave, settle, flash, ...rest }) {
  const customers = data.users.filter((u) => u.role === "customer" && !u.deleted);
  const [q, setQ] = useState("");
  if (detailId) return <CustomerDetail id={detailId} back={() => setDetailId(null)} data={data} calc={calc} cur={cur} usr={usr} onSave={onSave} settle={settle} flash={flash} {...rest} />;
  const list = customers.filter((u) => !q || (u.name || "").includes(q) || (u.phone || "").includes(q));
  return (
    <div className="space-y-3">
      <Inp value={q} onChange={(e) => setQ(e.target.value)} placeholder="گەڕان بە ناو یان ژمارە..." />
      {list.length === 0 ? <Card><Empty t="هیچ کڕیارێک نەدۆزرایەوە" /></Card> :
        list.map((u) => {
          const cnt = data.txs.filter((t) => !t.deleted && t.cpId === u.id).length;
          const c = calc.cust[u.id];
          const owe = c ? Object.entries(c.owe).filter(([, v]) => v) : [];
          const due = c ? Object.entries(c.due).filter(([, v]) => v) : [];
          return (
            <Card key={u.id} className="p-4" onClick={() => setDetailId(u.id)}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-slate-800">{u.name}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{cnt} مامەڵە{u.phone && <span style={num}> · {u.phone}</span>}</div>
                </div>
                <div className="text-left shrink-0 space-y-0.5">
                  {owe.map(([cid, v]) => <div key={cid} className="text-xs text-rose-700 font-semibold">قەرزاری ئەوم: <span style={num}>{fmt(v, 0)}</span> {cur(cid).code}</div>)}
                  {due.map(([cid, v]) => <div key={cid} className="text-xs text-emerald-700 font-semibold">لای ئەو: <span style={num}>{fmt(v, 0)}</span> {cur(cid).code}</div>)}
                  {!owe.length && !due.length && <div className="text-xs text-slate-400">حیساب پاکە</div>}
                </div>
              </div>
            </Card>
          );
        })}
    </div>
  );
}

/* دوو قاسەی کڕیار + مێژووی فلتەرکراو */
function CustomerDetail({ id, back, data, calc, cur, usr, onSave, settle, flash, ...rest }) {
  const u = usr(id);
  const [stmt, setStmt] = useState(false);
  const c = calc.cust[id] || { owe: {}, due: {} };
  const base = data.txs.filter((t) => !t.deleted && t.cpId === id).reverse();
  const [list, f, setF] = useTxFilter(base, cur, usr);
  const [tab, setTab] = useState("history");
  return (
    <div className="space-y-4">
      <Back onClick={back} t="گەڕانەوە بۆ لیستی کڕیاران" />
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-slate-900">{u.name}</h2>
          {(u.phone || u.address) && <div className="text-xs text-slate-500 mt-0.5">{u.phone && <span style={num}>{u.phone}</span>}{u.phone && u.address && " · "}{u.address}</div>}
        </div>
        <Btn kind="ghost" className="flex items-center gap-1.5" onClick={() => setStmt(true)}>
          <Share2 className="w-4 h-4" /> کەشف حساب
        </Btn>
      </div>
      {stmt && <Statement u={u} txs={base} c={c} cur={cur} flash={flash} onClose={() => setStmt(false)} />}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card className="p-4 border-rose-200 bg-rose-50/40">
          <div className="text-xs font-semibold text-rose-800 mb-2">پارەی ئەو لای من (قەرزاری ئەوم)</div>
          {Object.entries(c.owe).filter(([, v]) => v).length === 0 ? <div className="text-sm text-slate-400">هیچ</div> :
            Object.entries(c.owe).filter(([, v]) => v).map(([cid, v]) => (
              <div key={cid} className="flex justify-between py-1">
                <span className="text-sm text-slate-600">{cur(cid).name}</span>
                <span className="text-lg font-bold text-rose-700" style={num}>{fmt(v, 0)}</span>
              </div>
            ))}
        </Card>
        <Card className="p-4 border-emerald-200 bg-emerald-50/40">
          <div className="text-xs font-semibold text-emerald-800 mb-2">پارەی من لای ئەو (قەرزارمە)</div>
          {Object.entries(c.due).filter(([, v]) => v).length === 0 ? <div className="text-sm text-slate-400">هیچ</div> :
            Object.entries(c.due).filter(([, v]) => v).map(([cid, v]) => (
              <div key={cid} className="flex justify-between py-1">
                <span className="text-sm text-slate-600">{cur(cid).name}</span>
                <span className="text-lg font-bold text-emerald-700" style={num}>{fmt(v, 0)}</span>
              </div>
            ))}
        </Card>
      </div>

      <div className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1 overflow-x-auto">
        {[["history", "مێژوو"], ["safe", "قاسە"], ["receipts", "فیشەکان"], ["new", "مامەڵەی نوێ"]].map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-1 px-4 py-2.5 rounded-lg text-sm ${tab === k ? "bg-emerald-700 text-white font-semibold" : "text-slate-600 hover:bg-stone-100"}`}>{t}</button>
        ))}
      </div>

      {tab === "safe" ? <AccountSafe userId={id} data={data} calc={calc} cur={cur} usr={usr} flash={flash} {...rest} />
      : tab === "receipts" ? <ReceiptArchive customerId={id} data={data} flash={flash} /> : tab === "new" ? (
        <TxForm data={data} calc={calc} cur={cur} usr={usr} {...rest} onSave={(fm, e) => onSave({ ...fm, cpMode: "acc", cpId: id, cpName: "" }, e)} lockCp={id} />
      ) : (
        <>
          <TxFilterBar data={data} f={f} setF={setF} count={list.length} />
          {list.length === 0 ? <Card><Empty t="هیچ مامەڵەیەک نەدۆزرایەوە" /></Card> :
            list.map((t) => <TxRow key={t.id} t={t} cur={cur} usr={usr} settle={settle} />)}
        </>
      )}
    </div>
  );
}

/* ══════════════════ هاوبەشان ══════════════════ */
function Partners({ data, calc, cur, usr, transfer, detailId, setDetailId }) {
  const partners = data.users.filter((u) => u.role === "partner" && !u.deleted);
  const [tf, setTf] = useState({ partnerId: "", curId: data.currencies[0]?.id, amount: "", dir: "to" });
  const [sel, setSel] = useState(null);
  if (sel) {
    const p = partners.find((x) => x.id === sel);
    return <div className="space-y-4"><Back onClick={() => setSel(null)} t="گەڕانەوە بۆ لیستی هاوبەشان" /><PartnerDetail p={p} data={data} calc={calc} cur={cur} /></div>;
  }
  const fr = tf.partnerId ? (usr(tf.partnerId).rate || 0) : 0;
  return (
    <div className="space-y-3">
      <Card className="p-5">
        <SecLbl>گواستنەوەی پارە</SecLbl>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div><Lbl>ئاڕاستە</Lbl><Sel value={tf.dir} onChange={(e) => setTf({ ...tf, dir: e.target.value })}><option value="to">بۆ لای هاوبەش</option><option value="back">لە لای هاوبەشەوە</option></Sel></div>
          <div><Lbl>هاوبەش</Lbl><Sel value={tf.partnerId} onChange={(e) => setTf({ ...tf, partnerId: e.target.value })}><option value="">—</option>{partners.map((p) => {
            const b = (calc.partner[p.id] || {})[tf.curId] || 0;
            return <option key={p.id} value={p.id}>{p.name} — {fmt(Math.abs(b), cur(tf.curId).dec)}{b < 0 ? " (قەرز)" : ""}</option>;
          })}</Sel></div>
          <div><Lbl>دراو</Lbl><Sel value={tf.curId} onChange={(e) => setTf({ ...tf, curId: e.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
          <div><Lbl>بڕ</Lbl><Inp type="number" value={tf.amount} onChange={(e) => setTf({ ...tf, amount: e.target.value })} placeholder="0" /></div>
          <div className="flex items-end"><Btn kind="gold" className="w-full" onClick={() => { transfer(tf); setTf({ ...tf, amount: "" }); }}>گواستنەوە</Btn></div>
        </div>
        {tf.dir === "to" && fr > 0 && +tf.amount > 0 && (
          <div className="mt-3 text-sm text-slate-600 bg-stone-50 border border-stone-200 rounded-xl p-3">
            عمولەی {fr}٪ = <b style={num}>{fmt(Math.round(Math.round(+tf.amount) * fr / 100), 0)}</b> — باڵانسی دوایی: <b style={num}>{fmt(Math.round(+tf.amount) - Math.round(Math.round(+tf.amount) * fr / 100), 0)}</b>
          </div>
        )}
      </Card>
      {partners.map((p) => {
        const bal = calc.partner[p.id] || {};
        const hasDebt = Object.values(bal).some((v) => v < 0);
        return (
          <Card key={p.id} className="p-4 flex items-center justify-between" onClick={() => setSel(p.id)}>
            <div>
              <div className="font-semibold text-slate-800">{p.name} <span className="text-xs text-slate-400 font-normal">· عمولە {p.rate}٪</span></div>
              <div className="text-xs text-slate-500 mt-0.5">
                {Object.entries(bal).filter(([, v]) => v).map(([cid, v]) => `${fmt(v, cur(cid).dec)} ${cur(cid).code}`).join(" · ") || "بەتاڵ"}
                {hasDebt && <span className="text-rose-700 font-bold"> · قەرز</span>}
              </div>
            </div>
            <ChevronLeft className="w-5 h-5 text-slate-300" />
          </Card>
        );
      })}
    </div>
  );
}

function PartnerDetail({ p, data, calc, cur }) {
  const bal = calc.partner[p.id] || {};
  const fees = {};
  data.ledger.forEach((e) => { if (e.partnerId === p.id && e.type === "partner_fee") fees[e.curId] = (fees[e.curId] || 0) + Math.abs(e.amount); });
  const hist = data.ledger.filter((e) => e.partnerId === p.id).slice().reverse();
  const TY = { buy: "کڕین — دانان", sell: "فرۆشتن لە ئەکاونتەکەی", transfer: "گواستنەوە", partner_fee: "عمولە" };
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-slate-900">{p.name}</h2>
      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-5">
          <SecLbl>باڵانس (سالب = قەرز لەسەر تۆ)</SecLbl>
          {Object.keys(bal).length === 0 ? <Empty t="بەتاڵە" /> :
            Object.entries(bal).map(([cid, v]) => (
              <div key={cid} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
                <span className="text-sm text-slate-600">{cur(cid).name}</span><Money v={v} dec={cur(cid).dec} />
              </div>
            ))}
        </Card>
        <Card className="p-5">
          <SecLbl>عمولەی وەرگیراو ({p.rate}٪)</SecLbl>
          {Object.keys(fees).length === 0 ? <Empty t="هێشتا هیچ" /> :
            Object.entries(fees).map(([cid, v]) => (
              <div key={cid} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
                <span className="text-sm text-slate-600">{cur(cid).name}</span><Money v={v} dec={cur(cid).dec} pos />
              </div>
            ))}
          <div className="text-[11px] text-slate-400 mt-2">دەستبەجێ لە کاتی تێکردندا کەم کراوەتەوە</div>
        </Card>
      </div>
      <SecLbl>مێژووی ئاڵووگۆر ({hist.length})</SecLbl>
      {hist.length === 0 ? <Card><Empty t="هیچ نییە" /></Card> :
        hist.map((e) => (
          <Card key={e.id} className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <Pill tone={e.amount >= 0 ? "green" : "red"}>{e.amount >= 0 ? "هاتنە ژوورەوە" : "چوونە دەرەوە"}</Pill>
            <span><Money v={e.amount} dec={cur(e.curId).dec} /> {cur(e.curId).code}</span>
            <span className="text-slate-500">{TY[e.type] || e.type}</span>
            <span className="text-[11px] text-slate-400 mr-auto" style={num}>{new Date(e.date).toLocaleString("en-GB")}</span>
          </Card>
        ))}
    </div>
  );
}

/* ══════════════════ وەبەرهێنەران ══════════════════ */
function Investors({ data, calc, cur, invUnpaid, invShare, profitAll }) {
  const investors = data.users.filter((u) => u.role === "investor" && !u.deleted);
  const [sel, setSel] = useState(null);
  if (sel) {
    const u = investors.find((x) => x.id === sel);
    return <div className="space-y-4"><Back onClick={() => setSel(null)} t="گەڕانەوە بۆ لیستی وەبەرهێنەران" /><InvestorDetail u={u} data={data} calc={calc} cur={cur} invUnpaid={invUnpaid} invShare={invShare} profitAll={profitAll} /></div>;
  }
  return (
    <div className="space-y-3">
      {investors.length === 0 ? <Card><Empty t="هیچ وەبەرهێنەرێک نییە" /></Card> :
        investors.map((u) => {
          const cap = calc.invCap[u.id] || {};
          return (
            <Card key={u.id} className="p-4 flex items-center justify-between" onClick={() => setSel(u.id)}>
              <div>
                <div className="font-semibold text-slate-800">{u.name} <span className="text-xs text-slate-400 font-normal">· خێر {u.rate}٪</span></div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {Object.entries(cap).filter(([, v]) => v).map(([cid, v]) => `${fmt(v, cur(cid).dec)} ${cur(cid).code}`).join(" · ") || "سەرمایە دانەنراوە"}
                </div>
              </div>
              <ChevronLeft className="w-5 h-5 text-slate-300" />
            </Card>
          );
        })}
    </div>
  );
}

function InvestorDetail({ u, data, calc, cur, invUnpaid, mine }) {
  const cap = calc.invCap[u.id] || {};
  const hist = data.ledger.filter((e) => e.investorId === u.id).slice().reverse();
  const rows = data.currencies.map((c) => {
    const capV = cap[c.id] || 0;
    const up = invUnpaid(u.id, c.id);
    return { c, capV, up, tot: capV + up };
  }).filter((r) => r.capV || r.up);

  return (
    <div className="space-y-4">
      {!mine && <h2 className="text-xl font-bold text-slate-900">{u.name}</h2>}

      {/* کۆی گشتی */}
      <Card dark className="p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs text-slate-400">{mine ? "کۆی ماڵی من" : `کۆی ماڵی ${u.name}`}</div>
          <span className="text-[11px] bg-slate-800 px-2 py-0.5 rounded-full">ڕێژەی خێر {u.rate}٪</span>
        </div>
        {rows.length === 0 ? <div className="text-sm text-slate-400">هێشتا هیچ سەرمایەیەک دانەنراوە</div> :
          rows.map((r) => (
            <div key={r.c.id} className="flex justify-between items-baseline py-2 border-b border-slate-700/60 last:border-0">
              <span className="text-sm text-slate-300">{r.c.name}</span>
              <span className="text-2xl font-bold" style={num}>{fmt(r.tot, 0)}</span>
            </div>
          ))}
        <div className="text-[11px] text-slate-400 mt-3">سەرمایە + خێری نەدراو</div>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-5">
          <SecLbl>{mine ? "سەرمایەکەم" : "سەرمایە"}</SecLbl>
          {rows.filter((r) => r.capV).length === 0 ? <Empty t="سەرمایە دانەنراوە" /> :
            rows.filter((r) => r.capV).map((r) => (
              <div key={r.c.id} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
                <span className="text-sm text-slate-600">{r.c.name}</span><Money v={r.capV} dec={0} />
              </div>
            ))}
        </Card>
        <Card className="p-5">
          <SecLbl>خێری نەدراو</SecLbl>
          {rows.filter((r) => r.up).length === 0 ? <Empty t="هێشتا هیچ" /> :
            rows.filter((r) => r.up).map((r) => (
              <div key={r.c.id} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
                <span className="text-sm text-slate-600">{r.c.name}</span><Money v={r.up} dec={0} pos />
              </div>
            ))}
          <div className="text-[11px] text-slate-400 mt-2">
            {mine ? "ئەمە ئەو خێرەیە کە هێشتا وەرتنەگرتووە" : "لە بەشی «قاسە و خەرجی» دەتوانیت پارەکەی بدەیت"}
          </div>
        </Card>
      </div>

      <SecLbl>مێژووی پارە ({hist.length})</SecLbl>
      {hist.length === 0 ? <Card><Empty t="هیچ نییە" /></Card> :
        hist.map((e) => (
          <Card key={e.id} className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <Pill tone={e.type === "investor_payout" ? "amber" : e.amount >= 0 ? "green" : "red"}>
              {e.type === "investor_payout" ? (mine ? "وەرگرتنی خێر" : "پارەدانی خێر") : e.amount >= 0 ? "پارە دانان" : "پارە دەرهێنان"}
            </Pill>
            <span><Money v={Math.abs(e.amount)} dec={0} /> {cur(e.curId).code}</span>
            <span className="text-[11px] text-slate-400 mr-auto" style={num}>{new Date(e.date).toLocaleString("en-GB")}</span>
          </Card>
        ))}
    </div>
  );
}


/* ══════════════════ نووسینگە ══════════════════ */
function Office({ data, cur, usr, officePay, calc, accountMove, accountTransfer, flash, officeId, readOnlyUser }) {
  const [tab, setTab] = useState("pending");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const pending = data.txs.filter((t) => !t.deleted && t.type === "buy" && t.status === "pending");
  const paid = data.txs.filter((t) => !t.deleted && t.paidAt);

  const t0 = new Date(); const d0 = new Date(t0.toDateString());
  const w0 = new Date(d0); w0.setDate(w0.getDate() - w0.getDay());
  const m0 = new Date(t0.getFullYear(), t0.getMonth(), 1);
  const sums = (fn) => { const m = {}; paid.filter(fn).forEach((t) => (m[t.againstId] = (m[t.againstId] || 0) + t.total)); return m; };
  const S = ({ title, m }) => (
    <Card className="p-4 flex-1 min-w-[150px]">
      <div className="text-xs text-slate-500 mb-1">{title}</div>
      {Object.keys(m).length === 0 ? <div className="text-sm text-slate-400">0</div> :
        Object.entries(m).map(([cid, v]) => <div key={cid} className="text-sm"><Money v={v} dec={0} /> {cur(cid).code}</div>)}
    </Card>
  );

  // مێژووی پارەدانەکان بە گەڕان
  const hist = paid.filter((t) => {
    const d = dOnly(t.paidAt);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (!q) return true;
    const nm = t.cpId ? (usr(t.cpId).name || "") : (t.cpName || "");
    return `${t.code || ""} ${nm} ${cur(t.againstId).code}`.includes(q);
  }).sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));

  const histTot = {};
  hist.forEach((t) => (histTot[t.againstId] = (histTot[t.againstId] || 0) + t.total));

  const TABS = [["pending", `چاوەڕوان (${pending.length})`], ["hist", "مێژووی پارەدان"]];
  if (officeId) TABS.push(["safe", "قاسەی نووسینگە"]);

  return (
    <div className="space-y-4">
      <div className="flex gap-3 flex-wrap">
        <S title="پارەی دراوی ئەمڕۆ" m={sums((t) => new Date(t.paidAt) >= d0)} />
        <S title="ئەم هەفتەیە" m={sums((t) => new Date(t.paidAt) >= w0)} />
        <S title="ئەم مانگە" m={sums((t) => new Date(t.paidAt) >= m0)} />
      </div>

      <div className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1 overflow-x-auto">
        {TABS.map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-1 whitespace-nowrap px-3 py-2.5 rounded-lg text-sm ${tab === k ? "bg-emerald-700 text-white font-semibold" : "text-slate-600 hover:bg-stone-100"}`}>{t}</button>
        ))}
      </div>

      {tab === "pending" && (
        pending.length === 0 ? <Card><Empty t="هیچ مامەڵەیەکی چاوەڕوان نییە ✓" /></Card> :
          pending.map((t) => (
            <Card key={t.id} className="p-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              {t.code && <span className="text-[11px] font-bold text-slate-400 bg-stone-100 px-2 py-0.5 rounded" style={num}>#{t.code}</span>}
              <span className="font-semibold text-slate-800">{t.cpId ? usr(t.cpId).name : t.cpName}</span>
              <span>بدرێتێ: <Money v={t.total} dec={0} /> {cur(t.againstId).code}</span>
              <span className="text-[11px] text-slate-400" style={num}>{new Date(t.date).toLocaleString("en-GB")}</span>
              <Btn className="mr-auto flex items-center gap-1.5" onClick={() => officePay(t)}>
                <CheckCircle2 className="w-4 h-4" /> پارەم دا
              </Btn>
            </Card>
          ))
      )}

      {tab === "hist" && (
        <>
          <Card className="p-4 space-y-2.5">
            <Inp value={q} onChange={(e) => setQ(e.target.value)} placeholder="گەڕان بە ناو یان کۆد..." />
            <div className="grid grid-cols-2 gap-2.5">
              <div><Lbl>لە بەرواری</Lbl><Inp type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
              <div><Lbl>بۆ بەرواری</Lbl><Inp type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            </div>
            <div className="flex gap-1.5 flex-wrap pt-1">
              {[["ئەمڕۆ", 0], ["٧ ڕۆژ", 7], ["٣٠ ڕۆژ", 30]].map(([lbl, dd]) => (
                <button key={lbl} onClick={() => {
                  const x = new Date(); x.setDate(x.getDate() - dd);
                  setFrom(x.toISOString().slice(0, 10)); setTo(new Date().toISOString().slice(0, 10));
                }} className="px-3 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-xs font-semibold text-slate-600">{lbl}</button>
              ))}
              <button onClick={() => { setQ(""); setFrom(""); setTo(""); }}
                className="px-3 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-xs font-semibold text-slate-600">سڕینەوە</button>
            </div>
            <div className="flex gap-4 flex-wrap text-xs text-slate-500 pt-2 border-t border-stone-100">
              <span><b style={num}>{hist.length}</b> پارەدان</span>
              {Object.entries(histTot).map(([cid, v]) => <span key={cid}>{cur(cid).code}: <b style={num}>{fmt(v, 0)}</b></span>)}
            </div>
          </Card>

          {hist.length === 0 ? <Card><Empty t="هیچ نەدۆزرایەوە" /></Card> :
            hist.map((t) => (
              <Card key={t.id} className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                {t.code && <span className="text-[11px] font-bold text-slate-400" style={num}>#{t.code}</span>}
                <Pill tone="green">دراوە</Pill>
                <span className="font-semibold text-slate-800">{t.cpId ? usr(t.cpId).name : t.cpName}</span>
                <span className="font-bold" style={num}>{fmt(t.total, 0)} {cur(t.againstId).code}</span>
                <span className="text-[11px] text-slate-400 mr-auto" style={num}>{new Date(t.paidAt).toLocaleString("en-GB")}</span>
              </Card>
            ))}
        </>
      )}

      {tab === "safe" && officeId && (
        <AccountSafe userId={officeId} data={data} calc={calc} cur={cur} usr={usr}
          accountMove={accountMove} accountTransfer={accountTransfer} flash={flash} readOnly={!!readOnlyUser} />
      )}
    </div>
  );
}


/* ══════════════════ بەڕێوەبردنی ئەکاونت ══════════════════ */
function UsersAdmin({ data, cur, createUser, deleteUser, setUserRate, flash }) {
  const [f, setF] = useState({ name: "", role: "customer", rate: "", scope: [], phone: "", address: "", note: "", password: "" });
  const roles = ["customer", "partner", "investor", "office"];
  const list = data.users.filter((u) => u.role !== "admin" && !u.deleted);
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <SecLbl>درووستکردنی ئەکاونتی نوێ</SecLbl>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div><Lbl>ناوی تەواو *</Lbl><Inp value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><Lbl>ڕۆڵ *</Lbl><Sel value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roles.map((r) => <option key={r} value={r}>{ROLE_KU[r]}</option>)}</Sel></div>
          {(f.role === "partner" || f.role === "investor") && <div><Lbl>{f.role === "partner" ? "ڕێژەی عمولە ٪" : "ڕێژەی خێر ٪"}</Lbl><Inp type="number" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></div>}
          {f.role === "investor" && (
            <div className="col-span-2 md:col-span-3">
              <Lbl>لە کام دراوەکاندا شەریکە؟</Lbl>
              <div className="flex gap-1.5 flex-wrap">
                <button onClick={() => setF({ ...f, scope: [] })}
                  className={`px-3 py-2 rounded-xl text-xs font-semibold border transition ${!f.scope?.length ? "bg-emerald-700 text-white border-emerald-700" : "bg-white border-stone-300 text-slate-600"}`}>
                  هەموو دراوەکان
                </button>
                {data.currencies.map((c) => {
                  const on = (f.scope || []).includes(c.id);
                  return (
                    <button key={c.id} onClick={() => {
                      const sc = new Set(f.scope || []);
                      on ? sc.delete(c.id) : sc.add(c.id);
                      setF({ ...f, scope: [...sc] });
                    }} className={`px-3 py-2 rounded-xl text-xs font-semibold border transition flex items-center gap-1.5 ${on ? "bg-emerald-700 text-white border-emerald-700" : "bg-white border-stone-300 text-slate-600"}`}>
                      <CurBadge c={c} size="sm" /> {c.name}
                    </button>
                  );
                })}
              </div>
              <div className="text-[11px] text-slate-400 mt-1.5">
                {(f.scope || []).length === 0
                  ? "لە خێری هەموو دراوەکاندا بەشی هەیە"
                  : `تەنها لە خێری ${(f.scope || []).map((x) => cur(x).name).join("، ")} بەشی هەیە`}
              </div>
            </div>
          )}
          <div><Lbl>ژمارەی مۆبایل * (لۆگین)</Lbl><Inp type="tel" dir="ltr" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="07701234567" /></div>
          <div><Lbl>وشەی نهێنی * (٦ پیت)</Lbl><Inp type="password" dir="ltr" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="••••••" /></div>
          <div><Lbl>ناونیشان</Lbl><Inp value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></div>
          <div><Lbl>تێبینی</Lbl><Inp value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
        </div>
        <div className="mt-4">
          <Btn className="flex items-center gap-1.5" onClick={() => {
            if (!f.name || !f.phone || !f.password) return flash("ناو، ژمارە، و وشەی نهێنی پێویستن");
            createUser(f); setF({ name: "", role: "customer", rate: "", scope: [], phone: "", address: "", note: "", password: "" });
          }}><Plus className="w-4 h-4" /> درووستکردن</Btn>
        </div>
      </Card>
      {list.map((u) => (
        <Card key={u.id} className="p-4 flex items-center gap-3 flex-wrap">
          <div className="flex-1">
            <div className="font-semibold text-slate-800">{u.name}</div>
            <div className="text-xs text-slate-500 mt-0.5">
              {ROLE_KU[u.role]}{u.phone && <span style={num}> · {u.phone}</span>}{u.address && ` · ${u.address}`}
            </div>
            {u.role === "investor" && (
              <div className="text-[11px] text-emerald-700 mt-0.5">
                {(u.scope || []).length === 0 ? "لە هەموو دراوەکاندا" : `تەنها: ${(u.scope || []).map((x) => cur(x).code).join("، ")}`}
              </div>
            )}
            {u.note && <div className="text-[11px] text-slate-400 mt-0.5">{u.note}</div>}
          </div>
          {(u.role === "partner" || u.role === "investor") && (
            <div className="flex items-center gap-1.5 text-sm">
              <span className="text-slate-500 text-xs">ڕێژە</span>
              <input type="number" defaultValue={u.rate} onBlur={(e) => { if (+e.target.value !== u.rate) setUserRate(u, e.target.value); }}
                className="w-16 border border-stone-300 rounded-lg px-2 py-1 text-sm" style={num} />
              <span className="text-xs">٪</span>
            </div>
          )}
          <button onClick={() => deleteUser(u)} className="text-slate-300 hover:text-rose-700"><Trash2 className="w-4 h-4" /></button>
        </Card>
      ))}
    </div>
  );
}

/* ══════════════════ ڕاپۆرت ══════════════════ */
function Report({ data, calc, cur, usr, profitIn, investorsProfitIn, invShare, sumUsd, toUsd, ratesReady }) {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const [from, setFrom] = useState(iso(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(iso(today));
  const [tab, setTab] = useState("pl");

  const preset = (k) => {
    const t = new Date();
    if (k === "today") { setFrom(iso(t)); setTo(iso(t)); }
    if (k === "week") { const w = new Date(t); w.setDate(w.getDate() - w.getDay()); setFrom(iso(w)); setTo(iso(t)); }
    if (k === "month") { setFrom(iso(new Date(t.getFullYear(), t.getMonth(), 1))); setTo(iso(t)); }
    if (k === "prev") { const a = new Date(t.getFullYear(), t.getMonth() - 1, 1), b = new Date(t.getFullYear(), t.getMonth(), 0); setFrom(iso(a)); setTo(iso(b)); }
    if (k === "year") { setFrom(iso(new Date(t.getFullYear(), 0, 1))); setTo(iso(t)); }
  };

  const inR = (d) => { const x = dOnly(d); return x >= from && x <= to; };
  const txs = data.txs.filter((t) => !t.deleted && inR(t.date));
  const entries = data.ledger.filter((e) => inR(e.date));

  const profit = {}, loss = {};
  txs.forEach((t) => {
    if (t.type === "sell" && t.profit != null) {
      if (t.profit >= 0) profit[t.profitCurId] = (profit[t.profitCurId] || 0) + t.profit;
      else loss[t.profitCurId] = (loss[t.profitCurId] || 0) + Math.abs(t.profit);
    }
  });
  const exp = {}, fee = {}, payout = {}, flow = {};
  entries.forEach((e) => {
    if (e.type === "expense") exp[e.curId] = (exp[e.curId] || 0) + Math.abs(e.amount);
    if (e.type === "partner_fee") fee[e.curId] = (fee[e.curId] || 0) + Math.abs(e.amount);
    if (e.type === "investor_payout") payout[e.curId] = (payout[e.curId] || 0) + Math.abs(e.amount);
    const fl = (flow[e.curId] = flow[e.curId] || { inn: 0, out: 0 });
    if (e.amount >= 0) fl.inn += e.amount; else fl.out += Math.abs(e.amount);
  });
  const vol = {};
  txs.forEach((t) => {
    const v = (vol[t.curId] = vol[t.curId] || { buy: 0, sell: 0, n: 0 });
    if (t.type === "buy") v.buy += t.amount; else v.sell += t.amount; v.n++;
  });
  const pm = profitIn(from, to);
  const invP = investorsProfitIn(pm);
  const net = {};
  data.currencies.forEach((c) => {
    const n = (profit[c.id] || 0) - (loss[c.id] || 0) - (exp[c.id] || 0) - (fee[c.id] || 0) - (invP[c.id] || 0);
    if (n) net[c.id] = n;
  });
  const allCurs = data.currencies.filter((c) => profit[c.id] || loss[c.id] || exp[c.id] || fee[c.id] || payout[c.id] || flow[c.id] || vol[c.id]);
  const investors = data.users.filter((u) => u.role === "investor" && !u.deleted);

  const exportCsv = () => {
    const head = ["کۆد", "جۆر", "بەروار", "لایەن", "دراو", "بڕ", "ڕەیت", "بەرامبەر", "کۆ", "شوێن", "دۆخ", "خێر"];
    const rows = txs.map((t) => [t.code || "", t.type === "buy" ? "کڕین" : "فرۆشتن", new Date(t.date).toLocaleString("en-GB"),
      t.cpId ? usr(t.cpId).name : t.cpName, cur(t.curId).code, t.amount, t.rate ? +(1 / t.rate).toFixed(6) : "", cur(t.againstId).code, t.total,
      t.partnerId ? "لای " + usr(t.partnerId).name : "قاسەی گشتی", t.status === "pending" ? "چاوەڕوان" : "تەواو", t.profit ?? ""]);
    const csv = "\uFEFF" + [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `report_${from}_${to}.csv`; a.click();
  };

  const Row = ({ label, m, tone, bold }) => (
    <div className={`flex items-center justify-between py-2.5 border-b border-stone-100 last:border-0 ${bold ? "font-bold" : ""}`}>
      <span className={`text-sm ${bold ? "text-slate-900" : "text-slate-600"}`}>{label}</span>
      <div className="text-left space-y-0.5">
        {Object.keys(m).length === 0 ? <span className="text-slate-300 text-sm">0</span> :
          Object.entries(m).map(([cid, v]) => (
            <div key={cid} className={`text-sm ${tone === "pos" ? "text-emerald-700" : tone === "neg" ? "text-rose-700" : "text-slate-800"}`}>
              <span style={num} className="font-bold">{tone === "neg" ? "−" : ""}{fmt(Math.abs(v), 0)}</span>
              <span className="text-xs text-slate-400 mr-1">{cur(cid).code}</span>
            </div>
          ))}
      </div>
    </div>
  );

  const TABS = [["pl", "خێر و زەرەر"], ["flow", "هاتوو و تێچوو"], ["inv", "وەبەرهێنەران"]];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-2">
        <H sub={`${from} تا ${to}`}>ڕاپۆرت</H>
        <Btn kind="ghost" onClick={exportCsv}>دەرهێنان بۆ ئێکسڵ</Btn>
      </div>

      <Card className="p-4 space-y-3">
        <div className="flex gap-1.5 flex-wrap">
          {[["today", "ئەمڕۆ"], ["week", "ئەم هەفتەیە"], ["month", "ئەم مانگە"], ["prev", "مانگی ڕابردوو"], ["year", "ئەمساڵ"]].map(([k, t]) => (
            <button key={k} onClick={() => preset(k)} className="px-3 py-1.5 rounded-lg bg-stone-100 hover:bg-emerald-700 hover:text-white text-xs font-semibold text-slate-600 transition">{t}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div><Lbl>لە</Lbl><Inp type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><Lbl>بۆ</Lbl><Inp type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
      </Card>

      {/* پوختەی سەرەکی */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-4"><div className="text-xs text-slate-500">مامەڵە</div><div className="text-2xl font-bold" style={num}>{txs.length}</div></Card>
        <Card className="p-4"><div className="text-xs text-slate-500">کڕین</div><div className="text-2xl font-bold text-emerald-700" style={num}>{txs.filter((t) => t.type === "buy").length}</div></Card>
        <Card className="p-4"><div className="text-xs text-slate-500">فرۆشتن</div><div className="text-2xl font-bold text-rose-700" style={num}>{txs.filter((t) => t.type === "sell").length}</div></Card>
        <Card accent className="p-4">
          <div className="text-xs text-emerald-100">نەتی خۆم {ratesReady ? "(دۆلار)" : ""}</div>
          <div className="text-2xl font-bold" style={num}>{ratesReady ? fmt(sumUsd(net), 0) : Object.values(net).length ? fmt(Object.values(net)[0], 0) : 0}</div>
        </Card>
      </div>

      <div className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1 overflow-x-auto">
        {TABS.map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-1 whitespace-nowrap px-3 py-2.5 rounded-lg text-sm ${tab === k ? "bg-emerald-700 text-white font-semibold" : "text-slate-600 hover:bg-stone-100"}`}>{t}</button>
        ))}
      </div>

      {tab === "pl" && (
        <Card className="p-5">
          <SecLbl>خێر و زەرەر</SecLbl>
          {allCurs.length === 0 ? <Empty t="هیچ نییە لەم ماوەیەدا" /> : <>
            <Row label="خێری فرۆشتن" m={profit} tone="pos" />
            <Row label="زەرەری فرۆشتن" m={loss} tone="neg" />
            <Row label="خەرجی" m={exp} tone="neg" />
            <Row label="عمولەی هاوبەشان" m={fee} tone="neg" />
            <Row label="خێری وەبەرهێنەران" m={invP} tone="neg" />
            <div className="mt-1 pt-1 border-t-2 border-slate-900/10">
              <Row label="نەتیجەی کۆتایی (بۆ خۆم)" m={net} tone="pos" bold />
            </div>
            {ratesReady && (
              <div className="mt-3 bg-emerald-50 rounded-xl p-3 flex justify-between items-center">
                <span className="text-sm text-emerald-900 font-semibold">کۆی نەت بە دۆلار</span>
                <span className="text-xl font-bold text-emerald-700" style={num}>{fmt(sumUsd(net), 0)} $</span>
              </div>
            )}
          </>}
        </Card>
      )}

      {tab === "flow" && (
        <div className="space-y-4">
          <Card className="p-5">
            <SecLbl>هاتوو و تێچووی قاسە</SecLbl>
            {Object.keys(flow).length === 0 ? <Empty t="هیچ" /> :
              Object.entries(flow).map(([cid, fl]) => (
                <div key={cid} className="py-3 border-b border-stone-100 last:border-0">
                  <div className="font-semibold text-slate-800 mb-2">{cur(cid).name}</div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="bg-emerald-50 rounded-lg py-2">
                      <div className="text-[10px] text-emerald-800/70">هاتوو</div>
                      <div className="text-sm font-bold text-emerald-700" style={num}>{fmt(fl.inn, 0)}</div>
                    </div>
                    <div className="bg-rose-50 rounded-lg py-2">
                      <div className="text-[10px] text-rose-800/70">تێچوو</div>
                      <div className="text-sm font-bold text-rose-700" style={num}>{fmt(fl.out, 0)}</div>
                    </div>
                    <div className="bg-stone-100 rounded-lg py-2">
                      <div className="text-[10px] text-slate-500">جیاوازی</div>
                      <div className="text-sm font-bold text-slate-800" style={num}>{fmt(fl.inn - fl.out, 0)}</div>
                    </div>
                  </div>
                </div>
              ))}
          </Card>
          <Card className="p-5">
            <SecLbl>قەبارەی مامەڵەکان</SecLbl>
            {Object.keys(vol).length === 0 ? <Empty t="هیچ" /> :
              Object.entries(vol).map(([cid, v]) => (
                <div key={cid} className="flex items-center justify-between py-2.5 border-b border-stone-100 last:border-0">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">{cur(cid).name}</div>
                    <div className="text-xs text-slate-400" style={num}>{v.n} مامەڵە</div>
                  </div>
                  <div className="text-left text-sm">
                    <div className="text-emerald-700">کڕدراو <b style={num}>{fmt(v.buy, 0)}</b></div>
                    <div className="text-rose-700">فرۆشراو <b style={num}>{fmt(v.sell, 0)}</b></div>
                  </div>
                </div>
              ))}
          </Card>
        </div>
      )}

      {tab === "inv" && (
        <Card className="p-5">
          <SecLbl>دابەشکردنی خێر</SecLbl>
          {investors.length === 0 || Object.keys(pm).length === 0 ? <Empty t="هیچ خێرێک نییە لەم ماوەیەدا" /> :
            investors.map((u) => {
              const rows = Object.entries(pm).map(([cid, tot]) => {
                const cap = (calc.invCap[u.id] || {})[cid] || 0;
                if (!cap) return null;
                const totalCap = (calc.selfCap[cid] || 0) + (calc.invTotal[cid] || 0);
                return { cid, cap, share: totalCap ? cap / totalCap : 0, amt: invShare(u.id, cid, tot) };
              }).filter(Boolean);
              if (!rows.length) return null;
              return (
                <div key={u.id} className="py-3 border-b border-stone-100 last:border-0">
                  <div className="flex justify-between items-center mb-2">
                    <div className="font-semibold text-slate-800">{u.name}</div>
                    <Pill>ڕێژە {u.rate}٪</Pill>
                  </div>
                  {rows.map((r) => (
                    <div key={r.cid} className="flex justify-between items-center py-1.5 text-sm">
                      <span className="text-slate-500">
                        {cur(r.cid).name} · سەرمایە <span style={num}>{fmt(r.cap, 0)}</span> ({(r.share * 100).toFixed(1)}٪)
                      </span>
                      <span className="font-bold text-emerald-700" style={num}>{fmt(r.amt, 0)}</span>
                    </div>
                  ))}
                </div>
              );
            })}
        </Card>
      )}
    </div>
  );
}


/* ══════════════════ پاراستنی داتا و باکئەپ ══════════════════ */
function Backup({ data, calc, cur, saveBackup, downloadBackup, flash, sumUsd, mySafe, owners, ratesReady }) {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const { data: b, error } = await supabase.from("backups").select("id, created_at, kind, counts").order("created_at", { ascending: false }).limit(40);
      if (error) throw error;
      setList(b || []);
    } catch { setList([]); }
  };
  useEffect(() => { load(); }, []);

  const counts = {
    مامەڵە: data.txs.filter((t) => !t.deleted).length,
    "تۆماری دەفتەر": data.ledger.length,
    بەکارهێنەر: data.users.filter((u) => !u.deleted).length,
    دراو: data.currencies.length,
  };

  /* پشکنینی تەندروستی حیسابەکان */
  const checks = (() => {
    const out = [];
    // ١) هەر مامەڵەیەکی تەواوکراو دەبێت تۆماری دەفتەری هەبێت
    const withLedger = new Set(data.ledger.map((e) => e.txId).filter(Boolean));
    const orphan = data.txs.filter((t) => !t.deleted && !withLedger.has(t.id));
    out.push({ ok: orphan.length === 0, t: "هەموو مامەڵەکان تۆماری دەفتەریان هەیە", d: orphan.length ? `${orphan.length} مامەڵە بێ تۆمار` : "تەواو" });
    // ٢) تۆماری دەفتەری هەڵگەڕاو
    const txIds = new Set(data.txs.map((t) => t.id));
    const ghost = data.ledger.filter((e) => e.txId && !txIds.has(e.txId));
    out.push({ ok: ghost.length === 0, t: "هیچ تۆمارێکی سەرگەردان نییە", d: ghost.length ? `${ghost.length} تۆمار` : "تەواو" });
    // ٣) باڵانسی سالب لە قاسەی سەرەکی
    const neg = data.currencies.filter((c) => (calc.atMe[c.id] || 0) < 0);
    out.push({ ok: neg.length === 0, t: "هیچ باڵانسێکی سالب نییە لە قاسەی سەرەکی", d: neg.length ? neg.map((c) => c.code).join("، ") : "تەواو" });
    // ٤) نرخەکان
    out.push({ ok: ratesReady, t: "نرخی هەموو دراوەکان دانراوە", d: ratesReady ? "تەواو" : "هەندێک دراو نرخی نییە" });
    // ٥) کۆی خاوەندارێتی = کۆی قاسە
    if (ratesReady) {
      const safe = sumUsd(calc.phys), own = owners.total;
      const diff = Math.abs(safe - own);
      const pct = safe > 0 ? (diff / safe) * 100 : 0;
      out.push({ ok: pct < 5, t: "خاوەندارێتی لەگەڵ قاسە دەگونجێت", d: `جیاوازی ${fmt(diff, 0)}$ (${pct.toFixed(1)}٪)` });
    }
    return out;
  })();

  const okAll = checks.every((c) => c.ok);

  return (
    <div className="space-y-4">
      <H sub="داتاکەت لە سێرڤەری Supabase پارێزراوە — لێرەش وێنەی زاپاسی لێ دەگیرێت">پاراستنی داتا</H>

      <Card className={`p-4 ${okAll ? "border-emerald-300 bg-emerald-50/40" : "border-amber-300 bg-amber-50/40"}`}>
        <div className="flex items-center gap-2 mb-3">
          {okAll ? <CheckCircle2 className="w-5 h-5 text-emerald-700" /> : <AlertTriangle className="w-5 h-5 text-amber-600" />}
          <span className={`font-bold ${okAll ? "text-emerald-800" : "text-amber-800"}`}>
            {okAll ? "هەموو حیسابەکان ڕێکن" : "چەند خاڵێک پێویستی بە سەیرکردن هەیە"}
          </span>
        </div>
        {checks.map((c, i) => (
          <div key={i} className="flex items-center justify-between py-1.5 text-sm border-b border-white/60 last:border-0">
            <span className="flex items-center gap-1.5 text-slate-700">
              {c.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />}
              {c.t}
            </span>
            <span className={`text-xs ${c.ok ? "text-slate-400" : "text-amber-800 font-semibold"}`}>{c.d}</span>
          </div>
        ))}
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Object.entries(counts).map(([k, v]) => (
          <Card key={k} className="p-4"><div className="text-xs text-slate-500">{k}</div><div className="text-2xl font-bold" style={num}>{fmt(v, 0)}</div></Card>
        ))}
      </div>

      <Card className="p-5">
        <SecLbl>باکئەپ</SecLbl>
        <div className="text-sm text-slate-600 mb-3 leading-relaxed">
          هەر ٦ کاتژمێرێک جارێک خۆی وێنەیەکی تەواوی هەموو داتاکە هەڵدەگرێت. دەتوانیت خۆشت ئێستا یەکێک درووست بکەیت، یان فایلێک دابەزێنیت و لە کۆمپیوتەرەکەت هەڵیبگریت.
        </div>
        <div className="flex gap-2 flex-wrap">
          <Btn onClick={async () => { setBusy(true); await saveBackup("manual"); await load(); setBusy(false); }} disabled={busy}>
            {busy ? "..." : "درووستکردنی باکئەپ ئێستا"}
          </Btn>
          <Btn kind="ghost" className="flex items-center gap-1.5" onClick={downloadBackup}><Download className="w-4 h-4" /> دابەزاندنی فایل</Btn>
        </div>
      </Card>

      <Card className="p-5">
        <SecLbl>باکئەپە هەڵگیراوەکان</SecLbl>
        {list === null ? <Empty t="بارکردن..." /> :
          list.length === 0 ? (
            <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3">
              هێشتا هیچ باکئەپێک نییە — ئایا خشتەی <b>backups</b> لە Supabase درووست کراوە؟
            </div>
          ) : list.map((b) => (
            <div key={b.id} className="flex items-center justify-between py-2.5 border-b border-stone-100 last:border-0">
              <div>
                <div className="text-sm text-slate-800" style={num}>{new Date(b.created_at).toLocaleString("en-GB")}</div>
                <div className="text-[11px] text-slate-400">
                  {b.kind === "auto" ? "ئۆتۆماتیکی" : "دەستی"} · <span style={num}>{b.counts?.txs ?? "?"}</span> مامەڵە · <span style={num}>{b.counts?.ledger ?? "?"}</span> تۆمار
                </div>
              </div>
              <Pill tone={b.kind === "auto" ? "slate" : "green"}>{b.kind === "auto" ? "خۆکار" : "دەستی"}</Pill>
            </div>
          ))}
      </Card>

      <Card className="p-4 bg-stone-50/60">
        <div className="text-xs text-slate-500 leading-relaxed">
          <b className="text-slate-700">ئامۆژگاری:</b> بۆ کۆمپانیایەک کە ملیۆنان دۆلار ئاڵووگۆڕ دەکات، پێشنیار دەکەم پلانی <b>Supabase Pro</b> وەربگریت ($25/مانگ) — باکئەپی خۆکاری ڕۆژانەی هەیە لەگەڵ توانای گەڕاندنەوەی هەر خولەکێک، و پڕۆژەکەشت هەرگیز ناوەستێت. هەروەها مانگی جارێک فایلێکی باکئەپ دابەزێنە و لە شوێنێکی جیا هەڵیبگرە.
        </div>
      </Card>
    </div>
  );
}

/* ══════════════════ بەستنی ڕۆژ ══════════════════ */
function DayClose({ data, calc, cur, usr, closeDay, sumUsd }) {
  const [counts, setCounts] = useState({});
  const [note, setNote] = useState("");
  const [adjust, setAdjust] = useState(true);
  const [hist, setHist] = useState(null);
  const [step, setStep] = useState("count");

  const load = () => supabase.from("day_closes").select("*").order("created_at", { ascending: false }).limit(30)
    .then(({ data: d }) => setHist(d || [])).catch(() => setHist([]));
  useEffect(() => { load(); }, []);

  // چاوەڕوانکراو = ئەوەی لای خۆم دەبێت بێت (نەک ئەوەی لای هاوبەشان)
  const lines = data.currencies.map((c) => {
    const expected = Math.round(calc.atMe[c.id] || 0);
    const raw = counts[c.id];
    const counted = raw === "" || raw === undefined ? null : Math.round(+raw);
    return { cur: c.id, code: c.code, name: c.name, c, expected, counted, diff: counted === null ? 0 : counted - expected };
  });
  const entered = lines.filter((l) => l.counted !== null);
  const diffs = entered.filter((l) => l.diff !== 0);
  const totalDiffUsd = sumUsd(Object.fromEntries(entered.map((l) => [l.cur, l.diff])));

  const today = new Date().toISOString().slice(0, 10);
  const closedToday = (hist || []).some((h) => h.close_date === today);

  const submit = () => {
    closeDay(entered.map((l) => ({ cur: l.cur, code: l.code, expected: l.expected, counted: l.counted, diff: l.diff })), note, adjust);
    setCounts({}); setNote(""); setStep("count");
    setTimeout(load, 1200);
  };

  return (
    <div className="space-y-4">
      <H sub="لە کۆتایی ڕۆژدا پارەی ڕاستەقینە بژمێرە و بەراوردی بکە لەگەڵ حیسابی سیستەم">بەستنی ڕۆژ</H>

      {closedToday && (
        <Card className="p-4 border-emerald-300 bg-emerald-50/50">
          <div className="flex items-center gap-2 text-sm text-emerald-900 font-semibold">
            <CheckCircle2 className="w-4 h-4" /> ئەمڕۆ بەسترابووەتەوە — دەتوانیت دووبارە بیکەیتەوە
          </div>
        </Card>
      )}

      {step === "count" ? (
        <>
          <Card className="p-5">
            <SecLbl>پارەی لای خۆت بژمێرە</SecLbl>
            <div className="text-xs text-slate-500 mb-4">
              تەنها ئەو پارەیە کە لای خۆتە — ئەوەی لای هاوبەشەکانە لێرە نایەت
            </div>
            {lines.map((l) => (
              <div key={l.cur} className="py-3 border-b border-stone-100 last:border-0">
                <div className="flex items-center gap-2.5 mb-2">
                  <CurBadge c={l.c} size="sm" />
                  <span className="text-sm font-semibold text-slate-800">{l.name}</span>
                  <span className="text-xs text-slate-400 mr-auto">
                    حیسابی سیستەم: <b style={num} className="text-slate-700">{fmt(l.expected, 0)}</b>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Inp type="number" dir="ltr" placeholder="ژماردنی ڕاستەقینە..."
                    value={counts[l.cur] ?? ""} onChange={(e) => setCounts({ ...counts, [l.cur]: e.target.value })}
                    className={`flex-1 ${l.counted !== null && l.diff !== 0 ? "border-amber-500 bg-amber-50" : l.counted !== null ? "border-emerald-500 bg-emerald-50" : ""}`} />
                  <div className="w-28 text-left shrink-0">
                    {l.counted === null ? <span className="text-xs text-slate-300">—</span> :
                      l.diff === 0 ? <span className="text-sm font-bold text-emerald-700">✓ ڕێکە</span> :
                        <span className={`text-sm font-bold ${l.diff > 0 ? "text-emerald-700" : "text-rose-700"}`} style={num}>
                          {l.diff > 0 ? "+" : ""}{fmt(l.diff, 0)}
                        </span>}
                  </div>
                </div>
              </div>
            ))}
          </Card>

          {entered.length > 0 && (
            <Card className={`p-5 ${diffs.length ? "border-amber-300 bg-amber-50/50" : "border-emerald-300 bg-emerald-50/50"}`}>
              <div className="flex items-center gap-2 mb-2">
                {diffs.length ? <AlertTriangle className="w-5 h-5 text-amber-600" /> : <CheckCircle2 className="w-5 h-5 text-emerald-700" />}
                <span className={`font-bold ${diffs.length ? "text-amber-900" : "text-emerald-900"}`}>
                  {diffs.length ? `${diffs.length} دراو جیاوازی هەیە` : "هەموو شتێک ڕێکە"}
                </span>
              </div>
              {diffs.map((l) => (
                <div key={l.cur} className="flex justify-between text-sm py-1">
                  <span className="text-slate-600">{l.name}</span>
                  <span className={`font-bold ${l.diff > 0 ? "text-emerald-700" : "text-rose-700"}`} style={num}>
                    {l.diff > 0 ? "زیادە " : "کەمە "}{fmt(Math.abs(l.diff), 0)}
                  </span>
                </div>
              ))}
              {diffs.length > 0 && (
                <div className="text-xs text-slate-500 mt-2 pt-2 border-t border-amber-200" style={num}>
                  کۆی جیاوازی بە دۆلار ≈ {fmt(totalDiffUsd, 0)} $
                </div>
              )}
            </Card>
          )}

          <Card className="p-5">
            <div><Lbl>تێبینی (بۆچی جیاوازی هەیە؟)</Lbl><Inp value={note} onChange={(e) => setNote(e.target.value)} placeholder="نموونە: خەرجی تۆمار نەکراو..." /></div>
            {diffs.length > 0 && (
              <label className="flex items-start gap-2.5 mt-4 cursor-pointer">
                <input type="checkbox" checked={adjust} onChange={(e) => setAdjust(e.target.checked)} className="mt-0.5 w-4 h-4 accent-emerald-700" />
                <span className="text-sm text-slate-700">
                  <b>قاسەکە ڕاست بکەرەوە</b>
                  <div className="text-xs text-slate-500 mt-0.5">تۆمارێکی ڕاستکردنەوە زیاد دەکرێت تا حیسابی سیستەم بگونجێت لەگەڵ پارەی ڕاستەقینە</div>
                </span>
              </label>
            )}
            <Btn className="w-full mt-4" onClick={() => setStep("confirm")} disabled={!entered.length}>
              بەستنی ڕۆژ ({entered.length} دراو)
            </Btn>
          </Card>
        </>
      ) : (
        <Card className="p-5">
          <SecLbl>دڵنیابوونەوە</SecLbl>
          <div className="space-y-1.5 mb-4">
            {entered.map((l) => (
              <div key={l.cur} className="flex justify-between items-center py-2 border-b border-stone-100 text-sm">
                <span className="text-slate-600">{l.name}</span>
                <span style={num}>
                  <span className="text-slate-400">{fmt(l.expected, 0)}</span>
                  <span className="mx-1.5 text-slate-300">→</span>
                  <b className="text-slate-900">{fmt(l.counted, 0)}</b>
                  {l.diff !== 0 && <span className={`mr-2 font-bold ${l.diff > 0 ? "text-emerald-700" : "text-rose-700"}`}>({l.diff > 0 ? "+" : ""}{fmt(l.diff, 0)})</span>}
                </span>
              </div>
            ))}
          </div>
          {diffs.length > 0 && adjust && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4">
              تۆمارێکی ڕاستکردنەوە زیاد دەکرێت بۆ گونجاندنی قاسە لەگەڵ ژماردنەکەت
            </div>
          )}
          <div className="flex gap-2">
            <Btn className="flex-1" onClick={submit}>پشتڕاستکردنەوە</Btn>
            <Btn kind="ghost" className="flex-1" onClick={() => setStep("count")}>گەڕانەوە</Btn>
          </div>
        </Card>
      )}

      <SecLbl>مێژووی بەستنەکان</SecLbl>
      {hist === null ? <Card><Empty t="بارکردن..." /></Card> :
        hist.length === 0 ? (
          <Card className="p-4">
            <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3">
              هێشتا هیچ بەستنێک نییە — ئایا خشتەی <b>day_closes</b> لە Supabase درووست کراوە؟
            </div>
          </Card>
        ) : hist.map((h) => (
          <Card key={h.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-slate-800" style={num}>{h.close_date}</div>
                <div className="text-[11px] text-slate-400 mt-0.5" style={num}>
                  {new Date(h.created_at).toLocaleTimeString("en-GB")}
                  {h.closed_by && ` · ${usr(h.closed_by).name || ""}`}
                </div>
                {h.note && <div className="text-xs text-slate-500 mt-1">{h.note}</div>}
              </div>
              <div className="text-left shrink-0">
                {h.has_diff
                  ? <Pill tone="amber">جیاوازی هەبووە</Pill>
                  : <Pill tone="green">ڕێک بووە</Pill>}
              </div>
            </div>
            {h.has_diff && Array.isArray(h.lines) && (
              <div className="mt-2.5 pt-2.5 border-t border-stone-100 space-y-1">
                {h.lines.filter((l) => l.diff).map((l, i) => (
                  <div key={i} className="flex justify-between text-xs">
                    <span className="text-slate-500">{l.code}</span>
                    <span className={`font-bold ${l.diff > 0 ? "text-emerald-700" : "text-rose-700"}`} style={num}>
                      {l.diff > 0 ? "+" : ""}{fmt(l.diff, 0)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        ))}
    </div>
  );
}

/* ══════════════════ تۆماری گۆڕانکاری ══════════════════ */
function Audit({ data }) {
  return (
    <div className="space-y-3">
      <H>تۆماری گۆڕانکاری</H>
      {data.audit.length === 0 ? <Card><Empty t="هێشتا هیچ" /></Card> :
        data.audit.slice(0, 150).map((a) => (
          <Card key={a.id} className="p-3.5 flex items-center gap-3 text-sm">
            <History className="w-4 h-4 text-slate-300 shrink-0" />
            <span className="font-semibold text-slate-700">{a.action}</span>
            <span className="text-slate-500 flex-1">{a.detail}</span>
            <span className="text-[11px] text-slate-400" style={num}>{new Date(a.date).toLocaleString("en-GB")}</span>
          </Card>
        ))}
    </div>
  );
}

/* پۆرتاڵی کڕیار */
function CustomerPortal({ user, c, base, data, cur, usr, flash, reloadBatches }) {
  const [list, f, setF] = useTxFilter(base, cur, usr);
  const [tab, setTab] = useState("account");
  const owe = Object.entries(c.owe).filter(([, v]) => v);
  const due = Object.entries(c.due).filter(([, v]) => v);

  const TABS = [["account", "ئەکاونتم"], ["send", "ناردنی فیش"], ["archive", "فیشەکانم"]];
  return (
    <div className="space-y-4">
      <H sub={`بەخێربێیت، ${user.name}`}>ئەکاونتی من</H>

      <div className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1">
        {TABS.map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-1 py-2.5 rounded-lg text-sm ${tab === k ? "bg-emerald-700 text-white font-semibold" : "text-slate-600 hover:bg-stone-100"}`}>{t}</button>
        ))}
      </div>

      {tab === "send" && (
        <>
          <Card className="p-4 bg-stone-50/70">
            <div className="text-sm text-slate-600 leading-relaxed">
              سکرینشۆتی ئەو فیشانە هەڵبژێرە کە پارەت پێ ناردووە. سیستەمەکە خۆی دەیانخوێنێتەوە، کۆیان دەکاتەوە، و دووبارەکان دەدۆزێتەوە.
            </div>
          </Card>
          <ReceiptUploader customerId={user.id} customerName={user.name} uploaderId={user.id} data={data}
            flash={flash} onDone={() => { reloadBatches && reloadBatches(); setTab("archive"); }} />
        </>
      )}

      {tab === "archive" && <ReceiptArchive customerId={user.id} data={data} flash={flash} />}

      {tab === "account" && (<>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card className="p-4 border-emerald-200 bg-emerald-50/40">
          <div className="text-xs font-semibold text-emerald-800 mb-2">پارەی من لای ئەوان</div>
          {owe.length === 0 ? <div className="text-sm text-slate-400">هیچ</div> :
            owe.map(([cid, v]) => (
              <div key={cid} className="flex justify-between py-1">
                <span className="text-sm text-slate-600">{cur(cid).name}</span>
                <span className="text-lg font-bold text-emerald-700" style={num}>{fmt(v, 0)}</span>
              </div>
            ))}
        </Card>
        <Card className="p-4 border-rose-200 bg-rose-50/40">
          <div className="text-xs font-semibold text-rose-800 mb-2">قەرزی من</div>
          {due.length === 0 ? <div className="text-sm text-slate-400">هیچ</div> :
            due.map(([cid, v]) => (
              <div key={cid} className="flex justify-between py-1">
                <span className="text-sm text-slate-600">{cur(cid).name}</span>
                <span className="text-lg font-bold text-rose-700" style={num}>{fmt(v, 0)}</span>
              </div>
            ))}
        </Card>
      </div>
      <SecLbl>مامەڵەکانم</SecLbl>
      <TxFilterBar data={data} f={f} setF={setF} count={list.length} />
      {list.length === 0 ? <Card><Empty t="هیچ مامەڵەیەک نەدۆزرایەوە" /></Card> :
        list.map((t) => <TxRow key={t.id} t={t} cur={cur} usr={usr} flip lite />)}
      </>)}
    </div>
  );
}

/* پۆرتاڵی هاوبەش */
function PartnerPortal({ user, data, calc, cur, usr, flash, reloadBatches, accountMove, accountTransfer }) {
  const [tab, setTab] = useState("balance");
  const bal = calc.partner[user.id] || {};
  const hist = data.ledger.filter((e) => e.partnerId === user.id).slice().reverse();
  const fees = {};
  data.ledger.forEach((e) => { if (e.partnerId === user.id && e.type === "partner_fee") fees[e.curId] = (fees[e.curId] || 0) + Math.abs(e.amount); });
  return (
    <div className="space-y-4">
      <H sub={`بەخێربێیت، ${user.name}`}>ئەکاونتی من</H>
      <div className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1">
        {[["balance", "باڵانس"], ["safe", "قاسە"], ["receipts", "فیشەکان"], ["send", "ناردنی فیش"], ["history", "مێژوو"]].map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-1 whitespace-nowrap px-2 py-2.5 rounded-lg text-sm ${tab === k ? "bg-emerald-700 text-white font-semibold" : "text-slate-600 hover:bg-stone-100"}`}>{t}</button>
        ))}
      </div>

      {tab === "balance" && (
        <div className="grid md:grid-cols-2 gap-4">
          <Card className="p-5">
            <SecLbl>باڵانسی لای من</SecLbl>
            {Object.keys(bal).length === 0 ? <Empty t="بەتاڵە" /> :
              Object.entries(bal).map(([cid, v]) => (
                <div key={cid} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
                  <span className="text-sm text-slate-600">{cur(cid).name}</span><Money v={v} dec={0} />
                </div>
              ))}
          </Card>
          <Card className="p-5">
            <SecLbl>عمولەی وەرگیراو ({user.rate}٪)</SecLbl>
            {Object.keys(fees).length === 0 ? <Empty t="هێشتا هیچ" /> :
              Object.entries(fees).map(([cid, v]) => (
                <div key={cid} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
                  <span className="text-sm text-slate-600">{cur(cid).name}</span><Money v={v} dec={0} pos />
                </div>
              ))}
          </Card>
        </div>
      )}

      {tab === "safe" && <AccountSafe userId={user.id} data={data} calc={calc} cur={cur} usr={usr} flash={flash} readOnly />}
      {tab === "receipts" && <PartnerReceipts partnerId={user.id} data={data} flash={flash} />}

      {tab === "send" && (
        <>
          <Card className="p-4 bg-stone-50/70">
            <div className="text-sm text-slate-600 leading-relaxed">
              فیشی ئەو پارەیە بنێرە کە لە ئەکاونتی تۆوە نێردراوە یان بۆ تۆ هاتووە.
              سیستەمەکە خۆی دەیخوێنێتەوە و دووبارەکان دەدۆزێتەوە.
            </div>
          </Card>
          <ReceiptUploader partnerId={user.id} customerName={null} uploaderId={user.id}
            data={data} direction="out" allowDirection flash={flash}
            onDone={() => { reloadBatches && reloadBatches(); setTab("receipts"); }} />
        </>
      )}

      {tab === "history" && (
        hist.length === 0 ? <Card><Empty t="هیچ نییە" /></Card> :
          hist.map((e) => (
            <Card key={e.id} className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <Pill tone={e.amount >= 0 ? "green" : "red"}>{e.amount >= 0 ? "هاتنە ژوورەوە" : "چوونە دەرەوە"}</Pill>
              <span><Money v={e.amount} dec={0} /> {cur(e.curId).code}</span>
              {e.type === "partner_fee" && <span className="text-slate-500">عمولە</span>}
              <span className="text-[11px] text-slate-400 mr-auto" style={num}>{new Date(e.date).toLocaleString("en-GB")}</span>
            </Card>
          ))
      )}
    </div>
  );
}

/* ══════════════════ پۆرتاڵی ڕۆڵەکانی تر ══════════════════ */
function Portal({ user, data, calc, cur, usr, officePay, settle, invUnpaid, flash, reloadBatches, accountMove, accountTransfer }) {
  if (user.role === "office") return <Office data={data} cur={cur} usr={usr} officePay={officePay} calc={calc} officeId={user.id} flash={flash} readOnlyUser />;

  if (user.role === "customer") {
    const c = calc.cust[user.id] || { owe: {}, due: {} };
    const base = data.txs.filter((t) => !t.deleted && t.cpId === user.id).reverse();
    return <CustomerPortal user={user} c={c} base={base} data={data} cur={cur} usr={usr} flash={flash} reloadBatches={reloadBatches} />;
  }

  if (user.role === "partner") return <PartnerPortal user={user} data={data} calc={calc} cur={cur} usr={usr} flash={flash} reloadBatches={reloadBatches} accountMove={accountMove} accountTransfer={accountTransfer} />;

  if (user.role === "__never__") {
    const bal = calc.partner[user.id] || {};
    const hist = data.ledger.filter((e) => e.partnerId === user.id).slice().reverse();
    const fees = {};
    data.ledger.forEach((e) => { if (e.partnerId === user.id && e.type === "partner_fee") fees[e.curId] = (fees[e.curId] || 0) + Math.abs(e.amount); });
    return (
      <div className="space-y-4">
        <H sub={`بەخێربێیت، ${user.name}`}>ئەکاونتی من</H>
        <div className="grid md:grid-cols-2 gap-4">
          <Card className="p-5">
            <SecLbl>باڵانسی لای من</SecLbl>
            {Object.keys(bal).length === 0 ? <Empty t="بەتاڵە" /> :
              Object.entries(bal).map(([cid, v]) => (
                <div key={cid} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
                  <span className="text-sm text-slate-600">{cur(cid).name}</span><Money v={v} dec={cur(cid).dec} />
                </div>
              ))}
          </Card>
          <Card className="p-5">
            <SecLbl>عمولەی وەرگیراو ({user.rate}٪)</SecLbl>
            {Object.keys(fees).length === 0 ? <Empty t="هێشتا هیچ" /> :
              Object.entries(fees).map(([cid, v]) => (
                <div key={cid} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
                  <span className="text-sm text-slate-600">{cur(cid).name}</span><Money v={v} dec={cur(cid).dec} pos />
                </div>
              ))}
          </Card>
        </div>
        <SecLbl>مێژووی ئاڵووگۆر</SecLbl>
        {hist.length === 0 ? <Card><Empty t="هیچ نییە" /></Card> :
          hist.map((e) => (
            <Card key={e.id} className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <Pill tone={e.amount >= 0 ? "green" : "red"}>{e.amount >= 0 ? "هاتنە ژوورەوە" : "چوونە دەرەوە"}</Pill>
              <span><Money v={e.amount} dec={cur(e.curId).dec} /> {cur(e.curId).code}</span>
              {e.type === "partner_fee" && <span className="text-slate-500">عمولە</span>}
              <span className="text-[11px] text-slate-400 mr-auto" style={num}>{new Date(e.date).toLocaleString("en-GB")}</span>
            </Card>
          ))}
      </div>
    );
  }

  if (user.role === "investor") {
    return (
      <div className="space-y-4">
        <H sub={`بەخێربێیت، ${user.name}`}>ئەکاونتی من</H>
        <InvestorDetail u={user} data={data} calc={calc} cur={cur} invUnpaid={invUnpaid} mine />
      </div>
    );
  }
  return null;
}
