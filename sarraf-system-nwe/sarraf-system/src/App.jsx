import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "./lib/supabase";
import { createClient } from "@supabase/supabase-js";
import {
  LayoutDashboard, Vault, ArrowLeftRight, ListOrdered, Users, Handshake,
  TrendingUp, Building2, UserCog, PieChart, History, Plus, Trash2, Pencil,
  CheckCircle2, AlertTriangle, Eye, LogOut, Wallet, ChevronLeft, Coins,
  Receipt, TrendingDown
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
const Card = ({ children, className = "", onClick }) => (
  <div onClick={onClick}
    className={`bg-white border border-stone-200/80 rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${onClick ? "cursor-pointer hover:border-emerald-500 hover:shadow-md transition" : ""} ${className}`}>
    {children}
  </div>
);
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

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  useEffect(() => { if (session) loadAll(); }, [session]);

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(null), 3000); };

  const loadAll = async () => {
    try {
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
    // قەرزی چاوەڕوانی نووسینگە
    const pending = {};
    for (const t of data.txs) {
      if (t.deleted || t.status !== "pending") continue;
      const key = t.cpId || "name:" + (t.cpName || "");
      pending[key] = pending[key] || { byCur: {} };
      pending[key].byCur[t.againstId] = (pending[key].byCur[t.againstId] || 0) + t.total;
    }
    return { phys, partner, atMe, invCap, invTotal, selfCap, invPaid, expenses, fees, pending };
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
  const sumUsd = (map) => data.currencies.reduce((s, c) => s + toUsd(map[c.id] || 0, c.id), 0);
  const ratesReady = data.currencies.every((c) => c.id === "usd" || c.buyRate || c.sellRate);

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
    const amount = f.dir === "in" ? Math.abs(+f.amount) : -Math.abs(+f.amount);
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
      if (feeRate > 0) es.push({ id: uid(), type: "partner_fee", curId: t.curId, amount: -(t.amount * feeRate / 100), partnerId: t.partnerId, txId: t.id, note: `عمولەی ${feeRate}٪`, date: t.date });
      // بەرامبەرەکەی لە قاسەی گشتی دەردەچێت (گەر خۆم پارەم دابێت)
      if (t.status === "completed") es.push({ id: uid(), type: "buy", curId: t.againstId, amount: -t.total, partnerId: null, txId: t.id, date: t.date });
    } else {
      es.push({ id: uid(), type: "sell", curId: t.curId, amount: -t.amount, partnerId: t.partnerId || null, txId: t.id, date: t.date });
      es.push({ id: uid(), type: "sell", curId: t.againstId, amount: +t.total, partnerId: null, txId: t.id, date: t.date });
    }
    return es;
  };

  const saveTx = (f, existing) => {
    const amount = +f.amount, rate = +f.rate, total = amount * rate;
    if (!amount || !rate) return flash("بڕ و نرخ پێویستە");
    if (!f.cpId && !f.cpName) return flash("لایەنی بەرامبەر دیاری بکە");
    run(async () => {
      let profit = null, profitCurId = null;
      if (f.type === "sell") { const av = avgRate(f.curId, f.againstId); if (av !== null) { profit = (rate - av) * amount; profitCurId = f.againstId; } }
      const code = existing ? existing.code : Math.max(1000, ...data.txs.map((x) => x.code || 0)) + 1;
      const t = { id: existing ? existing.id : uid(), code, type: f.type, cpId: f.cpId || null, cpName: f.cpId ? null : f.cpName, curId: f.curId, amount, rate, againstId: f.againstId, total, partnerId: f.partnerId || null, status: f.type === "buy" ? f.status : "completed", paidAt: existing ? existing.paidAt : null, profit, profitCurId, note: f.note || "", date: existing ? existing.date : now(), edited: !!existing };
      if (existing) {
        let r = await supabase.from("ledger").delete().eq("tx_id", t.id); if (r.error) throw r.error;
        r = await supabase.from("txs").update(TR(t)).eq("id", t.id); if (r.error) throw r.error;
      } else {
        const r = await supabase.from("txs").insert(TR(t)); if (r.error) throw r.error;
      }
      const r2 = await supabase.from("ledger").insert(buildEntries(t).map(LR)); if (r2.error) throw r2.error;
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
      await A("سڕینەوەی مامەڵە", `#${t.code || "—"} — ${fmt(t.amount)} ${cur(t.curId).code}`);
      flash("سڕایەوە");
    });
  };

  const officePay = (t) => run(async () => {
    const e = { id: uid(), type: "office_payment", curId: t.againstId, amount: -t.total, txId: t.id, note: "پارەدانی نووسینگە", date: now() };
    let r = await supabase.from("ledger").insert(LR(e)); if (r.error) throw r.error;
    r = await supabase.from("txs").update({ status: "completed", paid_at: now() }).eq("id", t.id); if (r.error) throw r.error;
    await A("نووسینگە پارەی دا", `#${t.code || "—"} — ${fmt(t.total)} ${cur(t.againstId).code}`);
    flash("پارەدان تۆمار کرا ✓");
  });

  const addExpense = (f) => {
    const amt = Math.abs(+f.amount);
    if (!amt) return flash("بڕی خەرجی پێویستە");
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
    const amt = Math.abs(+f.amount);
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
      if (f.dir === "to" && fr > 0) es.push({ ...base, id: uid(), type: "partner_fee", amount: -(amt * fr / 100), partnerId: f.partnerId, note: `عمولەی ${fr}٪` });
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
    ["people", "بەکارهێنەران", Users],
    ["report", "ڕاپۆرت", PieChart],
    ["audit", "تۆمار", History],
  ];

  const shared = { data, calc, cur, usr, mySafe, profitAll, profitIn, investorsProfitIn, invShare, invUnpaid, autoRate, avgRate, toUsd, sumUsd, ratesReady };

  return (
    <div dir="rtl" className="min-h-screen bg-[#F6F5F2] text-slate-800" style={{ fontFamily: "'Segoe UI', Tahoma, sans-serif" }}>
      {msg && <div className="fixed top-4 left-4 z-50 bg-slate-900 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg">{msg}</div>}
      {busy && <div className="fixed top-0 right-0 left-0 h-0.5 bg-emerald-600 animate-pulse z-50" />}

      <header className="bg-slate-900 text-white px-4 py-3 flex items-center justify-between flex-wrap gap-2 sticky top-0 z-40">
        <div className="flex items-center gap-2.5">
          <Vault className="w-6 h-6 text-amber-400" />
          <div>
            <div className="font-bold leading-tight">سیستەمی کڕین و فرۆشتنی دراو</div>
            <div className="text-[11px] text-slate-400">{profile.name} — {ROLE_KU[profile.role]}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && !va && (
            <div className="flex items-center gap-1.5">
              <Eye className="w-4 h-4 text-slate-400" />
              <select value="" onChange={(e) => e.target.value && setViewAs(e.target.value)} className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm">
                <option value="">بینین وەک...</option>
                {data.users.filter((u) => u.role !== "admin" && !u.deleted).map((u) => <option key={u.id} value={u.id}>{u.name} ({ROLE_KU[u.role]})</option>)}
              </select>
            </div>
          )}
          {isAdmin && va && (
            <button onClick={() => setViewAs(null)} className="flex items-center gap-1 text-sm bg-amber-600 hover:bg-amber-700 px-3 py-1.5 rounded-lg">
              <LogOut className="w-4 h-4" /> گەڕانەوە ({va.name})
            </button>
          )}
          <button onClick={signOut} className="flex items-center gap-1 text-sm bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-1.5 rounded-lg">
            <LogOut className="w-4 h-4" /> دەرچوون
          </button>
        </div>
      </header>

      {portalUser ? (
        <main className="p-4 max-w-3xl mx-auto"><Portal user={portalUser} {...shared} officePay={officePay} /></main>
      ) : (
        <div className="flex flex-col md:flex-row">
          <nav className="md:w-56 bg-white border-b md:border-b-0 md:border-l border-stone-200 md:min-h-screen p-2 flex md:flex-col gap-1 overflow-x-auto">
            {NAV.map(([id, t, Ic]) => (
              <button key={id} onClick={() => { setPage(id); setDetailId(null); setEditTx(null); }}
                className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl text-sm whitespace-nowrap transition ${page === id ? "bg-emerald-700 text-white font-semibold shadow-sm" : "hover:bg-stone-100 text-slate-600"}`}>
                <Ic className="w-[18px] h-[18px]" /> {t}
              </button>
            ))}
          </nav>
          <main className="flex-1 p-4 md:p-6 max-w-5xl">
            {page === "dash" && <Dashboard {...shared} go={setPage} />}
            {page === "safes" && <><Back onClick={() => setPage("dash")} t="گەڕانەوە بۆ داشبۆرد" /><Safes {...shared} addDeposit={addDeposit} addExpense={addExpense} addCurrency={addCurrency} /></>}
            {page === "rates" && <><Back onClick={() => setPage("dash")} t="گەڕانەوە بۆ داشبۆرد" /><Rates {...shared} saveRates={saveRates} /></>}
            {page === "profit" && <><Back onClick={() => setPage("dash")} t="گەڕانەوە بۆ داشبۆرد" /><ProfitPage {...shared} /></>}
            {page === "newtx" && <TxForm {...shared} onSave={saveTx} />}
            {page === "txs" && (editTx
              ? <TxForm {...shared} onSave={saveTx} editing={editTx} onCancel={() => setEditTx(null)} />
              : <TxList {...shared} onEdit={setEditTx} onDel={delTx} />)}
            {page === "people" && <PeopleHub {...shared} detailId={detailId} setDetailId={setDetailId} onSave={saveTx} transfer={transfer} officePay={officePay} createUser={createUser} deleteUser={deleteUser} setUserRate={setUserRate} flash={flash} />}
            {page === "report" && <Report {...shared} />}
            {page === "audit" && <Audit data={data} />}
          </main>
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
function Dashboard({ data, calc, cur, mySafe, profitIn, investorsProfitIn, sumUsd, ratesReady, go }) {
  const today = dOnly(new Date().toISOString());
  const todayTxs = data.txs.filter((t) => !t.deleted && dOnly(t.date) === today);
  const pTod = profitIn(today, today);
  const invTod = investorsProfitIn(pTod);
  const pendingCount = data.txs.filter((t) => !t.deleted && t.status === "pending").length;
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
        <Stat t="چاوەڕوانی نووسینگە" v={pendingCount} tone={pendingCount ? "text-amber-600" : ""} />
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

      <SafeCards data={data} calc={calc} cur={cur} mySafe={mySafe} sumUsd={sumUsd} ratesReady={ratesReady} go={go} />
    </div>
  );
}

/* قاسەی گشتی + دابەشبوونی هەر دراوێک */
function SafeCards({ data, calc, cur, mySafe, sumUsd, ratesReady, go }) {
  const [open, setOpen] = useState(null);
  const partners = data.users.filter((u) => u.role === "partner" && !u.deleted);
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
            <div className="text-2xl font-bold" style={num}>{fmt(sumUsd(calc.phys), 2)} <span className="text-sm text-amber-400">$</span></div>
          </div>
          <div className="bg-emerald-700 text-white rounded-xl p-4">
            <div className="text-[11px] text-emerald-100">ماڵی خۆم بە دۆلار</div>
            <div className="text-2xl font-bold" style={num}>{fmt(sumUsd(mySafe), 2)} <span className="text-sm text-amber-300">$</span></div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {data.currencies.map((c) => {
          const isOpen = open === c.id;
          return (
            <button key={c.id} onClick={() => setOpen(isOpen ? null : c.id)}
              className={`text-right border rounded-xl p-3.5 transition ${isOpen ? "border-emerald-600 bg-emerald-50/40" : "border-stone-200 bg-stone-50/60 hover:border-emerald-400"}`}>
              <div className="text-xs text-slate-500">{c.name}</div>
              <div className="text-xl mt-0.5"><Money v={calc.phys[c.id] || 0} dec={c.dec} /> <span className="text-amber-600 text-sm">{c.symbol}</span></div>
              <div className="text-[11px] text-slate-400 mt-1">هی خۆم: <span style={num}>{fmt(mySafe[c.id] || 0, c.dec)}</span></div>
            </button>
          );
        })}
      </div>
      {open && (
        <div className="mt-4 border-t border-stone-200 pt-4">
          <div className="text-sm font-semibold text-slate-700 mb-2">دابەشبوونی {cur(open).name}</div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm py-1.5 border-b border-stone-100">
              <span className="text-slate-600">لای خۆم (قاسەی سەرەکی)</span>
              <Money v={calc.atMe[open] || 0} dec={cur(open).dec} />
            </div>
            {partners.map((p) => {
              const v = (calc.partner[p.id] || {})[open];
              if (!v) return null;
              return (
                <div key={p.id} className="flex justify-between text-sm py-1.5 border-b border-stone-100 last:border-0">
                  <span className="text-slate-600">لای {p.name}{v < 0 && <span className="text-rose-700 text-xs"> (قەرز)</span>}</span>
                  <Money v={v} dec={cur(open).dec} />
                </div>
              );
            })}
            <div className="flex justify-between text-sm pt-2 font-bold">
              <span>کۆی گشتی</span>
              <Money v={calc.phys[open] || 0} dec={cur(open).dec} />
            </div>
          </div>
        </div>
      )}
    </Card>
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
function Safes({ data, calc, cur, usr, mySafe, invUnpaid, addDeposit, addExpense, addCurrency }) {
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
          <SecLbl>قاسەی گشتی (هەمووی)</SecLbl>
          {data.currencies.map((c) => (
            <div key={c.id} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
              <span className="text-sm text-slate-600">{c.name}</span>
              <Money v={calc.phys[c.id] || 0} dec={c.dec} />
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
function TxForm({ data, cur, calc, usr, avgRate, autoRate, onSave, editing, onCancel, lockCp }) {
  const e = editing;
  const [f, setF] = useState({
    type: e ? e.type : "buy",
    curId: e ? e.curId : (data.currencies.find((c) => c.id !== "usd")?.id || data.currencies[0]?.id),
    amount: e ? e.amount : "",
    againstId: e ? e.againstId : "usd",
    rate: e ? e.rate : "",
    manualRate: !!e,
    cpMode: e ? (e.cpId ? "acc" : "free") : "acc",
    cpId: e ? e.cpId || "" : (lockCp || ""),
    cpName: e ? e.cpName || "" : "",
    partnerId: e ? e.partnerId || "" : "",
    status: e ? e.status : "completed",
    note: e ? e.note : "",
  });
  const customers = data.users.filter((u) => u.role === "customer" && !u.deleted);
  const partners = data.users.filter((u) => u.role === "partner" && !u.deleted);

  const auto = autoRate(f.type, f.curId, f.againstId);
  const rate = f.manualRate ? +f.rate : (auto || 0);
  const total = (+f.amount || 0) * rate;
  const av = f.type === "sell" ? avgRate(f.curId, f.againstId) : null;
  const estProfit = f.type === "sell" && av !== null ? (rate - av) * (+f.amount || 0) : null;
  const srcBal = f.partnerId ? ((calc.partner[f.partnerId] || {})[f.curId] || 0) : (calc.atMe[f.curId] || 0);
  const willBeNeg = f.type === "sell" && srcBal - (+f.amount || 0) < 0;
  const feeRate = f.partnerId ? (usr(f.partnerId).rate || 0) : 0;

  const submit = () => onSave({ ...f, rate }, e);

  return (
    <div className="space-y-4">
      <H>{e ? `ئیدیتی مامەڵە #${e.code}` : "مامەڵەی نوێ"}</H>
      <Card className="p-5 space-y-5">
        <div className="flex gap-2">
          {["buy", "sell"].map((t) => (
            <button key={t} onClick={() => setF({ ...f, type: t, manualRate: false })}
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
              {f.manualRate
                ? <div className="flex items-center gap-2">
                    <Inp type="number" step="any" dir="ltr" value={f.rate} onChange={(ev) => setF({ ...f, rate: ev.target.value })} className="w-32" />
                    <button onClick={() => setF({ ...f, manualRate: false })} className="text-xs text-emerald-700 font-semibold">ئۆتۆماتیکی</button>
                  </div>
                : <div className="flex items-center gap-2">
                    <span style={num} className="font-bold text-slate-800">{auto ? fmt(auto, 6) : "نرخ دانەنراوە"}</span>
                    <button onClick={() => setF({ ...f, manualRate: true, rate: auto || "" })} className="text-xs text-slate-500 underline">گۆڕین</button>
                  </div>}
            </div>
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
          {f.type === "buy" && (
            <div>
              <Lbl>دۆخی پارەدان</Lbl>
              <Sel value={f.status} onChange={(ev) => setF({ ...f, status: ev.target.value })}>
                <option value="completed">تەواوکراو (خۆم پارەم دا)</option>
                <option value="pending">چاوەڕوانی پارە (نووسینگە دەیدات)</option>
              </Sel>
            </div>
          )}
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

        {feeRate > 0 && f.type === "buy" && +f.amount > 0 && (
          <div className="text-sm bg-stone-50 border border-stone-200 rounded-xl p-3 text-slate-600">
            عمولەی {usr(f.partnerId).name} ({feeRate}٪): <b style={num}>{fmt((+f.amount) * feeRate / 100, cur(f.curId).dec)}</b> {cur(f.curId).code} — دەستبەجێ کەم دەکرێتەوە، باڵانسی دوایی: <b style={num}>{fmt((+f.amount) * (1 - feeRate / 100), cur(f.curId).dec)}</b>
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

/* ══════════════════ لیستی مامەڵەکان ══════════════════ */
function TxList({ data, cur, usr, onEdit, onDel }) {
  const [q, setQ] = useState(""); const [ft, setFt] = useState("all");
  const list = [...data.txs].filter((t) => !t.deleted).reverse().filter((t) => {
    if (ft === "buy" && t.type !== "buy") return false;
    if (ft === "sell" && t.type !== "sell") return false;
    if (ft === "pending" && t.status !== "pending") return false;
    const name = t.cpId ? usr(t.cpId).name : t.cpName;
    return !q || (name || "").includes(q) || cur(t.curId).code.includes(q.toUpperCase()) || String(t.code || "").includes(q.replace("#", ""));
  });
  return (
    <div className="space-y-3">
      <H>هەموو مامەڵەکان</H>
      <div className="flex gap-2 flex-wrap">
        <Inp value={q} onChange={(e) => setQ(e.target.value)} placeholder="گەڕان بە کۆد، ناو یان دراو..." className="max-w-xs" />
        <Sel value={ft} onChange={(e) => setFt(e.target.value)} className="max-w-[190px]">
          <option value="all">هەمووی</option><option value="buy">کڕین</option><option value="sell">فرۆشتن</option><option value="pending">چاوەڕوانی پارە</option>
        </Sel>
      </div>
      {list.length === 0 ? <Card><Empty t="هیچ مامەڵەیەک نییە" /></Card> :
        list.map((t) => <TxRow key={t.id} t={t} cur={cur} usr={usr} onEdit={onEdit} onDel={onDel} />)}
    </div>
  );
}

/* flip = بینینی مامەڵەکە لە ڕوانگەی لایەنی بەرامبەرەوە / lite = بێ وردەکاری ناوخۆیی */
function TxRow({ t, cur, usr, onEdit, onDel, flip, lite }) {
  const name = t.cpId ? usr(t.cpId).name : t.cpName;
  const shown = flip ? (t.type === "buy" ? "sell" : "buy") : t.type;
  return (
    <Card className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      {t.code && <span className="text-[11px] font-bold text-slate-400 bg-stone-100 px-2 py-0.5 rounded" style={num}>#{t.code}</span>}
      <Pill tone={shown === "buy" ? "green" : "red"}>{shown === "buy" ? "کڕین" : "فرۆشتن"}</Pill>
      <span><Money v={t.amount} dec={cur(t.curId).dec} /> {cur(t.curId).code}</span>
      <span className="text-slate-400">نرخ <span style={num}>{fmt(t.rate, 6)}</span></span>
      <span>= <Money v={t.total} dec={cur(t.againstId).dec} /> {cur(t.againstId).code}</span>
      {!lite && <span className="text-slate-600">{name}</span>}
      {!lite && t.partnerId && <span className="text-amber-700 text-xs">لای {usr(t.partnerId).name}</span>}
      {t.status === "pending" && <Pill tone="amber">چاوەڕوانی پارە</Pill>}
      {!lite && t.profit != null && <span className="text-xs text-slate-500">خێر: <Money v={t.profit} dec={cur(t.profitCurId).dec} pos /></span>}
      {!lite && t.edited && <span className="text-[11px] text-slate-400">(ئیدیت کراوە)</span>}
      <span className="text-[11px] text-slate-400 mr-auto" style={num}>{new Date(t.date).toLocaleString("en-GB")}</span>
      {onEdit && <button onClick={() => onEdit(t)} className="text-slate-400 hover:text-emerald-700"><Pencil className="w-4 h-4" /></button>}
      {onDel && <button onClick={() => onDel(t)} className="text-slate-400 hover:text-rose-700"><Trash2 className="w-4 h-4" /></button>}
    </Card>
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
function Customers({ data, calc, cur, usr, detailId, setDetailId, onSave, ...rest }) {
  const customers = data.users.filter((u) => u.role === "customer" && !u.deleted);
  if (detailId) {
    const u = usr(detailId);
    const txs = data.txs.filter((t) => !t.deleted && t.cpId === detailId).reverse();
    const pend = calc.pending[detailId];
    return (
      <div className="space-y-4">
        <Back onClick={() => setDetailId(null)} t="گەڕانەوە بۆ لیستی کڕیاران" />
        <div>
          <h2 className="text-xl font-bold text-slate-900">{u.name}</h2>
          {(u.phone || u.address) && <div className="text-xs text-slate-500 mt-0.5">{u.phone && <span style={num}>{u.phone}</span>}{u.phone && u.address && " · "}{u.address}</div>}
        </div>
        {pend && (
          <Card className="p-4 border-amber-300 bg-amber-50/60">
            <div className="text-sm font-semibold text-amber-900 mb-1">قەرز لەسەر تۆ (چاوەڕوانی نووسینگە)</div>
            {Object.entries(pend.byCur).map(([cid, v]) => <div key={cid}><Money v={v} dec={cur(cid).dec} /> <span className="text-sm text-slate-600">{cur(cid).code}</span></div>)}
          </Card>
        )}
        <Card className="p-5">
          <SecLbl>مامەڵەی ڕاستەوخۆ لەگەڵ {u.name}</SecLbl>
          <TxForm data={data} calc={calc} cur={cur} usr={usr} {...rest} onSave={(f, e) => onSave({ ...f, cpMode: "acc", cpId: detailId, cpName: "" }, e)} lockCp={detailId} />
        </Card>
        <SecLbl>مێژووی مامەڵەکان ({txs.length})</SecLbl>
        {txs.length === 0 ? <Card><Empty t="هیچ مامەڵەیەک نییە" /></Card> : txs.map((t) => <TxRow key={t.id} t={t} cur={cur} usr={usr} />)}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {customers.length === 0 ? <Card><Empty t="هیچ کڕیارێک نییە — لە بەشی بەڕێوەبردن زیادی بکە" /></Card> :
        customers.map((u) => {
          const cnt = data.txs.filter((t) => !t.deleted && t.cpId === u.id).length;
          const pend = calc.pending[u.id];
          return (
            <Card key={u.id} className="p-4 flex items-center justify-between" onClick={() => setDetailId(u.id)}>
              <div>
                <div className="font-semibold text-slate-800">{u.name}</div>
                <div className="text-xs text-slate-500 mt-0.5">{cnt} مامەڵە {pend && <span className="text-amber-700 font-bold">· قەرزی چاوەڕوان</span>}</div>
              </div>
              <ChevronLeft className="w-5 h-5 text-slate-300" />
            </Card>
          );
        })}
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
            عمولەی {fr}٪ = <b style={num}>{fmt((+tf.amount) * fr / 100, cur(tf.curId).dec)}</b> — باڵانسی دوایی: <b style={num}>{fmt((+tf.amount) * (1 - fr / 100), cur(tf.curId).dec)}</b>
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

function InvestorDetail({ u, data, calc, cur, invUnpaid }) {
  const cap = calc.invCap[u.id] || {};
  const hist = data.ledger.filter((e) => e.investorId === u.id).slice().reverse();
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-slate-900">{u.name}</h2>
      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="flex justify-between items-center mb-3">
            <SecLbl>سەرمایە</SecLbl><Pill>ڕێژەی خێر {u.rate}٪</Pill>
          </div>
          {Object.keys(cap).length === 0 ? <Empty t="سەرمایە دانەنراوە" /> :
            Object.entries(cap).map(([cid, v]) => (
              <div key={cid} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
                <span className="text-sm text-slate-600">{cur(cid).name}</span><Money v={v} dec={cur(cid).dec} />
              </div>
            ))}
        </Card>
        <Card className="p-5">
          <SecLbl>خێری نەدراو</SecLbl>
          {data.currencies.map((c) => {
            const up = invUnpaid(u.id, c.id);
            if (!up) return null;
            return (
              <div key={c.id} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
                <span className="text-sm text-slate-600">{c.name}</span><Money v={up} dec={c.dec} pos />
              </div>
            );
          })}
          <div className="text-[11px] text-slate-400 mt-2">لە بەشی «قاسە و خەرجی» دەتوانیت پارەکەی بدەیت</div>
        </Card>
      </div>
      <Card className="p-5 bg-stone-50/60">
        <SecLbl>کۆی ماڵی ئەم (سەرمایە + خێری نەدراو)</SecLbl>
        {data.currencies.map((c) => {
          const tot = (cap[c.id] || 0) + invUnpaid(u.id, c.id);
          if (!tot) return null;
          return <div key={c.id} className="flex justify-between py-1.5 text-sm"><span>{c.name}</span><Money v={tot} dec={c.dec} /></div>;
        })}
      </Card>
      <SecLbl>مێژووی پارە ({hist.length})</SecLbl>
      {hist.length === 0 ? <Card><Empty t="هیچ نییە" /></Card> :
        hist.map((e) => (
          <Card key={e.id} className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <Pill tone={e.type === "investor_payout" ? "amber" : e.amount >= 0 ? "green" : "red"}>
              {e.type === "investor_payout" ? "پارەدانی خێر" : e.amount >= 0 ? "پارە دانان" : "پارە دەرهێنان"}
            </Pill>
            <span><Money v={Math.abs(e.amount)} dec={cur(e.curId).dec} /> {cur(e.curId).code}</span>
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
function Report({ data, calc, cur, usr, profitIn, investorsProfitIn, invShare }) {
  const today = new Date();
  const [from, setFrom] = useState(new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10));
  const [to, setTo] = useState(today.toISOString().slice(0, 10));
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
  const exp = {}, fee = {}, payout = {};
  entries.forEach((e) => {
    if (e.type === "expense") exp[e.curId] = (exp[e.curId] || 0) + Math.abs(e.amount);
    if (e.type === "partner_fee") fee[e.curId] = (fee[e.curId] || 0) + Math.abs(e.amount);
    if (e.type === "investor_payout") payout[e.curId] = (payout[e.curId] || 0) + Math.abs(e.amount);
  });
  const flow = {};
  entries.forEach((e) => {
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
  const allCurs = data.currencies.filter((c) => profit[c.id] || loss[c.id] || exp[c.id] || fee[c.id] || payout[c.id] || flow[c.id] || vol[c.id]);

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

  const Th = ({ children, w }) => <th className={`text-right py-2 font-semibold ${w || ""}`}>{children}</th>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <H>ڕاپۆرتی تەواو</H>
        <Btn kind="ghost" onClick={exportCsv}>دەرهێنان بۆ ئێکسڵ</Btn>
      </div>
      <Card className="p-4 flex gap-3 flex-wrap items-end">
        <div><Lbl>لە بەرواری</Lbl><Inp type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><Lbl>بۆ بەرواری</Lbl><Inp type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="text-xs text-slate-400 pb-3" style={num}>{txs.length} مامەڵە</div>
      </Card>

      <Card className="p-5 overflow-x-auto">
        <SecLbl>خێر و زەرەر</SecLbl>
        <table className="w-full text-sm">
          <thead><tr className="text-slate-500 text-xs border-b border-stone-200">
            <Th>دراو</Th><Th>خێر</Th><Th>زەرەر</Th><Th>خەرجی</Th><Th>عمولەی هاوبەشان</Th><Th>خێری وەبەرهێنەران</Th><Th>نەتی خۆم</Th>
          </tr></thead>
          <tbody>
            {allCurs.length === 0 ? <tr><td colSpan={7}><Empty t="هیچ نییە لەم ماوەیەدا" /></td></tr> :
              allCurs.map((c) => {
                const net = (profit[c.id] || 0) - (loss[c.id] || 0) - (exp[c.id] || 0) - (fee[c.id] || 0) - (invP[c.id] || 0);
                return (
                  <tr key={c.id} className="border-b border-stone-100">
                    <td className="py-2.5 font-semibold">{c.name}</td>
                    <td><Money v={profit[c.id] || 0} dec={c.dec} pos /></td>
                    <td>{loss[c.id] ? <Money v={-loss[c.id]} dec={c.dec} /> : <span className="text-slate-300">0</span>}</td>
                    <td>{exp[c.id] ? <Money v={-exp[c.id]} dec={c.dec} /> : <span className="text-slate-300">0</span>}</td>
                    <td>{fee[c.id] ? <Money v={-fee[c.id]} dec={c.dec} /> : <span className="text-slate-300">0</span>}</td>
                    <td>{invP[c.id] ? <Money v={-invP[c.id]} dec={c.dec} /> : <span className="text-slate-300">0</span>}</td>
                    <td className="font-bold"><Money v={net} dec={c.dec} pos /></td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-5 overflow-x-auto">
          <SecLbl>هاتوو و تێچوو</SecLbl>
          <table className="w-full text-sm">
            <thead><tr className="text-slate-500 text-xs border-b border-stone-200"><Th>دراو</Th><Th>هاتوو</Th><Th>تێچوو</Th><Th>جیاوازی</Th></tr></thead>
            <tbody>
              {Object.keys(flow).length === 0 ? <tr><td colSpan={4}><Empty t="هیچ" /></td></tr> :
                Object.entries(flow).map(([cid, fl]) => (
                  <tr key={cid} className="border-b border-stone-100">
                    <td className="py-2">{cur(cid).name}</td>
                    <td><Money v={fl.inn} dec={cur(cid).dec} pos /></td>
                    <td><Money v={-fl.out} dec={cur(cid).dec} /></td>
                    <td className="font-bold"><Money v={fl.inn - fl.out} dec={cur(cid).dec} pos /></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Card>
        <Card className="p-5 overflow-x-auto">
          <SecLbl>قەبارەی مامەڵەکان</SecLbl>
          <table className="w-full text-sm">
            <thead><tr className="text-slate-500 text-xs border-b border-stone-200"><Th>دراو</Th><Th>کڕدراو</Th><Th>فرۆشراو</Th><Th>ژمارە</Th></tr></thead>
            <tbody>
              {Object.keys(vol).length === 0 ? <tr><td colSpan={4}><Empty t="هیچ" /></td></tr> :
                Object.entries(vol).map(([cid, v]) => (
                  <tr key={cid} className="border-b border-stone-100">
                    <td className="py-2">{cur(cid).name}</td>
                    <td><Money v={v.buy} dec={cur(cid).dec} pos /></td>
                    <td><Money v={v.sell} dec={cur(cid).dec} /></td>
                    <td style={num}>{v.n}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Card>
      </div>

      <Card className="p-5 overflow-x-auto">
        <SecLbl>دابەشکردنی خێر بەسەر وەبەرهێنەران</SecLbl>
        <table className="w-full text-sm">
          <thead><tr className="text-slate-500 text-xs border-b border-stone-200">
            <Th>وەبەرهێنەر</Th><Th>دراو</Th><Th>سەرمایە</Th><Th>بەشی سەرمایە</Th><Th>ڕێژە</Th><Th>خێری ئەم ماوەیە</Th>
          </tr></thead>
          <tbody>
            {(() => {
              const rows = [];
              data.users.filter((u) => u.role === "investor" && !u.deleted).forEach((u) => {
                Object.entries(pm).forEach(([cid, tot]) => {
                  const cap = (calc.invCap[u.id] || {})[cid] || 0;
                  if (!cap) return;
                  const totalCap = (calc.selfCap[cid] || 0) + (calc.invTotal[cid] || 0);
                  rows.push(
                    <tr key={u.id + cid} className="border-b border-stone-100">
                      <td className="py-2.5">{u.name}</td>
                      <td>{cur(cid).name}</td>
                      <td><Money v={cap} dec={cur(cid).dec} /></td>
                      <td style={num}>{totalCap ? ((cap / totalCap) * 100).toFixed(1) : 0}٪</td>
                      <td style={num}>{u.rate}٪</td>
                      <td><Money v={invShare(u.id, cid, tot)} dec={cur(cid).dec} pos /></td>
                    </tr>
                  );
                });
              });
              return rows.length ? rows : <tr><td colSpan={6}><Empty t="هیچ نییە" /></td></tr>;
            })()}
          </tbody>
        </table>
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

/* ══════════════════ پۆرتاڵی ڕۆڵەکانی تر ══════════════════ */
function Portal({ user, data, calc, cur, usr, officePay, invUnpaid }) {
  if (user.role === "office") return <Office data={data} cur={cur} usr={usr} officePay={officePay} />;

  if (user.role === "customer") {
    const txs = data.txs.filter((t) => !t.deleted && t.cpId === user.id).reverse();
    const pend = calc.pending[user.id];
    return (
      <div className="space-y-4">
        <H sub={`بەخێربێیت، ${user.name}`}>ئەکاونتی من</H>
        {pend && (
          <Card className="p-4 border-amber-300 bg-amber-50/60">
            <div className="text-sm font-semibold text-amber-900 mb-1">پارەی چاوەڕوانکراو بۆت</div>
            {Object.entries(pend.byCur).map(([cid, v]) => <div key={cid}><Money v={v} dec={cur(cid).dec} /> {cur(cid).code}</div>)}
          </Card>
        )}
        <SecLbl>مامەڵەکانم ({txs.length})</SecLbl>
        {txs.length === 0 ? <Card><Empty t="هیچ مامەڵەیەکت نییە" /></Card> :
          txs.map((t) => <TxRow key={t.id} t={t} cur={cur} usr={usr} flip lite />)}
      </div>
    );
  }

  if (user.role === "partner") {
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
    const cap = calc.invCap[user.id] || {};
    const hist = data.ledger.filter((e) => e.investorId === user.id).slice().reverse();
    return (
      <div className="space-y-4">
        <H sub={`بەخێربێیت، ${user.name}`}>ئەکاونتی من</H>
        <div className="grid md:grid-cols-2 gap-4">
          <Card className="p-5">
            <div className="flex justify-between items-center mb-3"><SecLbl>سەرمایەکەم</SecLbl><Pill>خێر {user.rate}٪</Pill></div>
            {Object.keys(cap).length === 0 ? <Empty t="هیچ نییە" /> :
              Object.entries(cap).map(([cid, v]) => (
                <div key={cid} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
                  <span className="text-sm text-slate-600">{cur(cid).name}</span><Money v={v} dec={cur(cid).dec} />
                </div>
              ))}
          </Card>
          <Card className="p-5">
            <SecLbl>خێری نەدراو</SecLbl>
            {data.currencies.map((c) => {
              const up = invUnpaid(user.id, c.id);
              if (!up) return null;
              return <div key={c.id} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
                <span className="text-sm text-slate-600">{c.name}</span><Money v={up} dec={c.dec} pos /></div>;
            })}
          </Card>
        </div>
        <SecLbl>مێژووی پارە</SecLbl>
        {hist.length === 0 ? <Card><Empty t="هیچ نییە" /></Card> :
          hist.map((e) => (
            <Card key={e.id} className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <Pill tone={e.type === "investor_payout" ? "amber" : e.amount >= 0 ? "green" : "red"}>
                {e.type === "investor_payout" ? "وەرگرتنی خێر" : e.amount >= 0 ? "پارە دانان" : "پارە دەرهێنان"}
              </Pill>
              <span><Money v={Math.abs(e.amount)} dec={cur(e.curId).dec} /> {cur(e.curId).code}</span>
              <span className="text-[11px] text-slate-400 mr-auto" style={num}>{new Date(e.date).toLocaleString("en-GB")}</span>
            </Card>
          ))}
      </div>
    );
  }
  return null;
}
