import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "./lib/supabase";
import { createClient } from "@supabase/supabase-js";
import {
  LayoutDashboard, Vault, ArrowLeftRight, ListOrdered, Users, Handshake,
  TrendingUp, Building2, UserCog, PieChart, History, Plus, Trash2, Pencil,
  CheckCircle2, AlertTriangle, Eye, LogOut, Wallet, ChevronLeft, Coins,
  Receipt, TrendingDown, ScanLine, Upload, XCircle, SlidersHorizontal, MoreHorizontal, X, Share2, Database, Download
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
const dOnly = (d) => (d || "").slice(0, 10);

/* ══════════════════ پێکهاتە بچووکەکان ══════════════════ */
const Card = ({ children, className = "", onClick, dark, accent }) => {
  const base = dark ? "bg-slate-900 border-slate-900 text-white"
    : accent ? "bg-emerald-700 border-emerald-700 text-white"
    : "bg-white border-stone-200/80";
  return (
    <div onClick={onClick}
      className={`${base} border rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${onClick ? "cursor-pointer hover:border-emerald-500 hover:shadow-md transition" : ""} ${className}`}>
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
    primary: "bg-emerald-700 hover:bg-emerald-800 text-white shadow-sm",
    danger: "bg-rose-700 hover:bg-rose-800 text-white shadow-sm",
    ghost: "bg-white hover:bg-stone-50 text-slate-700 border border-stone-300",
    gold: "bg-amber-600 hover:bg-amber-700 text-white shadow-sm",
  }[kind];
  return <button {...p} className={`px-4 py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-50 ${k} ${className}`} />;
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
      const [c, u, l, t, a] = await Promise.all([
        supabase.from("currencies").select("*").order("code"),
        supabase.from("app_users").select("*").order("created_at"),
        supabase.from("ledger").select("*").order("date"),
        supabase.from("txs").select("*").order("date"),
        supabase.from("audit").select("*").order("date", { ascending: false }).limit(300),
      ]);
      const d = {
        currencies: (c.data || []).map((r) => ({ id: r.id, code: r.code, name: r.name, symbol: r.symbol, dec: r.dec, buyRate: r.buy_rate == null ? null : +r.buy_rate, sellRate: r.sell_rate == null ? null : +r.sell_rate, rateUpdated: r.rate_updated })),
        users: (u.data || []).map((r) => ({ id: r.id, authId: r.auth_id, name: r.name, role: r.role, rate: +r.rate || 0, phone: r.phone, address: r.address, note: r.note, deleted: r.deleted })),
        ledger: (l.data || []).map((r) => ({ id: r.id, type: r.type, owner: r.owner, investorId: r.investor_id, curId: r.cur_id, amount: +r.amount, partnerId: r.partner_id, txId: r.tx_id, note: r.note, date: r.date })),
        txs: (t.data || []).map((r) => ({ id: r.id, code: r.code, type: r.type, cpId: r.cp_id, cpName: r.cp_name, curId: r.cur_id, amount: +r.amount, rate: +r.rate, againstId: r.against_id, total: +r.total, partnerId: r.partner_id, status: r.status, paidAt: r.paid_at, profit: r.profit == null ? null : +r.profit, profitCurId: r.profit_cur_id, note: r.note, date: r.date, edited: r.edited, deleted: r.deleted })),
        audit: (a.data || []).map((r) => ({ id: r.id, date: r.date, action: r.action, detail: r.detail })),
      };
      setData(d);
      if (session) setProfile(d.users.find((x) => x.authId === session.user.id) || null);
    } catch (err) { console.error(err); flash("هەڵە لە بارکردنی داتا"); }
  };

  const A = (action, detail) => supabase.from("audit").insert({ id: uid(), date: now(), action, detail });
  const LR = (e) => ({ id: e.id, type: e.type, owner: e.owner || null, investor_id: e.investorId || null, cur_id: e.curId, amount: e.amount, partner_id: e.partnerId || null, tx_id: e.txId || null, note: e.note || null, date: e.date });
  const TR = (t) => ({ id: t.id, code: t.code || null, type: t.type, cp_id: t.cpId, cp_name: t.cpName, cur_id: t.curId, amount: t.amount, rate: t.rate, against_id: t.againstId, total: t.total, partner_id: t.partnerId, status: t.status, paid_at: t.paidAt, profit: t.profit, profit_cur_id: t.profitCurId, note: t.note || null, date: t.date, edited: !!t.edited, deleted: !!t.deleted });

  const run = async (fn) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); await loadAll(); }
    catch (err) { console.error(err); flash("هەڵەیەک ڕوویدا — دووبارە هەوڵ بدەوە"); }
    finally { setBusy(false); }
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
    // باڵانسی دووسەرەی کڕیارەکان
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
    return { phys, partner, atMe, invCap, invTotal, selfCap, invPaid, expenses, fees, cust, pending: cust };
  }, [data]);

  const cur = (id) => data?.currencies.find((c) => c.id === id) || {};
  const usr = (id) => data?.users.find((u) => u.id === id) || {};

  /* خێری فرۆشتنەکان لە ماوەیەکدا، بۆ هەر دراوێک */
  const profitIn = (from, to) => {
    const m = {};
    for (const t of data.txs) {
      if (t.deleted || t.type !== "sell" || t.profit == null) continue;
      const d = dOnly(t.date);
      if (from && d < from) continue;
      if (to && d > to) continue;
      m[t.profitCurId] = (m[t.profitCurId] || 0) + t.profit;
    }
    return m;
  };
  const profitAll = useMemo(() => (data ? profitIn(null, null) : {}), [data]);

  /* بەشی وەبەرهێنەرێک لە خێری دراوێک */
  const invShare = (iid, curId, totalProfit) => {
    const totalCap = (calc.selfCap[curId] || 0) + (calc.invTotal[curId] || 0);
    const cap = (calc.invCap[iid] || {})[curId] || 0;
    if (totalCap <= 0 || cap <= 0 || !totalProfit) return 0;
    return totalProfit * (cap / totalCap) * ((usr(iid).rate || 0) / 100);
  };
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
      const myProfit = (profitAll[c.id] || 0) - (invP[c.id] || 0);
      out[c.id] = (calc.selfCap[c.id] || 0) + myProfit - (calc.expenses[c.id] || 0) - (calc.fees[c.id] || 0);
    }
    return out;
  }, [data, calc, profitAll]);

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
  const avgRate = (curId, againstId) => {
    let a = 0, v = 0;
    for (const t of data.txs) if (!t.deleted && t.type === "buy" && t.curId === curId && t.againstId === againstId) { a += t.amount; v += t.amount * t.rate; }
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
    const feeRate = t.partnerId ? (usr(t.partnerId).rate || 0) : 0;
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

  const saveTx = (f, existing) => {
    const amount = Math.round(+f.amount), rate = +f.rate, total = Math.round(amount * rate);
    if (!(amount > 0)) return flash("بڕ دەبێت لە سفر گەورەتر بێت");
    if (!(rate > 0)) return flash("نرخ دەبێت لە سفر گەورەتر بێت");
    if (f.curId === f.againstId) return flash("ناکرێت دراوەکە لەگەڵ خۆی مامەڵەی پێبکرێت");
    if (!f.cpId && !f.cpName) return flash("لایەنی بەرامبەر دیاری بکە");
    if (!(total > 0)) return flash("کۆی گشتی ناتوانێت سفر بێت");
    run(async () => {
      let profit = null, profitCurId = null;
      if (f.type === "sell") {
        const av = avgRate(f.curId, f.againstId);
        if (av !== null) { profit = Math.round(total - av * amount); profitCurId = f.againstId; }
      }
      const code = existing ? existing.code : Math.max(1000, ...data.txs.map((x) => x.code || 0)) + 1;
      const t = { id: existing ? existing.id : uid(), code, type: f.type, cpId: f.cpId || null, cpName: f.cpId ? null : f.cpName, curId: f.curId, amount, rate, againstId: f.againstId, total, partnerId: f.partnerId || null, status: f.status || "completed", paidAt: existing ? existing.paidAt : null, profit, profitCurId, note: f.note || "", date: existing ? existing.date : now(), edited: !!existing };
      if (existing) {
        let r = await supabase.from("ledger").delete().eq("tx_id", t.id); if (r.error) throw r.error;
        r = await supabase.from("txs").update(TR(t)).eq("id", t.id); if (r.error) throw r.error;
      } else {
        // گەر کەسێکی تر لە هەمان ساتدا هەمان کۆدی بردبێت، کۆدی دواتر تاقی بکەوە
        let ok = false;
        for (let k = 0; k < 8 && !ok; k++) {
          const r = await supabase.from("txs").insert(TR({ ...t, code: t.code + k }));
          if (!r.error) { t.code = t.code + k; ok = true; }
          else if (!String(r.error.message).match(/duplicate|unique/i)) throw r.error;
        }
        if (!ok) throw new Error("نەتوانرا کۆدێکی بەردەست بدۆزرێتەوە");
      }
      const r2 = await supabase.from("ledger").insert(buildEntries(t).map(LR)); if (r2.error) throw r2.error;
      // بەستنەوەی کۆمەڵەی فیش بە مامەڵەکەوە
      if (f.batchId) {
        await supabase.from("receipt_batches").update({
          status: "linked", tx_id: t.id, partner_id: t.partnerId || null, linked_at: now(),
        }).eq("id", f.batchId);
        setPendingBatch(null);
      }
      // گەر مامەڵەیەکی بەستراو ئیدیت کرا، هاوبەشی کۆمەڵەکەش نوێ بکەرەوە
      if (existing) {
        await supabase.from("receipt_batches").update({ partner_id: t.partnerId || null }).eq("tx_id", t.id);
      }
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
      const e = await supabase.from("currencies").update({ buy_rate: r.buyRate === "" ? null : +r.buyRate, sell_rate: r.sellRate === "" ? null : +r.sellRate, rate_updated: now() }).eq("id", r.id);
      if (e.error) throw e.error;
    }
    await A("گۆڕینی نرخی ڕۆژ", rows.map((r) => `${cur(r.id).code}: ${r.buyRate}/${r.sellRate}`).join("، "));
    flash("نرخەکان پاشەکەوت کران ✓");
  });

  const addCurrency = (nc) => run(async () => {
    const r = await supabase.from("currencies").insert({ id: nc.code.toLowerCase(), code: nc.code, name: nc.name, symbol: nc.symbol, dec: +nc.dec || 2 });
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
    const r = await supabase.from("app_users").insert({ id: uid(), auth_id: sd?.user?.id || null, name: f.name, role: f.role, rate: +f.rate || 0, phone: f.phone, address: f.address || null, note: f.note || null });
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
    ["backup", "پاراستنی داتا", Database],
  ];


  const shared = { data, calc, cur, usr, mySafe, profitAll, profitIn, investorsProfitIn, invShare, invUnpaid, autoRate, avgRate, toUsd, sumUsd, ratesReady, owners };

  return (
    <div dir="rtl" className="min-h-screen bg-[#F6F5F2] text-slate-800" style={{ fontFamily: "'Segoe UI', Tahoma, sans-serif" }}>
      {msg && (
        <div className="fixed top-0 right-0 left-0 z-[60] flex justify-center px-4" style={{ paddingTop: "calc(env(safe-area-inset-top) + 12px)" }}>
          <div className={`flex items-center gap-2.5 px-5 py-3.5 rounded-2xl shadow-xl text-white font-bold text-sm max-w-md w-full justify-center ${/✓|کرا|تۆمار|نێردرا|وەرگ/.test(msg) ? "bg-emerald-600" : "bg-slate-900"}`}>
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
        <main className="p-3 md:p-5 pb-10 max-w-3xl mx-auto"><Portal user={portalUser} {...shared} officePay={officePay} settle={settle} flash={flash} reloadBatches={reloadBatches} /></main>
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
                <select value="" onChange={(e) => e.target.value && setViewAs(e.target.value)}
                  className="w-full border border-stone-300 rounded-lg px-2 py-2 text-xs bg-white">
                  <option value="">کەسێک هەڵبژێرە...</option>
                  {data.users.filter((u) => u.role !== "admin" && !u.deleted).map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              </div>
            )}
          </nav>
          <main className="flex-1 p-3 pb-24 md:p-6 md:pb-6 max-w-5xl w-full mx-auto">
            {page === "dash" && <Dashboard {...shared} go={setPage} />}
            {page === "safes" && <><Back onClick={() => setPage("dash")} t="گەڕانەوە بۆ داشبۆرد" /><Safes {...shared} addDeposit={addDeposit} addExpense={addExpense} addCurrency={addCurrency} /></>}
            {page === "rates" && <><Back onClick={() => setPage("dash")} t="گەڕانەوە بۆ داشبۆرد" /><Rates {...shared} saveRates={saveRates} /></>}
            {page === "profit" && <><Back onClick={() => setPage("dash")} t="گەڕانەوە بۆ داشبۆرد" /><ProfitPage {...shared} /></>}
            {page === "newtx" && <TxForm {...shared} onSave={saveTx} batch={pendingBatch} onClearBatch={() => setPendingBatch(null)} />}
            {page === "txs" && (editTx
              ? <TxForm {...shared} onSave={saveTx} editing={editTx} onCancel={() => setEditTx(null)} />
              : <TxList {...shared} onEdit={setEditTx} onDel={delTx} settle={settle} />)}
            {page === "receipts" && <ReceiptInbox {...shared} batches={batches} reloadBatches={reloadBatches} flash={flash} profile={profile}
              onMakeTx={(b) => { setPendingBatch(b); setPage("newtx"); }} />}
            {page === "people" && <PeopleHub {...shared} detailId={detailId} setDetailId={setDetailId} onSave={saveTx} transfer={transfer} officePay={officePay} settle={settle} createUser={createUser} deleteUser={deleteUser} setUserRate={setUserRate} flash={flash} />}
            {page === "report" && <Report {...shared} />}
            {page === "audit" && <Audit data={data} />}
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
                    <Sel value="" onChange={(e) => { if (e.target.value) { setViewAs(e.target.value); setMore(false); } }}>
                      <option value="">کەسێک هەڵبژێرە...</option>
                      {data.users.filter((u) => u.role !== "admin" && !u.deleted).map((u) => (
                        <option key={u.id} value={u.id}>{u.name} ({ROLE_KU[u.role]})</option>
                      ))}
                    </Sel>
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
function Dashboard({ data, calc, cur, mySafe, profitIn, investorsProfitIn, sumUsd, ratesReady, owners, go }) {
  const today = dOnly(new Date().toISOString());
  const todayTxs = data.txs.filter((t) => !t.deleted && dOnly(t.date) === today);
  const pTod = profitIn(today, today);
  const invTod = investorsProfitIn(pTod);
  const pendBuy = data.txs.filter((t) => !t.deleted && t.status === "pending" && t.type === "buy").length;
  const pendSell = data.txs.filter((t) => !t.deleted && t.status === "pending" && t.type === "sell").length;
  const pendingCount = pendBuy + pendSell;
  const noRates = data.currencies.some((c) => c.id !== "usd" && (!c.buyRate || !c.sellRate));

  const Stat = ({ t, v, tone }) => (
    <Card className="p-4">
      <div className="text-xs text-slate-500 mb-1">{t}</div>
      <div className={`text-2xl font-bold ${tone || ""}`} style={num}>{v}</div>
    </Card>
  );

  return (
    <div className="space-y-4">
      <H sub={new Date().toLocaleDateString("en-GB")}>داشبۆرد</H>

      {noRates && (
        <Card className="p-4 border-amber-300 bg-amber-50/60" onClick={() => go("rates")}>
          <div className="flex items-center gap-2 text-sm text-amber-900 font-semibold">
            <AlertTriangle className="w-4 h-4" /> هێشتا نرخی هەموو دراوەکان دانەنراوە — کلیک بکە بۆ دانانی نرخی ئەمڕۆ
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat t="مامەڵەی ئەمڕۆ" v={todayTxs.length} />
        <Stat t="کڕین" v={todayTxs.filter((t) => t.type === "buy").length} tone="text-emerald-700" />
        <Stat t="فرۆشتن" v={todayTxs.filter((t) => t.type === "sell").length} tone="text-rose-700" />
        <Stat t="چاوەڕوانی پارە" v={pendingCount} tone={pendingCount ? "text-amber-600" : ""} />
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
              <span className="text-slate-600">{c.name}</span>
              <span style={num} className="text-slate-800">
                <span className="text-emerald-700 font-semibold">{c.buyRate ? fmt(c.buyRate, 4) : "—"}</span>
                <span className="text-slate-300 mx-1.5">/</span>
                <span className="text-rose-700 font-semibold">{c.sellRate ? fmt(c.sellRate, 4) : "—"}</span>
              </span>
            </div>
          ))}
          <div className="text-[11px] text-slate-400 mt-2">کڕین / فرۆشتن — چەند یەکە بەرامبەر ١ دۆلار</div>
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
            <div className="text-2xl font-bold" style={num}>{fmt(sumUsd(calc.phys), 0)} <span className="text-sm text-amber-400">$</span></div>
          </div>
          <div className="bg-emerald-700 text-white rounded-xl p-4">
            <div className="text-[11px] text-emerald-100">ماڵی خۆم بە دۆلار</div>
            <div className="text-2xl font-bold" style={num}>{fmt(sumUsd(mySafe), 0)} <span className="text-sm text-amber-300">$</span></div>
          </div>
        </div>
      )}

      <div className="text-[11px] text-slate-400 mb-2">کلیک لە هەر دراوێک بکە بۆ وردەکاری</div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5">
        {data.currencies.map((cc) => {
          const isOpen = open === cc.id;
          return (
            <button key={cc.id} onClick={() => { setOpen(isOpen ? null : cc.id); setView("where"); }}
              className={`text-right border rounded-xl p-3.5 transition ${isOpen ? "border-emerald-600 bg-emerald-50/60 ring-2 ring-emerald-600/15" : "border-stone-200 bg-stone-50/60 hover:border-emerald-400"}`}>
              <div className="text-xs text-slate-500">{cc.name}</div>
              <div className="text-xl mt-0.5"><Money v={calc.phys[cc.id] || 0} dec={0} /> <span className="text-amber-600 text-sm">{cc.symbol}</span></div>
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
  const [rows, setRows] = useState(data.currencies.filter((c) => c.id !== "usd").map((c) => ({ id: c.id, code: c.code, name: c.name, buyRate: c.buyRate ?? "", sellRate: c.sellRate ?? "" })));
  const upd = (id, k, v) => setRows(rows.map((r) => (r.id === id ? { ...r, [k]: v } : r)));
  const last = data.currencies.find((c) => c.rateUpdated)?.rateUpdated;
  return (
    <div className="space-y-4">
      <H sub="چەند یەکە بەرامبەر ١ دۆلار — دوای دانانی نرخ، لە مامەڵەکاندا ئۆتۆماتیکی بەکاردێت">نرخی ئەمڕۆ</H>
      <Card className="p-5">
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-2 items-center">
          <div className="text-xs font-semibold text-slate-500">دراو</div>
          <div className="text-xs font-semibold text-emerald-700 w-28 text-center">نرخی کڕین</div>
          <div className="text-xs font-semibold text-rose-700 w-28 text-center">نرخی فرۆشتن</div>
          {rows.map((r) => (
            <React.Fragment key={r.id}>
              <div className="text-sm text-slate-700 py-1">{r.name} <span className="text-slate-400 text-xs">({r.code})</span></div>
              <Inp type="number" step="any" dir="ltr" value={r.buyRate} onChange={(e) => upd(r.id, "buyRate", e.target.value)} className="w-28 text-center" />
              <Inp type="number" step="any" dir="ltr" value={r.sellRate} onChange={(e) => upd(r.id, "sellRate", e.target.value)} className="w-28 text-center" />
            </React.Fragment>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Btn onClick={() => saveRates(rows)}>پاشەکەوتکردنی نرخەکان</Btn>
          {last && <span className="text-xs text-slate-400">دوا نوێکردنەوە: {new Date(last).toLocaleString("en-GB")}</span>}
        </div>
      </Card>
      <Card className="p-4 bg-stone-50/60">
        <div className="text-xs text-slate-500 leading-relaxed">
          نموونە: گەر یەن بە <b>٧.٢٠</b> دەکڕیت و بە <b>٧.١٥</b> دەیفرۆشیت، واتا بەرامبەر ١ دۆلار ٧.٢٠ یەن وەردەگریت و ٧.١٥ یەن دەفرۆشیت — جیاوازییەکە خێری تۆیە.
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
                <span className="text-sm flex items-center gap-1.5">
                  <ChevronLeft className={`w-3.5 h-3.5 transition-transform ${openCur === c.id ? "-rotate-90" : "rotate-180"}`} />
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
          <div className="flex items-end"><Btn kind="gold" className="w-full" onClick={() => { if (nc.code && nc.name) { addCurrency(nc); setNc({ code: "", name: "", symbol: "", dec: 2 }); } }}>زیادکردن</Btn></div>
        </div>
      </Card>
    </div>
  );
}

/* ══════════════════ فۆرمی مامەڵە ══════════════════ */
function TxForm({ data, cur, calc, usr, avgRate, autoRate, onSave, editing, onCancel, lockCp, batch, onClearBatch }) {
  const e = editing;
  const bCur = batch ? data.currencies.find((c) => c.code === batch.currency)?.id : null;
  const [f, setF] = useState({
    type: e ? e.type : "buy",
    curId: e ? e.curId : (bCur || data.currencies.find((c) => c.id !== "usd")?.id || data.currencies[0]?.id),
    amount: e ? e.amount : (batch ? Math.round(batch.total_net) : ""),
    againstId: e ? e.againstId : "usd",
    rate: e ? e.rate : "",
    manualRate: !!e,
    cpMode: e ? (e.cpId ? "acc" : "free") : "acc",
    cpId: e ? e.cpId || "" : (lockCp || batch?.customer_id || ""),
    cpName: e ? e.cpName || "" : "",
    partnerId: e ? e.partnerId || "" : "",
    status: e ? e.status : "completed",
    note: e ? e.note : "",
  });
  const customers = data.users.filter((u) => u.role === "customer" && !u.deleted);
  const partners = data.users.filter((u) => u.role === "partner" && !u.deleted);

  const auto = autoRate(f.type, f.curId, f.againstId);
  // نرخی ڕۆژ خۆکار دادەنرێت، بەڵام هەر کاتێک دەتوانیت بیگۆڕیت
  useEffect(() => {
    if (!f.manualRate && auto) setF((x) => (+x.rate === auto ? x : { ...x, rate: auto }));
  }, [auto, f.manualRate]);
  const rate = +f.rate || 0;
  const offDay = auto && rate && Math.abs(rate - auto) > auto * 0.0001;
  const amtR = Math.round(+f.amount || 0);
  const total = Math.round(amtR * rate);
  const av = f.type === "sell" ? avgRate(f.curId, f.againstId) : null;
  const estProfit = f.type === "sell" && av !== null ? Math.round(total - av * amtR) : null;
  const srcBal = f.partnerId ? ((calc.partner[f.partnerId] || {})[f.curId] || 0) : (calc.atMe[f.curId] || 0);
  const willBeNeg = f.type === "sell" && srcBal - amtR < 0;
  const feeRate = f.partnerId ? (usr(f.partnerId).rate || 0) : 0;

  const submit = () => onSave({ ...f, rate, batchId: batch?.id }, e);

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
          {["buy", "sell"].map((t) => (
            <button key={t} onClick={() => setF({ ...f, type: t, manualRate: false, status: "completed" })}
              className={`flex-1 py-2.5 rounded-xl font-bold text-sm transition ${f.type === t ? (t === "buy" ? "bg-emerald-700 text-white shadow-sm" : "bg-rose-700 text-white shadow-sm") : "bg-stone-100 text-slate-500 hover:bg-stone-200"}`}>
              {t === "buy" ? "کڕین" : "فرۆشتن"}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div><Lbl>دراو</Lbl><Sel value={f.curId} onChange={(ev) => setF({ ...f, curId: ev.target.value, manualRate: false })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
          <div><Lbl>بڕ</Lbl><Inp type="number" value={f.amount} onChange={(ev) => setF({ ...f, amount: ev.target.value })} placeholder="0" /></div>
          <div><Lbl>بەرامبەر دراوی</Lbl><Sel value={f.againstId} onChange={(ev) => setF({ ...f, againstId: ev.target.value, manualRate: false })}>{data.currencies.filter((c) => c.id !== f.curId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
        </div>

        <div className="bg-stone-50 border border-stone-200 rounded-xl p-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className="text-xs text-slate-500">کۆی گشتی</div>
              <div className="text-2xl"><Money v={total} dec={cur(f.againstId).dec} /> <span className="text-sm text-slate-500">{cur(f.againstId).code}</span></div>
            </div>
            <div className="text-left">
              <div className="text-xs text-slate-500 mb-1">نرخی یەک یەکە</div>
              <Inp type="number" step="any" dir="ltr" value={f.rate}
                onChange={(ev) => setF({ ...f, rate: ev.target.value, manualRate: true })}
                className={`w-36 text-center font-bold ${offDay ? "border-amber-500 bg-amber-50" : ""}`} />
            </div>
          </div>

          <div className="flex items-center justify-between flex-wrap gap-2 mt-3 pt-3 border-t border-stone-200 text-xs">
            <span className="text-slate-500">
              نرخی ڕۆژ: <b style={num} className="text-slate-700">{auto ? fmt(auto, 6) : "دانەنراوە"}</b>
            </span>
            {offDay && (
              <div className="flex items-center gap-2">
                <span className="text-amber-700 font-semibold">نرخێکی تایبەت بەکاردێت</span>
                <button onClick={() => setF({ ...f, manualRate: false, rate: auto })}
                  className="text-emerald-700 font-semibold underline">گەڕانەوە بۆ نرخی ڕۆژ</button>
              </div>
            )}
          </div>

          {(av !== null || estProfit !== null) && (
            <div className="flex gap-5 flex-wrap text-sm mt-3 pt-3 border-t border-stone-200">
              {av !== null && <span className="text-slate-500">مامناوەندی کڕین: <span style={num}>{fmt(av, 6)}</span></span>}
              {estProfit !== null && <span className="text-slate-500">خێری خەمڵێنراو: <Money v={estProfit} dec={cur(f.againstId).dec} pos /></span>}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Lbl>{f.type === "buy" ? "لە کوێ دای دەنێیت؟" : "لە کوێوە دەفرۆشیت؟"}</Lbl>
            <Sel value={f.partnerId} onChange={(ev) => setF({ ...f, partnerId: ev.target.value })}>
              <option value="">قاسەی گشتی — {fmt(calc.atMe[f.curId] || 0, cur(f.curId).dec)} {cur(f.curId).code}</option>
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

        {!lockCp && (
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
          <Btn kind={f.type === "buy" ? "primary" : "danger"} onClick={submit}>{e ? "پاشەکەوتی ئیدیت" : f.type === "buy" ? "تۆمارکردنی کڕین" : "تۆمارکردنی فرۆشتن"}</Btn>
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
function TxList({ data, cur, usr, onEdit, onDel, settle }) {
  const base = [...data.txs].filter((t) => !t.deleted).reverse();
  const [list, f, setF] = useTxFilter(base, cur, usr);
  const total = {};
  list.forEach((t) => { total[cur(t.againstId).code || "?"] = (total[cur(t.againstId).code || "?"] || 0) + t.total; });
  return (
    <div className="space-y-3">
      <H>مامەڵەکان</H>
      <TxFilterBar data={data} f={f} setF={setF} count={list.length} total={total} />
      {list.length === 0 ? <Card><Empty t="هیچ مامەڵەیەک نەدۆزرایەوە" /></Card> :
        list.map((t) => <TxRow key={t.id} t={t} cur={cur} usr={usr} onEdit={onEdit} onDel={onDel} settle={settle} />)}
    </div>
  );
}

/* flip = بینینی مامەڵەکە لە ڕوانگەی لایەنی بەرامبەرەوە / lite = بێ وردەکاری ناوخۆیی */
function TxRow({ t, cur, usr, onEdit, onDel, flip, lite, settle }) {
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
            <Pill tone={shown === "buy" ? "green" : "red"}>{shown === "buy" ? "کڕین" : "فرۆشتن"}</Pill>
            <span className="font-bold text-slate-900" style={num}>{fmt(t.amount, 0)}</span>
            <span className="text-sm text-slate-500">{cur(t.curId).code}</span>
            <span className="text-slate-300 mx-0.5">←</span>
            <span className="font-bold text-slate-900" style={num}>{fmt(t.total, 0)}</span>
            <span className="text-sm text-slate-500">{cur(t.againstId).code}</span>
          </div>
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap mt-1.5 text-xs text-slate-500">
            {t.code && <span className="font-bold text-slate-400" style={num}>#{t.code}</span>}
            {!lite && name && <span className="text-slate-700 font-semibold">{name}</span>}
            <span style={num}>نرخ {fmt(t.rate, 6)}</span>
            {!lite && t.partnerId && <span className="text-amber-700">لای {usr(t.partnerId).name}</span>}
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
    </Card>
  );
}
/* ══════════════════ فیشەکان ══════════════════ */

/* بچووککردنەوەی وێنە + هێمای یەکتاگەری */
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

/* وێنەی فیش لە Storage — بە لینکی کاتی */
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

/* ─────────── ئەپلۆدکەری فیش ─────────── */
function ReceiptUploader({ customerId, customerName, uploaderId, onDone, flash, data }) {
  const [rows, setRows] = useState([]);
  const [working, setWorking] = useState(false);
  const [prog, setProg] = useState(null);
  const [sending, setSending] = useState(false);
  const [maxAge] = useState(7);

  const onFiles = async (files) => {
    const list = Array.from(files || []).filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    setWorking(true);
    const out = [...rows];
    try {
      // پشکنینی دووبارە بەسەر هەموو فیشەکاندا (تەنانەت هی کڕیارانی تریش)
      let oldHash = new Map(), oldRef = new Map();
      const preHashes = [], preRefs = [];
      for (const f of list) { /* هێماکان دواتر پڕ دەکرێنەوە */ }

      for (let i = 0; i < list.length; i++) {
        setProg(`${i + 1} لە ${list.length}`);
        const f = list[i];
        let img;
        try { img = await prepImage(f); }
        catch { out.push({ id: uid(), status: "error", note: "نەتوانرا وێنەکە بکرێتەوە" }); setRows([...out]); continue; }

        // پرسیار لە سێرڤەر: ئایا ئەم وێنەیە پێشتر ناردراوە؟
        let inOld = null;
        try {
          const { data: hit } = await supabase.rpc("check_receipt_dupe", { p_hash: img.hash, p_ref: null });
          if (hit && hit.length) inOld = hit[0];
        } catch { /* فەنکشنەکە هێشتا درووست نەکراوە */ }
        const inBatch = out.find((r) => r.hash === img.hash);
        if (inBatch || inOld) {
          out.push({ id: uid(), url: img.url, hash: img.hash, status: "dup",
            note: inBatch ? "هەمان وێنە لەم کۆمەڵەیەدا" : `هەمان وێنە پێشتر ناردراوە (${inOld?.d ? new Date(inOld.d).toLocaleDateString("en-GB") : "پێشتر"})` });
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
          out.push({ id: uid(), url: img.url, hash: img.hash, blob: img.blob, status: "error", note: String(e.message || e) });
          setRows([...out]); continue;
        }
        if (d.ok === false) {
          out.push({ id: uid(), url: img.url, hash: img.hash, status: "error", note: d.note || "فیش نییە" });
          setRows([...out]); continue;
        }

        const rn = normRef(d.refNo);
        let status = "ok", note = "";
        if (rn) {
          const bch = out.find((r) => r.refNo && normRef(r.refNo) === rn);
          let o = null;
          try {
            const { data: hit } = await supabase.rpc("check_receipt_dupe", { p_hash: null, p_ref: rn });
            if (hit && hit.length) o = hit[0];
          } catch {}
          if (bch || o) { status = "dup"; note = bch ? "هەمان ژمارەی مامەڵە لەم کۆمەڵەیەدا" : `ئەم ژمارە مامەڵەیە پێشتر ناردراوە (${o?.d ? new Date(o.d).toLocaleDateString("en-GB") : "پێشتر"})`; }
        }
        if (status === "ok") {
          const same = out.find((r) => r.status !== "dup" && r.amount && +r.amount === +d.amount && r.txTime && d.txTime && r.txTime === d.txTime);
          if (same) { status = "suspect"; note = "هەمان بڕ لە هەمان کاتدا"; }
        }
        let ageDays = null;
        if (d.txDate && /^\d{4}-\d{2}-\d{2}$/.test(d.txDate)) {
          ageDays = Math.floor((Date.now() - new Date(d.txDate + "T12:00:00").getTime()) / 86400000);
          if (status === "ok" && ageDays > maxAge) { status = "suspect"; note = `ڕێکەوتی کۆن — ${ageDays} ڕۆژ لەمەوبەر`; }
        }
        if (status === "ok" && d.confidence != null && d.confidence < 0.6) { status = "suspect"; note = "خوێندنەوەکە دڵنیا نییە"; }

        const feeV = +d.fee || 0;
        const netV = d.netAmount != null ? +d.netAmount : (+d.amount || 0) - feeV;
        out.push({ id: uid(), url: img.url, blob: img.blob, hash: img.hash, status, note,
          amount: +d.amount || 0, fee: feeV, net: netV, currency: d.currency, sender: d.sender,
          receiver: d.receiver, refNo: d.refNo, txTime: d.txTime, txDate: d.txDate, ageDays, bank: d.bank, raw: d });
        setRows([...out]);
      }
    } finally { setWorking(false); setProg(null); }
  };

  const good = rows.filter((r) => r.status === "ok" || r.status === "suspect");
  const dupN = rows.filter((r) => r.status === "dup").length;
  const gross = {}, fees = {}, net = {}, byRecv = {};
  good.forEach((r) => {
    const c = r.currency || "?";
    gross[c] = (gross[c] || 0) + (+r.amount || 0);
    fees[c] = (fees[c] || 0) + (+r.fee || 0);
    net[c] = (net[c] || 0) + (+r.net || 0);
    const k = (r.receiver || "نەزانراو").trim();
    byRecv[k] = byRecv[k] || { n: 0, cur: {} };
    byRecv[k].n++;
    byRecv[k].cur[c] = (byRecv[k].cur[c] || 0) + (+r.net || 0);
  });
  const mainCur = Object.keys(gross).sort((a, b) => gross[b] - gross[a])[0] || null;

  const send = async () => {
    if (!good.length) return flash("هیچ فیشێکی دروست نییە");
    setSending(true);
    try {
      const batchId = uid();
      const recs = [];
      for (const r of good) {
        let path = null;
        if (r.blob) {
          path = `${customerId}/${batchId}/${r.id}.jpg`;
          const up = await supabase.storage.from("receipts").upload(path, r.blob, { contentType: "image/jpeg", upsert: false });
          if (up.error) { console.error(up.error); path = null; }
        }
        recs.push({
          id: r.id, batch_id: batchId, customer_id: customerId, customer_name: customerName,
          amount: r.amount || null, fee: r.fee || 0, net_amount: r.net ?? null, currency: r.currency || null,
          sender: r.sender || null, receiver: r.receiver || null, ref_no: r.refNo || null,
          tx_time: r.txTime || null, tx_date: r.txDate || null, bank: r.bank || null,
          note: r.note || null, image_hash: r.hash, image_path: path, status: r.status,
          uploaded_by: uploaderId || null, raw: r.raw || null,
        });
      }
      const b = await supabase.from("receipt_batches").insert({
        id: batchId, customer_id: customerId, customer_name: customerName, status: "new",
        currency: mainCur, total_gross: gross[mainCur] || 0, total_fee: fees[mainCur] || 0,
        total_net: net[mainCur] || 0, n: good.length, dup_n: dupN,
      });
      if (b.error) throw b.error;
      const rr = await supabase.from("receipts").insert(recs);
      if (rr.error) throw rr.error;
      flash(`${good.length} فیش نێردرا ✓`);
      setRows([]);
      onDone && onDone();
    } catch (e) { console.error(e); flash("هەڵە لە ناردن — دووبارە هەوڵ بدە"); }
    finally { setSending(false); }
  };

  const ST = { ok: { tone: "green", t: "دروست" }, dup: { tone: "red", t: "دووبارە" }, suspect: { tone: "amber", t: "گومانلێکراو" }, error: { tone: "slate", t: "هەڵە" } };

  return (
    <div className="space-y-4">
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
                <AlertTriangle className="w-4 h-4" /> {dupN} فیشی دووبارە دۆزرایەوە — ناژمێردرێن
              </div>
            </Card>
          )}
          {rows.filter((r) => r.status === "error").length > 0 && (
            <Card className="p-4 border-amber-300 bg-amber-50/60">
              <div className="text-sm text-amber-900">
                <div className="font-semibold mb-1">{rows.filter((r) => r.status === "error").length} فیش نەخوێندرایەوە:</div>
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
                    {r.fee > 0 && <span className="text-[11px] text-rose-600">فی {fmt(r.fee, 0)}</span>}
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

          <ReceiptTotals gross={gross} fees={fees} net={net} byRecv={byRecv} n={good.length} dupN={dupN} data={data} />

          <Btn className="w-full" onClick={send} disabled={sending || !good.length}>
            {sending ? "ناردن..." : `ناردنی ${good.length} فیش`}
          </Btn>
        </>
      )}
    </div>
  );
}

/* کۆکردنەوەی فیشەکان */
function ReceiptTotals({ gross, fees, net, byRecv, n, dupN, data }) {
  const recvList = Object.entries(byRecv || {}).sort((a, b) => b[1].n - a[1].n);
  const u = usdConv(data);
  return (
    <>
      {recvList.length > 0 && (
        <Card className="p-5">
          <SecLbl>بۆ کێ نێردراوە</SecLbl>
          {recvList.map(([name, v]) => (
            <div key={name} className="flex items-center justify-between py-2.5 border-b border-stone-100 last:border-0">
              <div>
                <div className="font-semibold text-slate-800">{name}</div>
                <div className="text-xs text-slate-400" style={num}>{v.n} فیش</div>
              </div>
              <div className="text-left">
                {Object.entries(v.cur).map(([c, a]) => (
                  <div key={c}>
                    <div className="text-lg font-bold text-slate-900" style={num}>{fmt(a, 0)} <span className="text-xs font-normal text-slate-500">{c}</span></div>
                    <div className="text-[11px]"><UsdHint v={u(a, c)} /></div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Card>
      )}
      <Card className="p-5">
        <SecLbl>کۆی گشتی</SecLbl>
        {Object.keys(gross).length === 0 ? <Empty t="هیچ" /> :
          Object.keys(gross).map((c) => (
            <div key={c} className="bg-stone-50 border border-stone-200 rounded-xl p-4 mb-2 last:mb-0">
              <div className="text-xs font-semibold text-slate-500 mb-2">{c}</div>
              <div className="flex justify-between py-1.5">
                <span className="text-sm text-slate-600">کۆی ناردراو (بە فییەوە)</span>
                <span className="text-lg font-bold text-slate-800" style={num}>{fmt(gross[c], 0)}</span>
              </div>
              {fees[c] > 0 && (
                <div className="flex justify-between py-1 text-sm">
                  <span className="text-slate-500">فی</span>
                  <span className="text-rose-700 font-semibold" style={num}>− {fmt(fees[c], 0)}</span>
                </div>
              )}
              <div className="flex justify-between pt-2.5 mt-1 border-t border-stone-200 items-baseline">
                <span className="text-sm font-bold text-slate-800">بێ فی (گەیشتووە)</span>
                <div className="text-left">
                  <div className="text-2xl font-bold text-emerald-700" style={num}>{fmt(net[c], 0)}</div>
                  <div className="text-xs"><UsdHint v={u(net[c], c)} /></div>
                </div>
              </div>
            </div>
          ))}
        <div className="text-xs text-slate-400 mt-2 flex flex-wrap gap-x-3" style={num}>
          <span>{n} فیش{dupN ? ` · ${dupN} دووبارە دەرکراوە` : ""}</span>
          {Object.keys(gross).map((c) => {
            const cc = (data?.currencies || []).find((x) => x.code === c);
            if (!cc || cc.id === "usd") return null;
            const mid = cc.buyRate && cc.sellRate ? (cc.buyRate + cc.sellRate) / 2 : (cc.buyRate || cc.sellRate);
            return mid ? <span key={c}>نرخی {c}: {fmt(mid, 4)}</span> : null;
          })}
        </div>
      </Card>
    </>
  );
}

/* ─────────── ئینباکسی ئەدمین ─────────── */
function ReceiptInbox({ data, usr, batches, reloadBatches, flash, onMakeTx, profile }) {
  const u = usdConv(data);
  const [sel, setSel] = useState(null);
  const [tab, setTab] = useState("new");
  const [addFor, setAddFor] = useState("");
  const customers = data.users.filter((u) => u.role === "customer" && !u.deleted);

  if (sel) return <BatchDetail id={sel} back={() => { setSel(null); reloadBatches(); }} usr={usr} data={data} onMakeTx={onMakeTx} flash={flash} reloadBatches={reloadBatches} />;

  const list = (batches || []).filter((b) => (tab === "new" ? b.status === "new" : b.status !== "new"));
  const newN = (batches || []).filter((b) => b.status === "new").length;

  return (
    <div className="space-y-4">
      <H sub="کڕیارەکان فیشەکانیان لێرەوە دەنێرن — تۆ پشکنینیان دەکەیت و مامەڵەکەیان بۆ درووست دەکەیت">فیشەکان</H>

      {newN > 0 && (
        <Card className="p-4 border-emerald-300 bg-emerald-50/50">
          <div className="flex items-center gap-2 text-sm text-emerald-900 font-semibold">
            <ScanLine className="w-4 h-4" /> {newN} کۆمەڵەی نوێی فیش چاوەڕوانی پشکنینن
          </div>
        </Card>
      )}

      <div className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1">
        {[["new", `نوێ (${newN})`], ["done", "بەستراوەکان"]].map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-1 py-2.5 rounded-lg text-sm ${tab === k ? "bg-emerald-700 text-white font-semibold" : "text-slate-600 hover:bg-stone-100"}`}>{t}</button>
        ))}
      </div>

      {list.length === 0 ? <Card><Empty t={tab === "new" ? "هیچ کۆمەڵەیەکی نوێ نییە" : "هیچ نییە"} /></Card> :
        list.map((b) => (
          <Card key={b.id} className="p-4" onClick={() => setSel(b.id)}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold text-slate-800">{b.customer_name || "—"}</div>
                <div className="text-xs text-slate-500 mt-0.5" style={num}>
                  {b.n} فیش · {new Date(b.created_at).toLocaleString("en-GB")}
                </div>
                <div className="flex gap-1.5 mt-1.5 flex-wrap">
                  {b.status === "new" ? <Pill tone="green">نوێ</Pill> : <Pill tone="slate">بەستراوە</Pill>}
                  {b.dup_n > 0 && <Pill tone="red">{b.dup_n} دووبارە</Pill>}
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
        ))}

      <Card className="p-5">
        <SecLbl>ناردنی فیش لە جیاتی کڕیارێک</SecLbl>
        <Sel value={addFor} onChange={(e) => setAddFor(e.target.value)}>
          <option value="">کڕیار هەڵبژێرە...</option>
          {customers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Sel>
        {addFor && (
          <div className="mt-3">
            <ReceiptUploader customerId={addFor} customerName={usr(addFor).name} uploaderId={profile?.id} data={data}
              flash={flash} onDone={() => { setAddFor(""); reloadBatches(); }} />
          </div>
        )}
      </Card>
    </div>
  );
}

/* ─────────── وردەکاری کۆمەڵەیەک ─────────── */
function BatchDetail({ id, back, usr, data, onMakeTx, flash, reloadBatches }) {
  const [b, setB] = useState(null);
  const [recs, setRecs] = useState(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    (async () => {
      const [bb, rr] = await Promise.all([
        supabase.from("receipt_batches").select("*").eq("id", id).single(),
        supabase.from("receipts").select("*").eq("batch_id", id).order("created_at"),
      ]);
      setB(bb.data || null); setRecs(rr.data || []);
    })();
  }, [id]);

  if (!b || !recs) return <Card><Empty t="بارکردن..." /></Card>;

  const good = recs.filter((r) => r.status !== "dup");
  const gross = {}, fees = {}, net = {}, byRecv = {};
  good.forEach((r) => {
    const c = r.currency || "?";
    gross[c] = (gross[c] || 0) + (+r.amount || 0);
    fees[c] = (fees[c] || 0) + (+r.fee || 0);
    net[c] = (net[c] || 0) + (+(r.net_amount ?? r.amount) || 0);
    const k = (r.receiver || "نەزانراو").trim();
    byRecv[k] = byRecv[k] || { n: 0, cur: {} };
    byRecv[k].n++;
    byRecv[k].cur[c] = (byRecv[k].cur[c] || 0) + (+(r.net_amount ?? r.amount) || 0);
  });
  const shown = recs.filter((r) => !q ||
    (r.receiver || "").includes(q) || (r.sender || "").includes(q) ||
    String(r.ref_no || "").includes(q) || String(r.amount || "").includes(q));

  return (
    <div className="space-y-4">
      <Back onClick={back} t="گەڕانەوە" />
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold text-slate-900">{b.customer_name}</h2>
          <div className="text-xs text-slate-500 mt-0.5" style={num}>{new Date(b.created_at).toLocaleString("en-GB")}</div>
        </div>
        {b.status === "new"
          ? <Pill tone="green">چاوەڕوانی مامەڵە</Pill>
          : <Pill tone="slate">بەستراوە بە مامەڵە</Pill>}
      </div>

      <ReceiptTotals gross={gross} fees={fees} net={net} byRecv={byRecv} n={good.length} dupN={recs.length - good.length} data={data} />

      {b.status === "new" && (
        <Card className="p-5 border-emerald-300 bg-emerald-50/40">
          <div className="text-sm text-emerald-900 mb-3">
            ئەم کەسە <b style={num}>{fmt(b.total_net, 0)} {b.currency}</b>ی بۆ ناردوویت — کڕینێکی لێ درووست بکە
          </div>
          <Btn className="w-full" onClick={() => onMakeTx(b)}>درووستکردنی کڕین لەم فیشانەوە</Btn>
        </Card>
      )}
      {b.tx_id && (
        <Card className="p-4">
          <div className="text-sm text-slate-600">
            بەستراوە بە مامەڵەی <b style={num}>#{(data.txs.find((t) => t.id === b.tx_id) || {}).code || "—"}</b>
            {b.partner_id && <> · دانراوە لای <b>{usr(b.partner_id).name}</b></>}
          </div>
        </Card>
      )}

      <Inp value={q} onChange={(e) => setQ(e.target.value)} placeholder="گەڕان بە ناو، ژمارە، یان بڕ..." />

      <div className="grid grid-cols-1 gap-2.5">
        {shown.map((r) => (
          <Card key={r.id} className={`p-3 ${r.status === "dup" ? "bg-rose-50/60 border-rose-200" : ""}`}>
            <div className="flex gap-3">
              {r.image_path
                ? <ReceiptImg path={r.image_path} className="w-20 h-20 object-cover rounded-xl border border-stone-200 shrink-0" />
                : <div className="w-20 h-20 bg-stone-100 rounded-xl shrink-0 flex items-center justify-center text-[10px] text-slate-400">بێ وێنە</div>}
              <div className="min-w-0 flex-1 text-sm">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-lg font-bold text-slate-900" style={num}>{fmt(r.amount, 0)}</span>
                  <span className="text-xs text-slate-500">{r.currency}</span>
                  {r.fee > 0 && <span className="text-[11px] text-rose-600">فی {fmt(r.fee, 0)} → <b style={num}>{fmt(r.net_amount, 0)}</b></span>}
                  {r.status === "dup" && <Pill tone="red">دووبارە</Pill>}
                  {r.status === "suspect" && <Pill tone="amber">گومان</Pill>}
                </div>
                <div className="text-xs text-slate-600 mt-1">بۆ <b>{r.receiver || "—"}</b></div>
                <div className="text-[11px] text-slate-400 mt-0.5" style={num}>{r.ref_no || "—"} · {r.tx_time || "—"}</div>
                {r.note && <div className="text-[11px] text-amber-700 mt-0.5">{r.note}</div>}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

/* ─────────── ئەرشیفی فیشەکانی کڕیارێک ─────────── */
function ReceiptArchive({ customerId }) {
  const [recs, setRecs] = useState(null);
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    supabase.from("receipts").select("*").eq("customer_id", customerId).order("created_at", { ascending: false }).limit(500)
      .then(({ data }) => setRecs(data || []));
  }, [customerId]);

  if (!recs) return <Card><Empty t="بارکردن..." /></Card>;

  const list = recs.filter((r) => {
    const d = (r.tx_date || r.created_at || "").slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (!q) return true;
    const hay = `${r.receiver || ""} ${r.sender || ""} ${r.ref_no || ""} ${r.amount || ""} ${r.bank || ""}`;
    return hay.includes(q);
  });
  const tot = {};
  list.filter((r) => r.status !== "dup").forEach((r) => {
    const c = r.currency || "?";
    tot[c] = (tot[c] || 0) + (+(r.net_amount ?? r.amount) || 0);
  });

  return (
    <div className="space-y-3">
      <Card className="p-4 space-y-2.5">
        <Inp value={q} onChange={(e) => setQ(e.target.value)} placeholder="گەڕان بە ناو، ژمارەی مامەڵە، بڕ..." />
        <div className="grid grid-cols-2 gap-2.5">
          <div><Lbl>لە</Lbl><Inp type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><Lbl>بۆ</Lbl><Inp type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
        <div className="flex gap-4 text-xs text-slate-500 pt-1">
          <span><b style={num}>{list.length}</b> فیش</span>
          {Object.entries(tot).map(([c, v]) => <span key={c}>{c}: <b style={num}>{fmt(v, 0)}</b></span>)}
        </div>
      </Card>

      {list.length === 0 ? <Card><Empty t="هیچ فیشێک نەدۆزرایەوە" /></Card> :
        list.map((r) => (
          <Card key={r.id} className={`p-3 ${r.status === "dup" ? "bg-rose-50/50" : ""}`}>
            <div className="flex gap-3">
              {r.image_path
                ? <ReceiptImg path={r.image_path} className="w-16 h-16 object-cover rounded-lg border border-stone-200 shrink-0" />
                : <div className="w-16 h-16 bg-stone-100 rounded-lg shrink-0" />}
              <div className="min-w-0 flex-1 text-sm">
                <div className="flex items-baseline gap-2">
                  <span className="font-bold text-slate-900" style={num}>{fmt(r.net_amount ?? r.amount, 0)}</span>
                  <span className="text-xs text-slate-500">{r.currency}</span>
                  {r.status === "dup" && <Pill tone="red">دووبارە</Pill>}
                </div>
                <div className="text-xs text-slate-600">بۆ {r.receiver || "—"}</div>
                <div className="text-[11px] text-slate-400" style={num}>{r.ref_no || "—"} · {r.tx_time || new Date(r.created_at).toLocaleDateString("en-GB")}</div>
              </div>
            </div>
          </Card>
        ))}
    </div>
  );
}

/* ─────────── فیشەکانی لای هاوبەشێک ─────────── */
function PartnerReceipts({ partnerId, usr, data }) {
  const u = usdConv(data);
  const [recs, setRecs] = useState(null);
  const [mode, setMode] = useState("month");
  const [view, setView] = useState("list");

  useEffect(() => {
    (async () => {
      const { data: bs } = await supabase.from("receipt_batches").select("id, customer_name").eq("partner_id", partnerId);
      if (!bs?.length) { setRecs([]); return; }
      const names = Object.fromEntries(bs.map((x) => [x.id, x.customer_name]));
      const { data: rs } = await supabase.from("receipts").select("*").in("batch_id", bs.map((x) => x.id)).order("created_at", { ascending: false });
      setRecs((rs || []).filter((r) => r.status !== "dup").map((r) => ({ ...r, _from: r.customer_name || names[r.batch_id] })));
    })();
  }, [partnerId]);

  if (!recs) return <Card><Empty t="بارکردن..." /></Card>;
  if (!recs.length) return <Card><Empty t="هێشتا هیچ فیشێک بۆ تۆ دانەنراوە" /></Card>;

  const t = new Date(), iso = (d) => d.toISOString().slice(0, 10);
  const w = new Date(t); w.setDate(w.getDate() - w.getDay());
  const m = new Date(t.getFullYear(), t.getMonth(), 1);
  const y = new Date(t.getFullYear(), 0, 1);
  const from = mode === "day" ? iso(t) : mode === "week" ? iso(w) : mode === "month" ? iso(m) : mode === "year" ? iso(y) : "0000-01-01";
  const list = recs.filter((r) => ((r.tx_date || r.created_at || "").slice(0, 10)) >= from);

  const tot = {}, bySender = {};
  list.forEach((r) => {
    const c = r.currency || "?";
    const v = +(r.net_amount ?? r.amount) || 0;
    tot[c] = (tot[c] || 0) + v;
    const k = (r._from || r.sender || "نەزانراو").trim();
    bySender[k] = bySender[k] || { n: 0, cur: {} };
    bySender[k].n++;
    bySender[k].cur[c] = (bySender[k].cur[c] || 0) + v;
  });
  const senders = Object.entries(bySender).sort((a, b) => b[1].n - a[1].n);

  return (
    <div className="space-y-3">
      <div className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1 overflow-x-auto">
        {[["day", "ئەمڕۆ"], ["week", "هەفتە"], ["month", "مانگ"], ["year", "ساڵ"], ["all", "هەمووی"]].map(([k, lbl]) => (
          <button key={k} onClick={() => setMode(k)}
            className={`flex-1 whitespace-nowrap py-2.5 px-3 rounded-lg text-sm ${mode === k ? "bg-emerald-700 text-white font-semibold" : "text-slate-600"}`}>{lbl}</button>
        ))}
      </div>

      <Card dark className="p-5">
        <div className="text-xs text-slate-400 mb-2">کۆی ئەو پارەیەی هاتووە</div>
        {Object.entries(tot).map(([c, v]) => (
          <div key={c} className="flex justify-between items-baseline py-1.5">
            <span className="text-sm text-slate-300">{c}</span>
            <div className="text-left">
              <div className="text-2xl font-bold" style={num}>{fmt(v, 0)}</div>
              {u(v, c) != null && <div className="text-[11px] text-amber-400" style={num}>≈ {fmt(u(v, c), 0)} $</div>}
            </div>
          </div>
        ))}
        <div className="text-[11px] text-slate-400 mt-2" style={num}>{list.length} فیش</div>
      </Card>

      <Card className="p-5">
        <SecLbl>کێ ناردوویەتی</SecLbl>
        {senders.map(([n, v]) => (
          <div key={n} className="flex items-center justify-between py-2.5 border-b border-stone-100 last:border-0">
            <div>
              <div className="font-semibold text-slate-800">{n}</div>
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

      <div className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1">
        {[["list", "وردەکاری"], ["gallery", "وێنەکان"]].map(([k, lbl]) => (
          <button key={k} onClick={() => setView(k)}
            className={`flex-1 py-2.5 rounded-lg text-sm ${view === k ? "bg-emerald-700 text-white font-semibold" : "text-slate-600"}`}>{lbl}</button>
        ))}
      </div>

      {view === "gallery" ? (
        <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
          {list.filter((r) => r.image_path).map((r) => (
            <div key={r.id} className="relative">
              <ReceiptImg path={r.image_path} className="w-full aspect-square object-cover rounded-xl border border-stone-200" />
              <div className="absolute bottom-1 right-1 left-1 bg-slate-900/80 text-white text-[10px] rounded-lg px-1.5 py-0.5 text-center" style={num}>
                {fmt(r.net_amount ?? r.amount, 0)}
              </div>
            </div>
          ))}
          {list.filter((r) => r.image_path).length === 0 && <div className="col-span-full"><Empty t="هیچ وێنەیەک نییە" /></div>}
        </div>
      ) : (
        list.map((r) => (
          <Card key={r.id} className="p-3">
            <div className="flex gap-3">
              {r.image_path
                ? <ReceiptImg path={r.image_path} className="w-16 h-16 object-cover rounded-lg border border-stone-200 shrink-0" />
                : <div className="w-16 h-16 bg-stone-100 rounded-lg shrink-0" />}
              <div className="min-w-0 flex-1 text-sm">
                <div className="flex items-baseline gap-2">
                  <span className="font-bold text-slate-900" style={num}>{fmt(r.net_amount ?? r.amount, 0)}</span>
                  <span className="text-xs text-slate-500">{r.currency}</span>
                  {r.fee > 0 && <span className="text-[11px] text-slate-400" style={num}>بە فی {fmt(r.amount, 0)}</span>}
                </div>
                <div className="text-xs text-slate-600 mt-0.5">لە <b>{r._from || r.sender || "—"}</b>{r.receiver && <> بۆ {r.receiver}</>}</div>
                <div className="text-[11px] text-slate-400 mt-0.5" style={num}>
                  ژمارە {r.ref_no || "—"} · {r.tx_time || new Date(r.created_at).toLocaleString("en-GB")}
                </div>
              </div>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}


/* ══════════════════ ناوەندی بەکارهێنەران ══════════════════ */
function PeopleHub(p) {
  const [tab, setTab] = useState("customers");
  const TABS = [["customers", "کڕیاران", Users], ["partners", "هاوبەشان", Handshake], ["investors", "وەبەرهێنەران", TrendingUp], ["office", "نووسینگە", Building2], ["manage", "بەڕێوەبردن", UserCog]];
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
      {tab === "office" && <Office {...p} />}
      {tab === "manage" && <UsersAdmin {...p} />}
    </div>
  );
}

/* ══════════════════ کڕیاران ══════════════════ */
function Customers({ data, calc, cur, usr, detailId, setDetailId, onSave, settle, ...rest }) {
  const customers = data.users.filter((u) => u.role === "customer" && !u.deleted);
  const [q, setQ] = useState("");
  if (detailId) return <CustomerDetail id={detailId} back={() => setDetailId(null)} data={data} calc={calc} cur={cur} usr={usr} onSave={onSave} settle={settle} {...rest} />;
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
function CustomerDetail({ id, back, data, calc, cur, usr, onSave, settle, ...rest }) {
  const u = usr(id);
  const c = calc.cust[id] || { owe: {}, due: {} };
  const base = data.txs.filter((t) => !t.deleted && t.cpId === id).reverse();
  const [list, f, setF] = useTxFilter(base, cur, usr);
  const [tab, setTab] = useState("history");
  return (
    <div className="space-y-4">
      <Back onClick={back} t="گەڕانەوە بۆ لیستی کڕیاران" />
      <div>
        <h2 className="text-xl font-bold text-slate-900">{u.name}</h2>
        {(u.phone || u.address) && <div className="text-xs text-slate-500 mt-0.5">{u.phone && <span style={num}>{u.phone}</span>}{u.phone && u.address && " · "}{u.address}</div>}
      </div>

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
        {[["history", "مێژوو"], ["receipts", "فیشەکان"], ["new", "مامەڵەی نوێ"]].map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-1 px-4 py-2.5 rounded-lg text-sm ${tab === k ? "bg-emerald-700 text-white font-semibold" : "text-slate-600 hover:bg-stone-100"}`}>{t}</button>
        ))}
      </div>

      {tab === "receipts" ? <ReceiptArchive customerId={id} /> : tab === "new" ? (
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
function Office({ data, cur, usr, officePay }) {
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
        Object.entries(m).map(([cid, v]) => <div key={cid} className="text-sm"><Money v={v} dec={cur(cid).dec} /> {cur(cid).code}</div>)}
    </Card>
  );
  return (
    <div className="space-y-4">
      <div className="flex gap-3 flex-wrap">
        <S title="پارەی دراوی ئەمڕۆ" m={sums((t) => new Date(t.paidAt) >= d0)} />
        <S title="ئەم هەفتەیە" m={sums((t) => new Date(t.paidAt) >= w0)} />
        <S title="ئەم مانگە" m={sums((t) => new Date(t.paidAt) >= m0)} />
      </div>
      <SecLbl>مامەڵە چاوەڕوانەکان ({pending.length})</SecLbl>
      {pending.length === 0 ? <Card><Empty t="هیچ مامەڵەیەکی چاوەڕوان نییە ✓" /></Card> :
        pending.map((t) => (
          <Card key={t.id} className="p-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            {t.code && <span className="text-[11px] font-bold text-slate-400 bg-stone-100 px-2 py-0.5 rounded" style={num}>#{t.code}</span>}
            <span className="font-semibold text-slate-800">{t.cpId ? usr(t.cpId).name : t.cpName}</span>
            <span>بدرێتێ: <Money v={t.total} dec={cur(t.againstId).dec} /> {cur(t.againstId).code}</span>
            <span className="text-[11px] text-slate-400" style={num}>{new Date(t.date).toLocaleString("en-GB")}</span>
            <Btn className="mr-auto flex items-center gap-1.5" onClick={() => officePay(t)}><CheckCircle2 className="w-4 h-4" /> پارەم دا</Btn>
          </Card>
        ))}
    </div>
  );
}

/* ══════════════════ بەڕێوەبردنی ئەکاونت ══════════════════ */
function UsersAdmin({ data, createUser, deleteUser, setUserRate, flash }) {
  const [f, setF] = useState({ name: "", role: "customer", rate: "", phone: "", address: "", note: "", password: "" });
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
          <div><Lbl>ژمارەی مۆبایل * (لۆگین)</Lbl><Inp type="tel" dir="ltr" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="07701234567" /></div>
          <div><Lbl>وشەی نهێنی * (٦ پیت)</Lbl><Inp type="password" dir="ltr" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="••••••" /></div>
          <div><Lbl>ناونیشان</Lbl><Inp value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></div>
          <div><Lbl>تێبینی</Lbl><Inp value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
        </div>
        <div className="mt-4">
          <Btn className="flex items-center gap-1.5" onClick={() => {
            if (!f.name || !f.phone || !f.password) return flash("ناو، ژمارە، و وشەی نهێنی پێویستن");
            createUser(f); setF({ name: "", role: "customer", rate: "", phone: "", address: "", note: "", password: "" });
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
    const head = ["کۆد", "جۆر", "بەروار", "لایەن", "دراو", "بڕ", "نرخ", "بەرامبەر", "کۆ", "شوێن", "دۆخ", "خێر"];
    const rows = txs.map((t) => [t.code || "", t.type === "buy" ? "کڕین" : "فرۆشتن", new Date(t.date).toLocaleString("en-GB"),
      t.cpId ? usr(t.cpId).name : t.cpName, cur(t.curId).code, t.amount, t.rate, cur(t.againstId).code, t.total,
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

      {tab === "archive" && <ReceiptArchive customerId={user.id} />}

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
function PartnerPortal({ user, data, calc, cur, usr }) {
  const [tab, setTab] = useState("balance");
  const bal = calc.partner[user.id] || {};
  const hist = data.ledger.filter((e) => e.partnerId === user.id).slice().reverse();
  const fees = {};
  data.ledger.forEach((e) => { if (e.partnerId === user.id && e.type === "partner_fee") fees[e.curId] = (fees[e.curId] || 0) + Math.abs(e.amount); });
  return (
    <div className="space-y-4">
      <H sub={`بەخێربێیت، ${user.name}`}>ئەکاونتی من</H>
      <div className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1">
        {[["balance", "باڵانس"], ["receipts", "فیشەکان"], ["history", "مێژوو"]].map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-1 py-2.5 rounded-lg text-sm ${tab === k ? "bg-emerald-700 text-white font-semibold" : "text-slate-600 hover:bg-stone-100"}`}>{t}</button>
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

      {tab === "receipts" && <PartnerReceipts partnerId={user.id} usr={usr} data={data} />}

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
function Portal({ user, data, calc, cur, usr, officePay, settle, invUnpaid, flash, reloadBatches }) {
  if (user.role === "office") return <Office data={data} cur={cur} usr={usr} officePay={officePay} />;

  if (user.role === "customer") {
    const c = calc.cust[user.id] || { owe: {}, due: {} };
    const base = data.txs.filter((t) => !t.deleted && t.cpId === user.id).reverse();
    return <CustomerPortal user={user} c={c} base={base} data={data} cur={cur} usr={usr} flash={flash} reloadBatches={reloadBatches} />;
  }

  if (user.role === "partner") return <PartnerPortal user={user} data={data} calc={calc} cur={cur} usr={usr} />;

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
