import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "./lib/supabase";
import {
  LayoutDashboard, Vault, ArrowLeftRight, ListOrdered, Users, Handshake,
  TrendingUp, Building2, UserCog, PieChart, History, Plus, Trash2, Pencil,
  CheckCircle2, AlertTriangle, Eye, LogOut, Wallet
} from "lucide-react";

/* ================= داتا و یارمەتیدەرەکان ================= */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const now = () => new Date().toISOString();

const ROLE_KU = { admin: "ئەدمین", customer: "کڕیار-فرۆشیار", partner: "هاوبەشی سین", investor: "وەبەرهێنەر", office: "نووسینگە" };


const fmt = (n, dec = 2) => {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dec });
};
const num = { fontVariantNumeric: "tabular-nums", direction: "ltr", unicodeBidi: "embed" };

/* ================= بەشە بچووکەکان ================= */
const Card = ({ children, className = "" }) => (
  <div className={`bg-white border border-stone-200 rounded-xl shadow-sm ${className}`}>{children}</div>
);
const H = ({ children }) => <h2 className="text-lg font-bold text-slate-800 mb-3">{children}</h2>;
const Lbl = ({ children }) => <label className="block text-sm text-slate-600 mb-1">{children}</label>;
const Inp = (p) => <input {...p} className={`w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600 ${p.className || ""}`} />;
const Sel = (p) => <select {...p} className={`w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600 ${p.className || ""}`}>{p.children}</select>;
const Btn = ({ kind = "primary", className = "", ...p }) => {
  const k = {
    primary: "bg-emerald-700 hover:bg-emerald-800 text-white",
    danger: "bg-rose-700 hover:bg-rose-800 text-white",
    ghost: "bg-stone-100 hover:bg-stone-200 text-slate-700 border border-stone-300",
    gold: "bg-amber-600 hover:bg-amber-700 text-white",
  }[kind];
  return <button {...p} className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${k} ${className}`} />;
};
const Money = ({ v, dec, pos }) => (
  <span style={num} className={`font-bold ${v < 0 ? "text-rose-700" : pos ? "text-emerald-700" : "text-slate-800"}`}>{fmt(v, dec)}</span>
);
const Empty = ({ t }) => <div className="text-center text-slate-400 py-8 text-sm">{t}</div>;

/* ================= ئەپی سەرەکی ================= */
/* ================= ئەپی سەرەکی (وەشانی بەرهەمهێنان — Supabase) ================= */
export default function App() {
  const [session, setSession] = useState(undefined); // undefined = هێشتا نازانین
  const [data, setData] = useState(null);
  const [profile, setProfile] = useState(null);
  const [page, setPage] = useState("dash");
  const [viewAs, setViewAs] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [editTx, setEditTx] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  /* ---------- لۆگین ---------- */
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => { if (session) loadAll(); }, [session]);

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(null), 2500); };

  /* ---------- بارکردنی هەموو داتا لە داتابەیسەوە ---------- */
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
        currencies: (c.data || []).map((r) => ({ id: r.id, code: r.code, name: r.name, symbol: r.symbol, dec: r.dec })),
        users: (u.data || []).map((r) => ({ id: r.id, authId: r.auth_id, name: r.name, role: r.role, rate: +r.rate || 0, phone: r.phone, address: r.address, note: r.note, deleted: r.deleted })),
        ledger: (l.data || []).map((r) => ({ id: r.id, type: r.type, owner: r.owner, investorId: r.investor_id, curId: r.cur_id, amount: +r.amount, partnerId: r.partner_id, txId: r.tx_id, note: r.note, date: r.date })),
        txs: (t.data || []).map((r) => ({ id: r.id, code: r.code, type: r.type, cpId: r.cp_id, cpName: r.cp_name, curId: r.cur_id, amount: +r.amount, rate: +r.rate, againstId: r.against_id, total: +r.total, partnerId: r.partner_id, status: r.status, paidAt: r.paid_at, profit: r.profit == null ? null : +r.profit, profitCurId: r.profit_cur_id, note: r.note, date: r.date, edited: r.edited, deleted: r.deleted })),
        audit: (a.data || []).map((r) => ({ id: r.id, date: r.date, action: r.action, detail: r.detail })),
      };
      setData(d);
      if (session) setProfile(d.users.find((x) => x.authId === session.user.id) || null);
    } catch (err) {
      console.error(err);
      flash("هەڵە لە بارکردنی داتا — پەیوەندی ئینتەرنێت بپشکنە");
    }
  };

  /* ---------- نووسەرەکانی داتابەیس ---------- */
  const A = (action, detail) => supabase.from("audit").insert({ id: uid(), date: now(), action, detail });
  const toLedgerRow = (e) => ({ id: e.id, type: e.type, owner: e.owner || null, investor_id: e.investorId || null, cur_id: e.curId, amount: e.amount, partner_id: e.partnerId || null, tx_id: e.txId || null, note: e.note || null, date: e.date });
  const toTxRow = (t) => ({ id: t.id, code: t.code || null, type: t.type, cp_id: t.cpId, cp_name: t.cpName, cur_id: t.curId, amount: t.amount, rate: t.rate, against_id: t.againstId, total: t.total, partner_id: t.partnerId, status: t.status, paid_at: t.paidAt, profit: t.profit, profit_cur_id: t.profitCurId, note: t.note || null, date: t.date, edited: !!t.edited, deleted: !!t.deleted });

  const run = async (fn) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); await loadAll(); }
    catch (err) { console.error(err); flash("هەڵەیەک ڕوویدا — دووبارە هەوڵ بدەوە"); }
    finally { setBusy(false); }
  };

  /* ---------- حیسابەکان: هەموو باڵانسێک لە دەفتەرەوە (بێ گۆڕان) ---------- */
  const calc = useMemo(() => {
    if (!data) return null;
    const phys = {}, partner = {}, invCap = {}, selfCap = {};
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
    }
    const invTotal = {};
    Object.values(invCap).forEach((m) => Object.entries(m).forEach(([c, v]) => (invTotal[c] = (invTotal[c] || 0) + v)));
    const mySafe = {};
    for (const c of data.currencies) mySafe[c.id] = (phys[c.id] || 0) - (invTotal[c.id] || 0);
    const pending = {};
    for (const t of data.txs) {
      if (t.deleted || t.status !== "pending") continue;
      const key = t.cpId || "name:" + (t.cpName || "");
      pending[key] = pending[key] || { name: t.cpId ? (data.users.find((u) => u.id === t.cpId) || {}).name : t.cpName, byCur: {} };
      pending[key].byCur[t.againstId] = (pending[key].byCur[t.againstId] || 0) + t.total;
    }
    return { phys, partner, invCap, invTotal, mySafe, selfCap, pending };
  }, [data]);

  const avgRate = (curId, againstId) => {
    let a = 0, v = 0;
    for (const t of data.txs) if (!t.deleted && t.type === "buy" && t.curId === curId && t.againstId === againstId) { a += t.amount; v += t.amount * t.rate; }
    return a > 0 ? v / a : null;
  };

  const cur = (id) => data.currencies.find((c) => c.id === id) || {};
  const usr = (id) => data.users.find((u) => u.id === id) || {};

  /* ---------- کردارەکان (هەمان لۆجیک — نووسین لە داتابەیس) ---------- */
  const addDeposit = (f) => run(async () => {
    const amount = f.dir === "in" ? Math.abs(+f.amount) : -Math.abs(+f.amount);
    const e = { id: uid(), type: f.dir === "in" ? "deposit" : "withdraw", owner: f.owner === "self" ? "self" : "investor", investorId: f.owner === "self" ? null : f.owner, curId: f.curId, amount, partnerId: null, txId: null, note: f.note, date: now() };
    const { error } = await supabase.from("ledger").insert(toLedgerRow(e));
    if (error) throw error;
    await A(f.dir === "in" ? "پارە داخڵکردن" : "پارە دەرهێنان", `${fmt(Math.abs(amount))} ${cur(f.curId).code} — ${f.owner === "self" ? "هی خۆم" : usr(f.owner).name}`);
    flash("تۆمار کرا ✓");
  });

  const buildEntries = (t) => {
    const es = [{ id: uid(), type: t.type, curId: t.curId, amount: t.type === "buy" ? +t.amount : -t.amount, partnerId: t.partnerId || null, txId: t.id, date: t.date }];
    if (t.type === "buy") { if (t.status === "completed") es.push({ id: uid(), type: "buy", curId: t.againstId, amount: -t.total, partnerId: null, txId: t.id, date: t.date }); }
    else es.push({ id: uid(), type: "sell", curId: t.againstId, amount: +t.total, partnerId: null, txId: t.id, date: t.date });
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
        const d1 = await supabase.from("ledger").delete().eq("tx_id", t.id); if (d1.error) throw d1.error;
        const u1 = await supabase.from("txs").update(toTxRow(t)).eq("id", t.id); if (u1.error) throw u1.error;
      } else {
        const i1 = await supabase.from("txs").insert(toTxRow(t)); if (i1.error) throw i1.error;
      }
      const i2 = await supabase.from("ledger").insert(buildEntries(t).map(toLedgerRow)); if (i2.error) throw i2.error;
      await A(existing ? "ئیدیتی مامەڵە" : (t.type === "buy" ? "کڕین" : "فرۆشتن"), `#${t.code} — ${fmt(amount)} ${cur(f.curId).code} بە نرخی ${rate} — ${t.cpId ? usr(t.cpId).name : t.cpName}`);
      setEditTx(null);
      flash(existing ? "ئیدیت کرا ✓" : "مامەڵە تۆمار کرا ✓");
    });
  };

  const delTx = (t) => {
    if (!window.confirm("دڵنیایت لە سڕینەوەی ئەم مامەڵەیە؟ باڵانسەکان ئۆتۆماتیکی ڕاست دەبنەوە.")) return;
    run(async () => {
      const d1 = await supabase.from("ledger").delete().eq("tx_id", t.id); if (d1.error) throw d1.error;
      const u1 = await supabase.from("txs").update({ deleted: true }).eq("id", t.id); if (u1.error) throw u1.error;
      await A("سڕینەوەی مامەڵە", `#${t.code || "—"} — ${t.type === "buy" ? "کڕین" : "فرۆشتن"} ${fmt(t.amount)} ${cur(t.curId).code}`);
      flash("سڕایەوە");
    });
  };

  const officePay = (t) => run(async () => {
    const e = { id: uid(), type: "office_payment", owner: null, investorId: null, curId: t.againstId, amount: -t.total, partnerId: null, txId: t.id, note: "پارەدانی نووسینگە", date: now() };
    const i1 = await supabase.from("ledger").insert(toLedgerRow(e)); if (i1.error) throw i1.error;
    const u1 = await supabase.from("txs").update({ status: "completed", paid_at: now() }).eq("id", t.id); if (u1.error) throw u1.error;
    await A("نووسینگە پارەی دا", `#${t.code || "—"} — ${fmt(t.total)} ${cur(t.againstId).code} بۆ ${t.cpId ? usr(t.cpId).name : t.cpName} — لە قاسەی گشتی دەرچوو`);
    flash("پارەدان تۆمار کرا ✓ — پارەکە لە قاسە دەرچوو");
  });

  const addExpense = (f) => {
    const amt = Math.abs(+f.amount);
    if (!amt) return flash("بڕی خەرجی پێویستە");
    run(async () => {
      const e = { id: uid(), type: "expense", owner: null, investorId: null, curId: f.curId, amount: -amt, partnerId: null, txId: null, note: `${f.category}${f.note ? " — " + f.note : ""}`, date: now() };
      const i1 = await supabase.from("ledger").insert(toLedgerRow(e)); if (i1.error) throw i1.error;
      await A("خەرجی", `${fmt(amt)} ${cur(f.curId).code} — ${f.category}`);
      flash("خەرجی تۆمار کرا ✓");
    });
  };

  const transfer = (f) => {
    const amt = Math.abs(+f.amount);
    if (!amt || !f.partnerId) return flash("بڕ و هاوبەش دیاری بکە");
    run(async () => {
      const base = { type: "transfer", owner: null, investorId: null, curId: f.curId, txId: null, note: "", date: now() };
      const es = f.dir === "to"
        ? [{ ...base, id: uid(), amount: -amt, partnerId: null }, { ...base, id: uid(), amount: +amt, partnerId: f.partnerId }]
        : [{ ...base, id: uid(), amount: +amt, partnerId: null }, { ...base, id: uid(), amount: -amt, partnerId: f.partnerId }];
      const i1 = await supabase.from("ledger").insert(es.map(toLedgerRow)); if (i1.error) throw i1.error;
      await A("گواستنەوە", `${fmt(amt)} ${cur(f.curId).code} ${f.dir === "to" ? "بۆ لای" : "لە لای"} ${usr(f.partnerId).name}`);
      flash("گواستنەوە تۆمار کرا ✓");
    });
  };

  const addCurrency = (nc) => run(async () => {
    const i1 = await supabase.from("currencies").insert({ id: nc.code.toLowerCase(), code: nc.code, name: nc.name, symbol: nc.symbol, dec: +nc.dec || 2 });
    if (i1.error) throw i1.error;
    await A("زیادکردنی دراو", nc.code);
    flash("دراو زیاد کرا ✓");
  });

  const createUser = (f) => run(async () => {
    if (!f.name) { flash("ناو پێویستە"); return; }
    if (!f.phone) { flash("ژمارەی مۆبایل پێویستە"); return; }
    if (!f.password || f.password.length < 6) { flash("وشەی نهێنی کەمترین ٦ پیت"); return; }
    // ژمارەی مۆبایل وەک ئیمەیل بەکار دەهێنین
    const fakeEmail = f.phone.replace(/\s/g, "") + "@sarraf.local";
    // ئەکاونتی لۆگین لە Supabase درووست بکە
    const { data: sd, error: se } = await supabase.auth.signUp({ email: fakeEmail, password: f.password });
    if (se && !se.message.includes("already registered")) throw se;
    const authId = sd?.user?.id || null;
    // زانیاری بازرگانی زیاد بکە
    const i1 = await supabase.from("app_users").insert({ id: uid(), auth_id: authId, name: f.name, role: f.role, rate: +f.rate || 0, phone: f.phone || null, address: f.address || null, note: f.note || null });
    if (i1.error) throw i1.error;
    await A("درووستکردنی ئەکاونت", `${f.name} (${ROLE_KU[f.role]}) — ${f.phone}`);
    flash("ئەکاونت درووست کرا ✓ — ژمارە: " + f.phone);
  });

  const deleteUser = (u) => {
    if (!window.confirm(`سڕینەوەی ئەکاونتی «${u.name}»؟ مێژووی مامەڵەکانی دەمێنێتەوە.`)) return;
    run(async () => {
      const u1 = await supabase.from("app_users").update({ deleted: true }).eq("id", u.id); if (u1.error) throw u1.error;
      await A("سڕینەوەی ئەکاونت", u.name);
      flash("سڕایەوە");
    });
  };

  const setUserRate = (u, rate) => run(async () => {
    const u1 = await supabase.from("app_users").update({ rate: +rate || 0 }).eq("id", u.id); if (u1.error) throw u1.error;
    await A("گۆڕینی ڕێژەی خێر", `${u.name} → ${rate}%`);
  });

  const signOut = () => supabase.auth.signOut();

  /* ---------- ڕەندەرکردن ---------- */
  if (session === undefined) return <Splash t="بارکردنی سیستەم..." />;
  if (!session) return <Login />;
  if (!data || !calc) return <Splash t="بارکردنی داتا..." />;
  if (!profile) return (
    <Splash t="ئەکاونتەکەت هێشتا بە سیستەمەکە نەبەستراوە — پەیوەندی بە ئەدمینەوە بکە." signOut={signOut} />
  );

  const isAdmin = profile.role === "admin";
  const va = viewAs ? usr(viewAs) : null;
  const portalUser = !isAdmin ? profile : va;

  const NAV = [
    ["dash", "داشبۆرد", LayoutDashboard],
    ["newtx", "مامەڵەی نوێ", ArrowLeftRight],
    ["txs", "مامەڵەکان", ListOrdered],
    ["people", "بەکارهێنەران", Users],
    ["report", "ڕاپۆرتی خێر", PieChart],
    ["audit", "تۆماری گۆڕانکاری", History],
  ];

  return (
    <div dir="rtl" className="min-h-screen bg-stone-100 text-slate-800" style={{ fontFamily: "'Segoe UI', Tahoma, sans-serif" }}>
      {msg && <div className="fixed top-4 left-4 z-50 bg-slate-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg">{msg}</div>}
      {busy && <div className="fixed top-0 right-0 left-0 h-1 bg-emerald-600 animate-pulse z-50" />}

      <header className="bg-slate-900 text-white px-4 py-3 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Vault className="w-6 h-6 text-amber-400" />
          <div>
            <div className="font-bold">سیستەمی کڕین و فرۆشتنی دراو</div>
            <div className="text-xs text-slate-400">{profile.name} — {ROLE_KU[profile.role]}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && !va && (
            <div className="flex items-center gap-2 text-sm">
              <Eye className="w-4 h-4 text-slate-400" />
              <select value="" onChange={(e) => { if (e.target.value) setViewAs(e.target.value); }} className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-sm">
                <option value="">بینین وەک...</option>
                {data.users.filter((u) => u.role !== "admin" && !u.deleted).map((u) => <option key={u.id} value={u.id}>{u.name} ({ROLE_KU[u.role]})</option>)}
              </select>
            </div>
          )}
          {isAdmin && va && (
            <button onClick={() => setViewAs(null)} className="flex items-center gap-1 text-sm bg-amber-600 hover:bg-amber-700 px-3 py-1.5 rounded-lg">
              <LogOut className="w-4 h-4" /> گەڕانەوە بۆ ئەدمین (ئێستا: {va.name})
            </button>
          )}
          <button onClick={signOut} className="flex items-center gap-1 text-sm bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-1.5 rounded-lg">
            <LogOut className="w-4 h-4" /> دەرچوون
          </button>
        </div>
      </header>

      {portalUser ? (
        <main className="p-4 max-w-4xl mx-auto"><Portal user={portalUser} data={data} calc={calc} cur={cur} usr={usr} officePay={officePay} /></main>
      ) : (
        <div className="flex flex-col md:flex-row">
          <nav className="md:w-52 bg-white border-b md:border-b-0 md:border-l border-stone-200 md:min-h-screen p-2 flex md:flex-col gap-1 overflow-x-auto">
            {NAV.map(([id, t, Ic]) => (
              <button key={id} onClick={() => { setPage(id); setDetailId(null); setEditTx(null); }}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm whitespace-nowrap ${page === id ? "bg-emerald-700 text-white font-semibold" : "hover:bg-stone-100 text-slate-600"}`}>
                <Ic className="w-4 h-4" /> {t}
              </button>
            ))}
          </nav>
          <main className="flex-1 p-4 max-w-5xl">
            {page === "dash" && <Dashboard data={data} calc={calc} cur={cur} goSafes={() => setPage("safes")} />}
            {page === "safes" && (
              <div className="space-y-3">
                <button onClick={() => setPage("dash")} className="text-sm text-emerald-700 font-semibold">→ گەڕانەوە بۆ داشبۆرد</button>
                <Safes data={data} calc={calc} cur={cur} usr={usr} addDeposit={addDeposit} addExpense={addExpense} addCurrency={addCurrency} />
              </div>
            )}
            {page === "newtx" && <TxForm data={data} cur={cur} avgRate={avgRate} onSave={saveTx} calc={calc} />}
            {page === "txs" && (editTx
              ? <TxForm data={data} cur={cur} avgRate={avgRate} onSave={saveTx} calc={calc} editing={editTx} onCancel={() => setEditTx(null)} />
              : <TxList data={data} cur={cur} usr={usr} onEdit={setEditTx} onDel={delTx} />)}
            {page === "people" && <PeopleHub data={data} calc={calc} cur={cur} usr={usr} detailId={detailId} setDetailId={setDetailId} onSave={saveTx} avgRate={avgRate} transfer={transfer} officePay={officePay} createUser={createUser} deleteUser={deleteUser} setUserRate={setUserRate} flash={flash} />}
            {page === "report" && <Report data={data} calc={calc} cur={cur} />}
            {page === "audit" && <Audit data={data} />}
          </main>
        </div>
      )}
    </div>
  );
}

/* ================= پەڕەی لۆگین ================= */
function Splash({ t, signOut }) {
  return (
    <div dir="rtl" className="min-h-screen flex flex-col items-center justify-center bg-stone-100 text-slate-500 gap-4">
      <Vault className="w-10 h-10 text-amber-500" />
      <div>{t}</div>
      {signOut && <Btn kind="ghost" onClick={signOut}>دەرچوون</Btn>}
    </div>
  );
}

function Login() {
  const [phone, setPhone] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  // ژمارەی مۆبایل وەک ئیمەیل بەکار دەهێنین: 07701234567 → 07701234567@sarraf.local
  const toEmail = (p) => p.replace(/\s/g, "") + "@sarraf.local";

  const go = async () => {
    if (!phone || !pw) { setErr("ژمارە و وشەی نهێنی پێویستە"); return; }
    setLoading(true); setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email: toEmail(phone), password: pw });
    if (error) setErr("ژمارە یان وشەی نهێنی هەڵەیە");
    setLoading(false);
  };

  return (
    <div dir="rtl" className="min-h-screen flex items-center justify-center bg-slate-900 p-4" style={{ fontFamily: "'Segoe UI', Tahoma, sans-serif" }}>
      <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm space-y-4">
        <div className="text-center">
          <Vault className="w-10 h-10 text-amber-500 mx-auto mb-2" />
          <div className="font-bold text-lg text-slate-800">سیستەمی کڕین و فرۆشتنی دراو</div>
          <div className="text-xs text-slate-400">چوونە ژوورەوە</div>
        </div>
        <div><Lbl>ژمارەی مۆبایل</Lbl><Inp type="tel" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07701234567" /></div>
        <div><Lbl>وشەی نهێنی</Lbl><Inp type="password" dir="ltr" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} /></div>
        {err && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2">{err}</div>}
        <Btn className="w-full" onClick={go} disabled={loading}>{loading ? "..." : "چوونە ژوورەوە"}</Btn>
      </div>
    </div>
  );
}

/* ================= ناوەندی بەکارهێنەران (هەر ٤ گرووپەکە + بەڕێوەبردن) ================= */
function PeopleHub({ data, calc, cur, usr, detailId, setDetailId, onSave, avgRate, transfer, officePay, createUser, deleteUser, setUserRate, flash }) {
  const [tab, setTab] = useState("customers");
  const TABS = [
    ["customers", "کڕیاران", Users],
    ["partners", "هاوبەشان", Handshake],
    ["investors", "وەبەرهێنەران", TrendingUp],
    ["office", "نووسینگە", Building2],
    ["manage", "بەڕێوەبردنی ئەکاونت", UserCog],
  ];
  return (
    <div className="space-y-4">
      <div className="flex gap-1 flex-wrap bg-white border border-stone-200 rounded-xl p-1">
        {TABS.map(([id, t, Ic]) => (
          <button key={id} onClick={() => { setTab(id); setDetailId(null); }}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm whitespace-nowrap ${tab === id ? "bg-emerald-700 text-white font-semibold" : "text-slate-600 hover:bg-stone-100"}`}>
            <Ic className="w-4 h-4" /> {t}
          </button>
        ))}
      </div>
      {tab === "customers" && <People role="customer" data={data} calc={calc} cur={cur} usr={usr} detailId={detailId} setDetailId={setDetailId} onSave={onSave} avgRate={avgRate} />}
      {tab === "partners" && <Partners data={data} calc={calc} cur={cur} transfer={transfer} />}
      {tab === "investors" && <Investors data={data} calc={calc} cur={cur} />}
      {tab === "office" && <Office data={data} cur={cur} usr={usr} officePay={officePay} />}
      {tab === "manage" && <UsersAdmin data={data} createUser={createUser} deleteUser={deleteUser} setUserRate={setUserRate} flash={flash} />}
    </div>
  );
}

/* ================= داشبۆرد ================= */
function Dashboard({ data, calc, cur, goSafes }) {
  const today = new Date().toDateString();
  const todayTxs = data.txs.filter((t) => !t.deleted && new Date(t.date).toDateString() === today);
  const profitToday = {};
  todayTxs.forEach((t) => { if (t.profit != null) profitToday[t.profitCurId] = (profitToday[t.profitCurId] || 0) + t.profit; });
  const pendingCount = data.txs.filter((t) => !t.deleted && t.status === "pending").length;
  return (
    <div className="space-y-4">
      <H>داشبۆرد — کورتەی ئەمڕۆ</H>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-4"><div className="text-xs text-slate-500">مامەڵەی ئەمڕۆ</div><div className="text-2xl font-bold" style={num}>{todayTxs.length}</div></Card>
        <Card className="p-4"><div className="text-xs text-slate-500">کڕین</div><div className="text-2xl font-bold text-emerald-700" style={num}>{todayTxs.filter((t) => t.type === "buy").length}</div></Card>
        <Card className="p-4"><div className="text-xs text-slate-500">فرۆشتن</div><div className="text-2xl font-bold text-rose-700" style={num}>{todayTxs.filter((t) => t.type === "sell").length}</div></Card>
        <Card className="p-4"><div className="text-xs text-slate-500">چاوەڕوانی نووسینگە</div><div className={`text-2xl font-bold ${pendingCount ? "text-amber-600" : ""}`} style={num}>{pendingCount}</div></Card>
      </div>
      <Card className="p-4 cursor-pointer hover:border-emerald-600 transition" >
        <button onClick={goSafes} className="w-full text-right">
          <div className="flex justify-between items-center mb-2">
            <div className="text-sm font-semibold text-slate-600 flex items-center gap-1"><Vault className="w-4 h-4 text-amber-600" /> قاسەی گشتی (هەموو پارەکان — لای خۆت + لای هاوبەشان)</div>
            <span className="text-xs text-emerald-700 font-semibold">کردنەوەی قاسەکان ←</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {data.currencies.map((c) => (
              <div key={c.id} className="border border-stone-200 rounded-lg p-3 bg-stone-50">
                <div className="text-xs text-slate-500">{c.name}</div>
                <div className="text-xl"><Money v={calc.phys[c.id] || 0} dec={c.dec} /> <span className="text-amber-600 text-sm">{c.symbol}</span></div>
              </div>
            ))}
          </div>
        </button>
      </Card>
      <Card className="p-4">
        <div className="text-sm font-semibold mb-2 text-slate-600">خێری ئەمڕۆ (بۆ هەر دراوێک جیا)</div>
        {Object.keys(profitToday).length === 0 ? <Empty t="هێشتا هیچ فرۆشتنێک نەکراوە ئەمڕۆ" /> :
          <div className="flex gap-4 flex-wrap">{Object.entries(profitToday).map(([cid, v]) => (
            <div key={cid} className="text-lg"><Money v={v} dec={cur(cid).dec} pos /> <span className="text-slate-500 text-sm">{cur(cid).code}</span></div>
          ))}</div>}
      </Card>
    </div>
  );
}

/* ================= قاسەکان ================= */
function Safes({ data, calc, cur, usr, addDeposit, addExpense, addCurrency }) {
  const [f, setF] = useState({ dir: "in", owner: "self", curId: data.currencies[0].id, amount: "", note: "" });
  const [xf, setXf] = useState({ category: "کرێی شوێن", curId: data.currencies[0].id, amount: "", note: "" });
  const [nc, setNc] = useState({ code: "", name: "", symbol: "", dec: 2 });
  const investors = data.users.filter((u) => u.role === "investor" && !u.deleted);
  const XCATS = ["کرێی شوێن", "مووچە", "کرێی هاوبەش", "گواستنەوە و حەواڵە", "کارەبا و ئینتەرنێت", "خەرجی تر"];
  return (
    <div className="space-y-4">
      <H>قاسەکان</H>
      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-4">
          <div className="text-sm font-semibold mb-2 text-slate-600 flex items-center gap-1"><Vault className="w-4 h-4 text-amber-600" /> قاسەی گشتی</div>
          {data.currencies.map((c) => (
            <div key={c.id} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
              <span className="text-sm">{c.name} <span className="text-slate-400 text-xs">({c.code})</span></span>
              <Money v={calc.phys[c.id] || 0} dec={c.dec} />
            </div>
          ))}
        </Card>
        <Card className="p-4">
          <div className="text-sm font-semibold mb-2 text-slate-600 flex items-center gap-1"><Wallet className="w-4 h-4 text-emerald-700" /> قاسەی تایبەتی خۆم (بێ سەرمایەی وەبەرهێنەران)</div>
          {data.currencies.map((c) => (
            <div key={c.id} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
              <span className="text-sm">{c.name}</span>
              <Money v={calc.mySafe[c.id] || 0} dec={c.dec} />
            </div>
          ))}
        </Card>
      </div>
      <Card className="p-4">
        <div className="text-sm font-semibold mb-3 text-slate-600">پارە داخڵکردن / دەرهێنان</div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div><Lbl>جۆر</Lbl><Sel value={f.dir} onChange={(e) => setF({ ...f, dir: e.target.value })}><option value="in">داخڵکردن</option><option value="out">دەرهێنان</option></Sel></div>
          <div><Lbl>خاوەنی پارە</Lbl><Sel value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}><option value="self">هی خۆم</option>{investors.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Sel></div>
          <div><Lbl>دراو</Lbl><Sel value={f.curId} onChange={(e) => setF({ ...f, curId: e.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
          <div><Lbl>بڕ</Lbl><Inp type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="0" /></div>
          <div className="flex items-end"><Btn onClick={() => { if (+f.amount > 0) { addDeposit(f); setF({ ...f, amount: "", note: "" }); } }} className="w-full">تۆمارکردن</Btn></div>
        </div>
      </Card>
      <Card className="p-4">
        <div className="text-sm font-semibold mb-3 text-slate-600">تۆمارکردنی خەرجی (لە قاسەی گشتی دەردەچێت)</div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div><Lbl>جۆری خەرجی</Lbl><Sel value={xf.category} onChange={(e) => setXf({ ...xf, category: e.target.value })}>{XCATS.map((c) => <option key={c} value={c}>{c}</option>)}</Sel></div>
          <div><Lbl>دراو</Lbl><Sel value={xf.curId} onChange={(e) => setXf({ ...xf, curId: e.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
          <div><Lbl>بڕ</Lbl><Inp type="number" value={xf.amount} onChange={(e) => setXf({ ...xf, amount: e.target.value })} placeholder="0" /></div>
          <div><Lbl>تێبینی</Lbl><Inp value={xf.note} onChange={(e) => setXf({ ...xf, note: e.target.value })} /></div>
          <div className="flex items-end"><Btn kind="danger" className="w-full" onClick={() => { if (+xf.amount > 0) { addExpense(xf); setXf({ ...xf, amount: "", note: "" }); } }}>تۆمارکردنی خەرجی</Btn></div>
        </div>
      </Card>
      <Card className="p-4">
        <div className="text-sm font-semibold mb-3 text-slate-600">زیادکردنی دراوی نوێ</div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div><Lbl>کۆد (نموونە EUR)</Lbl><Inp value={nc.code} onChange={(e) => setNc({ ...nc, code: e.target.value.toUpperCase() })} /></div>
          <div><Lbl>ناو</Lbl><Inp value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} /></div>
          <div><Lbl>هێما</Lbl><Inp value={nc.symbol} onChange={(e) => setNc({ ...nc, symbol: e.target.value })} /></div>
          <div><Lbl>خانەی دوای پۆینت</Lbl><Inp type="number" value={nc.dec} onChange={(e) => setNc({ ...nc, dec: +e.target.value })} /></div>
          <div className="flex items-end"><Btn kind="gold" className="w-full" onClick={() => {
            if (!nc.code || !nc.name) return;
            addCurrency(nc);
            setNc({ code: "", name: "", symbol: "", dec: 2 });
          }}>زیادکردن</Btn></div>
        </div>
      </Card>
    </div>
  );
}

/* ================= فۆرمی مامەڵە (کڕین/فرۆشتن + ئیدیت) ================= */
function TxForm({ data, cur, avgRate, onSave, calc, editing, onCancel }) {
  const e = editing;
  const [f, setF] = useState({
    type: e ? e.type : "buy",
    curId: e ? e.curId : "cny",
    amount: e ? e.amount : "",
    rate: e ? e.rate : "",
    againstId: e ? e.againstId : "usd",
    cpMode: e ? (e.cpId ? "acc" : "free") : "acc",
    cpId: e ? e.cpId || "" : "",
    cpName: e ? e.cpName || "" : "",
    partnerId: e ? e.partnerId || "" : "",
    status: e ? e.status : "completed",
    note: e ? e.note : "",
  });
  const customers = data.users.filter((u) => u.role === "customer" && !u.deleted);
  const partners = data.users.filter((u) => u.role === "partner" && !u.deleted);
  const total = (+f.amount || 0) * (+f.rate || 0);
  const av = f.type === "sell" ? avgRate(f.curId, f.againstId) : null;
  const estProfit = f.type === "sell" && av !== null ? ((+f.rate || 0) - av) * (+f.amount || 0) : null;
  const srcBal = f.type === "sell" ? (f.partnerId ? (calc.partner[f.partnerId]?.[f.curId] || 0) : ((calc.phys[f.curId] || 0) - Object.values(calc.partner).reduce((s, m) => s + (m[f.curId] || 0), 0))) : null;
  const willBeNegative = f.type === "sell" && f.partnerId && srcBal - (+f.amount || 0) < 0;

  return (
    <div className="space-y-4">
      <H>{e ? "ئیدیتی مامەڵە" : "مامەڵەی نوێ"}</H>
      <Card className="p-4 space-y-4">
        <div className="flex gap-2">
          {["buy", "sell"].map((t) => (
            <button key={t} onClick={() => setF({ ...f, type: t })}
              className={`flex-1 py-2 rounded-lg font-bold text-sm ${f.type === t ? (t === "buy" ? "bg-emerald-700 text-white" : "bg-rose-700 text-white") : "bg-stone-100 text-slate-500"}`}>
              {t === "buy" ? "کڕین" : "فرۆشتن"}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div><Lbl>دراو</Lbl><Sel value={f.curId} onChange={(ev) => setF({ ...f, curId: ev.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
          <div><Lbl>بڕ</Lbl><Inp type="number" value={f.amount} onChange={(ev) => setF({ ...f, amount: ev.target.value })} placeholder="0" /></div>
          <div><Lbl>نرخی یەک یەکە</Lbl><Inp type="number" step="any" value={f.rate} onChange={(ev) => setF({ ...f, rate: ev.target.value })} placeholder="0.00" /></div>
          <div><Lbl>بەرامبەر دراوی</Lbl><Sel value={f.againstId} onChange={(ev) => setF({ ...f, againstId: ev.target.value })}>{data.currencies.filter((c) => c.id !== f.curId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
        </div>
        <div className="bg-stone-50 border border-stone-200 rounded-lg p-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div>کۆی گشتی: <Money v={total} dec={cur(f.againstId).dec} /> <span className="text-slate-500">{cur(f.againstId).code}</span></div>
          {f.type === "sell" && <div>مامناوەندی نرخی کڕین: <span style={num} className="font-semibold">{av === null ? "نەزانراو" : fmt(av, 6)}</span></div>}
          {estProfit !== null && <div>خێری خەمڵێنراو: <Money v={estProfit} dec={cur(f.againstId).dec} pos /> <span className="text-slate-500">{cur(f.againstId).code}</span></div>}
          {f.type === "sell" && <div>باڵانسی سەرچاوە: <Money v={srcBal} dec={cur(f.curId).dec} /></div>}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <Lbl>لایەنی بەرامبەر</Lbl>
            <Sel value={f.cpMode} onChange={(ev) => setF({ ...f, cpMode: ev.target.value, cpId: "", cpName: "" })}>
              <option value="acc">کڕیارێکی تۆمارکراو</option><option value="free">ئۆزەر (بێ ئەکاونت)</option>
            </Sel>
          </div>
          <div>
            <Lbl>{f.cpMode === "acc" ? "کڕیار هەڵبژێرە" : "ناوی کەسەکە بنووسە"}</Lbl>
            {f.cpMode === "acc"
              ? <Sel value={f.cpId} onChange={(ev) => setF({ ...f, cpId: ev.target.value })}><option value="">—</option>{customers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Sel>
              : <Inp value={f.cpName} onChange={(ev) => setF({ ...f, cpName: ev.target.value })} placeholder="ناو..." />}
          </div>
          <div>
            <Lbl>{f.type === "buy" ? "لە کوێ دای دەنێیت؟" : "لە کوێوە دەفرۆشیت؟"}</Lbl>
            <Sel value={f.partnerId} onChange={(ev) => setF({ ...f, partnerId: ev.target.value })}>
              <option value="">لای خۆم (قاسەی سەرەکی)</option>
              {partners.map((p) => <option key={p.id} value={p.id}>لای {p.name}</option>)}
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
        {willBeNegative && (
          <div className="flex items-center gap-2 text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
            <AlertTriangle className="w-4 h-4" /> ئاگاداری: دوای ئەم فرۆشتنە باڵانسی ئەم هاوبەشە دەبێتە سالب — واتا تۆ قەرزاری دەبیت و لە تێکردنی داهاتوودا ئۆتۆماتیکی دەبڕدرێتەوە.
          </div>
        )}
        <div><Lbl>تێبینی (ئارەزوومەندانە)</Lbl><Inp value={f.note} onChange={(ev) => setF({ ...f, note: ev.target.value })} /></div>
        <div className="flex gap-2">
          <Btn kind={f.type === "buy" ? "primary" : "danger"} onClick={() => onSave(f, e)}>{e ? "پاشەکەوتی ئیدیت" : f.type === "buy" ? "تۆمارکردنی کڕین" : "تۆمارکردنی فرۆشتن"}</Btn>
          {e && <Btn kind="ghost" onClick={onCancel}>پاشگەزبوونەوە</Btn>}
        </div>
      </Card>
    </div>
  );
}

/* ================= لیستی مامەڵەکان ================= */
function TxList({ data, cur, usr, onEdit, onDel }) {
  const [q, setQ] = useState(""); const [ft, setFt] = useState("all");
  const list = [...data.txs].filter((t) => !t.deleted).reverse().filter((t) => {
    if (ft !== "all" && t.type !== ft && !(ft === "pending" && t.status === "pending")) return false;
    const name = t.cpId ? usr(t.cpId).name : t.cpName;
    return !q || (name || "").includes(q) || cur(t.curId).code.includes(q.toUpperCase()) || String(t.code || "").includes(q.replace("#", ""));
  });
  return (
    <div className="space-y-3">
      <H>هەموو مامەڵەکان</H>
      <div className="flex gap-2 flex-wrap">
        <Inp value={q} onChange={(e) => setQ(e.target.value)} placeholder="گەڕان بە کۆد، ناو یان دراو..." className="max-w-xs" />
        <Sel value={ft} onChange={(e) => setFt(e.target.value)} className="max-w-[180px]">
          <option value="all">هەمووی</option><option value="buy">کڕین</option><option value="sell">فرۆشتن</option><option value="pending">چاوەڕوانی پارە</option>
        </Sel>
      </div>
      {list.length === 0 ? <Card><Empty t="هیچ مامەڵەیەک نییە — لە «مامەڵەی نوێ»ەوە دەست پێبکە" /></Card> :
        list.map((t) => <TxRow key={t.id} t={t} cur={cur} usr={usr} onEdit={onEdit} onDel={onDel} />)}
    </div>
  );
}

function TxRow({ t, cur, usr, onEdit, onDel }) {
  const name = t.cpId ? usr(t.cpId).name : t.cpName;
  return (
    <Card className="p-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      {t.code && <span className="text-xs font-bold text-slate-400 bg-stone-100 px-2 py-0.5 rounded" style={num}>#{t.code}</span>}
      <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${t.type === "buy" ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}>{t.type === "buy" ? "کڕین" : "فرۆشتن"}</span>
      <span><Money v={t.amount} dec={cur(t.curId).dec} /> {cur(t.curId).code}</span>
      <span className="text-slate-400">نرخ <span style={num}>{fmt(t.rate, 6)}</span></span>
      <span>= <Money v={t.total} dec={cur(t.againstId).dec} /> {cur(t.againstId).code}</span>
      <span className="text-slate-600">{name}</span>
      {t.partnerId && <span className="text-amber-700 text-xs">لای {usr(t.partnerId).name}</span>}
      {t.status === "pending" && <span className="px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-800 font-bold">چاوەڕوانی نووسینگە</span>}
      {t.profit != null && <span className="text-xs">خێر: <Money v={t.profit} dec={cur(t.profitCurId).dec} pos /> {cur(t.profitCurId).code}</span>}
      {t.edited && <span className="text-xs text-slate-400">(ئیدیت کراوە)</span>}
      <span className="text-xs text-slate-400 mr-auto" style={num}>{new Date(t.date).toLocaleString("en-GB")}</span>
      {onEdit && <button onClick={() => onEdit(t)} className="text-slate-500 hover:text-emerald-700"><Pencil className="w-4 h-4" /></button>}
      {onDel && <button onClick={() => onDel(t)} className="text-slate-500 hover:text-rose-700"><Trash2 className="w-4 h-4" /></button>}
    </Card>
  );
}

/* ================= کڕیاران ================= */
function People({ data, calc, cur, usr, detailId, setDetailId, onSave, avgRate }) {
  const customers = data.users.filter((u) => u.role === "customer" && !u.deleted);
  if (detailId) {
    const u = usr(detailId);
    const txs = data.txs.filter((t) => !t.deleted && t.cpId === detailId).reverse();
    const pend = calc.pending[detailId];
    return (
      <div className="space-y-4">
        <button onClick={() => setDetailId(null)} className="text-sm text-emerald-700 font-semibold">→ گەڕانەوە بۆ لیستی کڕیاران</button>
        <H>ئەکاونتی {u.name}</H>
        {(u.phone || u.address) && <div className="text-xs text-slate-500 -mt-2">{u.phone && <span style={num}>{u.phone}</span>}{u.phone && u.address && " · "}{u.address}</div>}
        {pend && (
          <Card className="p-4 border-amber-300 bg-amber-50">
            <div className="text-sm font-semibold text-amber-800 mb-1">قەرز لەسەر تۆ (چاوەڕوانی نووسینگە):</div>
            {Object.entries(pend.byCur).map(([cid, v]) => <div key={cid}><Money v={v} dec={cur(cid).dec} /> <span className="text-sm text-slate-600">{cur(cid).code}</span></div>)}
          </Card>
        )}
        <Card className="p-4">
          <div className="text-sm font-semibold mb-2 text-slate-600">مامەڵەی ڕاستەوخۆ لەگەڵ {u.name}</div>
          <TxForm data={data} cur={cur} avgRate={avgRate} calc={calc} onSave={(f, e) => onSave({ ...f, cpMode: "acc", cpId: detailId, cpName: "" }, e)} />
        </Card>
        <div className="text-sm font-semibold text-slate-600">مێژووی مامەڵەکان ({txs.length})</div>
        {txs.length === 0 ? <Card><Empty t="هیچ مامەڵەیەک نییە لەگەڵ ئەم کەسە" /></Card> : txs.map((t) => <TxRow key={t.id} t={t} cur={cur} usr={usr} />)}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <H>کڕیاران</H>
      {customers.length === 0 ? <Card><Empty t="هیچ کڕیارێک نییە — لە بەشی بەکارهێنەران زیادی بکە" /></Card> :
        customers.map((u) => {
          const cnt = data.txs.filter((t) => !t.deleted && t.cpId === u.id).length;
          const pend = calc.pending[u.id];
          return (
            <Card key={u.id} className="p-3 flex items-center justify-between cursor-pointer hover:border-emerald-600" >
              <button onClick={() => setDetailId(u.id)} className="text-right flex-1">
                <div className="font-semibold">{u.name}</div>
                <div className="text-xs text-slate-500">{cnt} مامەڵە {pend && <span className="text-amber-700 font-bold">— قەرزی چاوەڕوانی هەیە</span>}</div>
              </button>
              <Btn kind="ghost" onClick={() => setDetailId(u.id)}>کردنەوە</Btn>
            </Card>
          );
        })}
    </div>
  );
}

/* ================= هاوبەشان ================= */
function Partners({ data, calc, cur, transfer }) {
  const partners = data.users.filter((u) => u.role === "partner" && !u.deleted);
  const [tf, setTf] = useState({ partnerId: "", curId: data.currencies[0].id, amount: "", dir: "to" });
  const [sel, setSel] = useState(null);
  if (sel) {
    const p = partners.find((x) => x.id === sel);
    return (
      <div className="space-y-4">
        <button onClick={() => setSel(null)} className="text-sm text-emerald-700 font-semibold">→ گەڕانەوە بۆ لیستی هاوبەشان</button>
        <PartnerDetail p={p} data={data} calc={calc} cur={cur} />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <H>هاوبەشانی سین (هۆڵدەرەکان)</H>
      <Card className="p-4">
        <div className="text-sm font-semibold text-slate-600 mb-3">گواستنەوەی پارە (بێ کڕین و فرۆشتن)</div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div><Lbl>ئاڕاستە</Lbl><Sel value={tf.dir} onChange={(e) => setTf({ ...tf, dir: e.target.value })}><option value="to">لە قاسەی خۆمەوە بۆ لای هاوبەش</option><option value="back">لە لای هاوبەشەوە بۆ قاسەی خۆم</option></Sel></div>
          <div><Lbl>هاوبەش</Lbl><Sel value={tf.partnerId} onChange={(e) => setTf({ ...tf, partnerId: e.target.value })}><option value="">—</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Sel></div>
          <div><Lbl>دراو</Lbl><Sel value={tf.curId} onChange={(e) => setTf({ ...tf, curId: e.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
          <div><Lbl>بڕ</Lbl><Inp type="number" value={tf.amount} onChange={(e) => setTf({ ...tf, amount: e.target.value })} placeholder="0" /></div>
          <div className="flex items-end"><Btn kind="gold" className="w-full" onClick={() => { transfer(tf); setTf({ ...tf, amount: "" }); }}>گواستنەوە</Btn></div>
        </div>
      </Card>
      {partners.map((p) => {
        const bal = calc.partner[p.id] || {};
        const cnt = data.ledger.filter((e) => e.partnerId === p.id).length;
        const hasDebt = Object.values(bal).some((v) => v < 0);
        return (
          <Card key={p.id} className="p-3 flex items-center justify-between hover:border-emerald-600">
            <button onClick={() => setSel(p.id)} className="text-right flex-1">
              <div className="font-semibold">{p.name} <span className="text-xs text-slate-400 font-normal">— ڕێژە {p.rate}%</span></div>
              <div className="text-xs text-slate-500">{cnt} ئاڵووگۆر {hasDebt && <span className="text-rose-700 font-bold">— باڵانسی سالبی هەیە</span>}</div>
            </button>
            <div className="flex items-center gap-3">
              <div className="text-left text-sm hidden md:block">
                {Object.entries(bal).slice(0, 2).map(([cid, v]) => <div key={cid}><Money v={v} dec={cur(cid).dec} /> <span className="text-xs text-slate-400">{cur(cid).code}</span></div>)}
              </div>
              <Btn kind="ghost" onClick={() => setSel(p.id)}>کردنەوە</Btn>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/* ئەکاونتی هاوبەش — هاوبەشکراوە لە نێوان لای ئەدمین و پۆرتاڵی خودی هاوبەشەکە */
function PartnerDetail({ p, data, calc, cur }) {
  const bal = calc.partner[p.id] || {};
  const fees = {};
  data.ledger.forEach((e) => { if (e.partnerId === p.id && e.amount > 0) fees[e.curId] = (fees[e.curId] || 0) + e.amount * (p.rate / 100); });
  const hist = data.ledger.filter((e) => e.partnerId === p.id).slice().reverse();
  const TYPE_KU = { buy: "کڕین — دانان لای ئەم", sell: "فرۆشتن لە ئەکاونتی ئەم", transfer: "گواستنەوە", office_payment: "پارەدانی نووسینگە" };
  return (
    <div className="space-y-4">
      <H>ئەکاونتی {p.name}</H>
      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-4">
          <div className="text-sm font-semibold text-slate-600 mb-2">باڵانس (سالب = قەرز لەسەر خاوەن سیستەم)</div>
          {Object.keys(bal).length === 0 ? <Empty t="هیچ دراوێک دانەنراوە" /> :
            Object.entries(bal).map(([cid, v]) => (
              <div key={cid} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
                <span className="text-sm">{cur(cid).name}</span><Money v={v} dec={cur(cid).dec} />
              </div>
            ))}
        </Card>
        <Card className="p-4">
          <div className="text-sm font-semibold text-slate-600 mb-2">خێرەکەی ({p.rate}٪ لەو بڕانەی خراونەتە ئەکاونتەکەی)</div>
          {Object.keys(fees).length === 0 ? <Empty t="هێشتا هیچ" /> :
            Object.entries(fees).map(([cid, v]) => (
              <div key={cid} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
                <span className="text-sm">{cur(cid).name}</span><Money v={v} dec={cur(cid).dec} pos />
              </div>
            ))}
        </Card>
      </div>
      <div className="text-sm font-semibold text-slate-600">مێژووی ئاڵووگۆرەکان ({hist.length})</div>
      {hist.length === 0 ? <Card><Empty t="هیچ ئاڵووگۆرێک نییە" /></Card> :
        hist.map((e) => (
          <Card key={e.id} className="p-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${e.amount >= 0 ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}>{e.amount >= 0 ? "هاتنە ژوورەوە" : "چوونە دەرەوە"}</span>
            <span><Money v={e.amount} dec={cur(e.curId).dec} /> {cur(e.curId).code}</span>
            <span className="text-slate-500">{TYPE_KU[e.type] || e.type}</span>
            <span className="text-xs text-slate-400 mr-auto" style={num}>{new Date(e.date).toLocaleString("en-GB")}</span>
          </Card>
        ))}
    </div>
  );
}

/* ================= وەبەرهێنەران ================= */
function Investors({ data, calc, cur }) {
  const investors = data.users.filter((u) => u.role === "investor" && !u.deleted);
  const [sel, setSel] = useState(null);
  if (sel) {
    const u = investors.find((x) => x.id === sel);
    return (
      <div className="space-y-4">
        <button onClick={() => setSel(null)} className="text-sm text-emerald-700 font-semibold">→ گەڕانەوە بۆ لیستی وەبەرهێنەران</button>
        <InvestorDetail u={u} data={data} calc={calc} cur={cur} />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <H>وەبەرهێنەران</H>
      {investors.map((u) => {
        const cap = calc.invCap[u.id] || {};
        const cnt = data.ledger.filter((e) => e.investorId === u.id).length;
        return (
          <Card key={u.id} className="p-3 flex items-center justify-between hover:border-emerald-600">
            <button onClick={() => setSel(u.id)} className="text-right flex-1">
              <div className="font-semibold">{u.name} <span className="text-xs text-slate-400 font-normal">— ڕێژە {u.rate}%</span></div>
              <div className="text-xs text-slate-500">{cnt} ئاڵووگۆری پارە</div>
            </button>
            <div className="flex items-center gap-3">
              <div className="text-left text-sm hidden md:block">
                {Object.entries(cap).slice(0, 2).map(([cid, v]) => <div key={cid}><Money v={v} dec={cur(cid).dec} /> <span className="text-xs text-slate-400">{cur(cid).code}</span></div>)}
              </div>
              <Btn kind="ghost" onClick={() => setSel(u.id)}>کردنەوە</Btn>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/* ئەکاونتی وەبەرهێنەر — هاوبەشکراوە لە نێوان لای ئەدمین و پۆرتاڵی خودی وەبەرهێنەرەکە */
function InvestorDetail({ u, data, calc, cur }) {
  const cap = calc.invCap[u.id] || {};
  const hist = data.ledger.filter((e) => e.investorId === u.id).slice().reverse();
  // خێری کۆکراوە: بۆ هەر دراوێک = کۆی خێری فرۆشتنەکان × بەشی سەرمایەکەی × ڕێژەکەی
  const profitByCur = {};
  data.txs.forEach((t) => { if (!t.deleted && t.type === "sell" && t.profit != null) profitByCur[t.profitCurId] = (profitByCur[t.profitCurId] || 0) + t.profit; });
  const shares = {};
  Object.entries(profitByCur).forEach(([cid, total]) => {
    const myCap = calc.selfCap[cid] || 0;
    const invT = calc.invTotal[cid] || 0;
    const totalCap = myCap + invT;
    const c = cap[cid] || 0;
    if (totalCap > 0 && c > 0) shares[cid] = { share: c / totalCap, amount: total * (c / totalCap) * (u.rate / 100) };
  });
  return (
    <div className="space-y-4">
      <H>ئەکاونتی {u.name}</H>
      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-4">
          <div className="flex justify-between items-center mb-2">
            <div className="text-sm font-semibold text-slate-600">سەرمایەی داناو</div>
            <div className="text-xs bg-stone-100 px-2 py-1 rounded-full">ڕێژەی خێر: <span style={num}>{u.rate}%</span></div>
          </div>
          {Object.keys(cap).length === 0 ? <Empty t="هیچ پارەیەک دانەنراوە" /> :
            Object.entries(cap).map(([cid, v]) => (
              <div key={cid} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
                <span className="text-sm">{cur(cid).name}</span><Money v={v} dec={cur(cid).dec} />
              </div>
            ))}
        </Card>
        <Card className="p-4">
          <div className="text-sm font-semibold text-slate-600 mb-2">خێری کۆکراوە (بەپێی بەشی سەرمایە × ڕێژەکەی)</div>
          {Object.keys(shares).length === 0 ? <Empty t="هێشتا هیچ خێرێک نییە" /> :
            Object.entries(shares).map(([cid, s]) => (
              <div key={cid} className="flex justify-between py-2 border-b border-stone-100 last:border-0">
                <span className="text-sm">{cur(cid).name} <span className="text-xs text-slate-400">(بەشی {(s.share * 100).toFixed(1)}٪)</span></span>
                <Money v={s.amount} dec={cur(cid).dec} pos />
              </div>
            ))}
          <div className="text-xs text-slate-400 mt-2">حیسابەکە لەسەر بەشی ئێستای سەرمایەکەیەتی لە کۆی سەرمایەدا.</div>
        </Card>
      </div>
      <div className="text-sm font-semibold text-slate-600">مێژووی پارە دانان و دەرهێنان ({hist.length})</div>
      {hist.length === 0 ? <Card><Empty t="هیچ ئاڵووگۆرێک نییە" /></Card> :
        hist.map((e) => (
          <Card key={e.id} className="p-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${e.amount >= 0 ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}>{e.amount >= 0 ? "پارە دانان" : "پارە دەرهێنان"}</span>
            <span><Money v={e.amount} dec={cur(e.curId).dec} /> {cur(e.curId).code}</span>
            {e.note && <span className="text-slate-500 text-xs">{e.note}</span>}
            <span className="text-xs text-slate-400 mr-auto" style={num}>{new Date(e.date).toLocaleString("en-GB")}</span>
          </Card>
        ))}
    </div>
  );
}

/* ================= نووسینگە ================= */
function Office({ data, cur, usr, officePay, readOnlyUser }) {
  const pending = data.txs.filter((t) => !t.deleted && t.type === "buy" && t.status === "pending");
  const paid = data.txs.filter((t) => !t.deleted && t.paidAt);
  const sums = (filterFn) => {
    const m = {};
    paid.filter(filterFn).forEach((t) => (m[t.againstId] = (m[t.againstId] || 0) + t.total));
    return m;
  };
  const today = new Date(); const d0 = new Date(today.toDateString());
  const w0 = new Date(d0); w0.setDate(w0.getDate() - w0.getDay());
  const m0 = new Date(today.getFullYear(), today.getMonth(), 1);
  const S = ({ title, m }) => (
    <Card className="p-3 flex-1 min-w-[140px]">
      <div className="text-xs text-slate-500 mb-1">{title}</div>
      {Object.keys(m).length === 0 ? <div className="text-sm text-slate-400">0</div> :
        Object.entries(m).map(([cid, v]) => <div key={cid} className="text-sm"><Money v={v} dec={cur(cid).dec} /> {cur(cid).code}</div>)}
    </Card>
  );
  return (
    <div className="space-y-4">
      <H>پانێڵی نووسینگە</H>
      <div className="flex gap-3 flex-wrap">
        <S title="پارەی دراوی ئەمڕۆ" m={sums((t) => new Date(t.paidAt) >= d0)} />
        <S title="ئەم هەفتەیە" m={sums((t) => new Date(t.paidAt) >= w0)} />
        <S title="ئەم مانگە" m={sums((t) => new Date(t.paidAt) >= m0)} />
      </div>
      <div className="text-sm font-semibold text-slate-600">مامەڵە چاوەڕوانەکان ({pending.length})</div>
      {pending.length === 0 ? <Card><Empty t="هیچ مامەڵەیەکی چاوەڕوان نییە ✓" /></Card> :
        pending.map((t) => (
          <Card key={t.id} className="p-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            {t.code && <span className="text-xs font-bold text-slate-400 bg-stone-100 px-2 py-0.5 rounded" style={num}>#{t.code}</span>}
            <span className="font-semibold">{t.cpId ? usr(t.cpId).name : t.cpName}</span>
            <span>بدرێتێ: <Money v={t.total} dec={cur(t.againstId).dec} /> {cur(t.againstId).code}</span>
            <span className="text-slate-400 text-xs">(کڕینی {fmt(t.amount, cur(t.curId).dec)} {cur(t.curId).code})</span>
            <span className="text-xs text-slate-400" style={num}>{new Date(t.date).toLocaleString("en-GB")}</span>
            <Btn className="mr-auto flex items-center gap-1" onClick={() => officePay(t)}><CheckCircle2 className="w-4 h-4" /> پارەم دا</Btn>
          </Card>
        ))}
    </div>
  );
}

/* ================= ڕاپۆرتی تەواو: خێر و زەرەر، هاتوو و تێچوو ================= */
function Report({ data, calc, cur }) {
  const today = new Date();
  const [from, setFrom] = useState(new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10));
  const [to, setTo] = useState(today.toISOString().slice(0, 10));
  const [curId, setCurId] = useState("usd");
  const inRange = (d) => { const x = d.slice(0, 10); return x >= from && x <= to; };
  const txs = data.txs.filter((t) => !t.deleted && inRange(t.date));
  const entries = data.ledger.filter((e) => inRange(e.date));

  // ١) خێر و زەرەری فرۆشتنەکان بۆ هەر دراوێک
  const profitByCur = {}, lossByCur = {};
  txs.forEach((t) => {
    if (t.type === "sell" && t.profit != null) {
      if (t.profit >= 0) profitByCur[t.profitCurId] = (profitByCur[t.profitCurId] || 0) + t.profit;
      else lossByCur[t.profitCurId] = (lossByCur[t.profitCurId] || 0) + Math.abs(t.profit);
    }
  });
  // ٢) خەرجییەکان
  const expByCur = {};
  entries.forEach((e) => { if (e.type === "expense") expByCur[e.curId] = (expByCur[e.curId] || 0) + Math.abs(e.amount); });
  // ٣) کرێی هاوبەشان (لەو بڕانەی لەم ماوەیەدا خراونەتە ئەکاونتیان)
  const feeByCur = {};
  entries.forEach((e) => {
    if (e.partnerId && e.amount > 0) {
      const p = data.users.find((u) => u.id === e.partnerId);
      if (p) feeByCur[e.curId] = (feeByCur[e.curId] || 0) + e.amount * (p.rate / 100);
    }
  });
  // ٤) هاتوو و تێچووی هەر دراوێک (هەموو جوڵانەوەکان)
  const flow = {};
  entries.forEach((e) => {
    const fl = (flow[e.curId] = flow[e.curId] || { inn: 0, out: 0 });
    if (e.amount >= 0) fl.inn += e.amount; else fl.out += Math.abs(e.amount);
  });
  // ٥) قەبارەی کڕین و فرۆشتن
  const vol = {};
  txs.forEach((t) => {
    const v = (vol[t.curId] = vol[t.curId] || { buy: 0, sell: 0, buyN: 0, sellN: 0 });
    if (t.type === "buy") { v.buy += t.amount; v.buyN++; } else { v.sell += t.amount; v.sellN++; }
  });
  const allCurs = data.currencies.filter((c) =>
    profitByCur[c.id] || lossByCur[c.id] || expByCur[c.id] || feeByCur[c.id] || flow[c.id] || vol[c.id]);

  // ٦) دەرهێنانی CSV (بۆ ئێکسڵ)
  const exportCsv = () => {
    const head = ["کۆد", "جۆر", "بەروار", "لایەنی بەرامبەر", "دراو", "بڕ", "نرخ", "بەرامبەر", "کۆ", "شوێن", "دۆخ", "خێر/زەرەر"];
    const rows = txs.map((t) => [
      t.code || "", t.type === "buy" ? "کڕین" : "فرۆشتن", new Date(t.date).toLocaleString("en-GB"),
      t.cpId ? (data.users.find((u) => u.id === t.cpId) || {}).name : t.cpName,
      cur(t.curId).code, t.amount, t.rate, cur(t.againstId).code, t.total,
      t.partnerId ? "لای " + (data.users.find((u) => u.id === t.partnerId) || {}).name : "لای خۆم",
      t.status === "pending" ? "چاوەڕوانی نووسینگە" : "تەواوکراو",
      t.profit != null ? t.profit : "",
    ]);
    const csv = "\uFEFF" + [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `report_${from}_${to}.csv`;
    a.click();
  };

  // ٧) دابەشکردنی خێر بۆ وەبەرهێنەران (بۆ ماوە و دراوی هەڵبژێردراو)
  const netProfitSel = (profitByCur[curId] || 0) - (lossByCur[curId] || 0);
  const investors = data.users.filter((u) => u.role === "investor" && !u.deleted);
  const myCap = calc.selfCap[curId] || 0;
  const capList = investors.map((u) => ({ u, cap: (calc.invCap[u.id] || {})[curId] || 0 })).filter((x) => x.cap > 0);
  const totalCap = myCap + capList.reduce((s, x) => s + x.cap, 0);
  let adminTotal = totalCap > 0 ? netProfitSel * (myCap / totalCap) : netProfitSel;
  const rows = capList.map(({ u, cap }) => {
    const share = totalCap > 0 ? cap / totalCap : 0;
    const gross = netProfitSel * share;
    const invAmt = gross * (u.rate / 100);
    adminTotal += gross - invAmt;
    return { u, cap, share, gross, invAmt };
  });
  const c = cur(curId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <H>ڕاپۆرتی تەواو</H>
        <Btn kind="ghost" onClick={exportCsv}>دەرهێنان بۆ ئێکسڵ (CSV)</Btn>
      </div>
      <Card className="p-4 flex gap-3 flex-wrap items-end">
        <div><Lbl>لە بەرواری</Lbl><Inp type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><Lbl>بۆ بەرواری</Lbl><Inp type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="text-xs text-slate-400 pb-2" style={num}>{txs.length} مامەڵە لەم ماوەیەدا</div>
      </Card>

      <Card className="p-4 overflow-x-auto">
        <div className="text-sm font-semibold text-slate-600 mb-3">خێر و زەرەر — بۆ هەر دراوێک جیا</div>
        <table className="w-full text-sm">
          <thead><tr className="text-slate-500 text-xs border-b border-stone-200">
            <th className="text-right py-2">دراو</th><th className="text-right">خێری فرۆشتن</th><th className="text-right">زەرەری فرۆشتن</th><th className="text-right">خەرجی</th><th className="text-right">کرێی هاوبەشان</th><th className="text-right">نەتیجەی کۆتایی</th>
          </tr></thead>
          <tbody>
            {allCurs.length === 0 ? <tr><td colSpan={6}><Empty t="هیچ جوڵانەوەیەک نییە لەم ماوەیەدا" /></td></tr> :
              allCurs.map((cc) => {
                const net = (profitByCur[cc.id] || 0) - (lossByCur[cc.id] || 0) - (expByCur[cc.id] || 0) - (feeByCur[cc.id] || 0);
                return (
                  <tr key={cc.id} className="border-b border-stone-100">
                    <td className="py-2 font-semibold">{cc.name}</td>
                    <td><Money v={profitByCur[cc.id] || 0} dec={cc.dec} pos /></td>
                    <td>{lossByCur[cc.id] ? <Money v={-lossByCur[cc.id]} dec={cc.dec} /> : <span className="text-slate-300">0</span>}</td>
                    <td>{expByCur[cc.id] ? <Money v={-expByCur[cc.id]} dec={cc.dec} /> : <span className="text-slate-300">0</span>}</td>
                    <td>{feeByCur[cc.id] ? <Money v={-feeByCur[cc.id]} dec={cc.dec} /> : <span className="text-slate-300">0</span>}</td>
                    <td className="font-bold"><Money v={net} dec={cc.dec} pos /></td>
                  </tr>
                );
              })}
          </tbody>
        </table>
        <div className="text-xs text-slate-400 mt-2">نەتیجەی کۆتایی = خێری فرۆشتن − زەرەر − خەرجی − کرێی هاوبەشان (بۆ هەمان دراو).</div>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-4 overflow-x-auto">
          <div className="text-sm font-semibold text-slate-600 mb-3">هاتوو و تێچوو (جوڵانەوەی قاسە)</div>
          <table className="w-full text-sm">
            <thead><tr className="text-slate-500 text-xs border-b border-stone-200">
              <th className="text-right py-2">دراو</th><th className="text-right">هاتوو</th><th className="text-right">تێچوو</th><th className="text-right">جیاوازی</th>
            </tr></thead>
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
        <Card className="p-4 overflow-x-auto">
          <div className="text-sm font-semibold text-slate-600 mb-3">قەبارەی کڕین و فرۆشتن</div>
          <table className="w-full text-sm">
            <thead><tr className="text-slate-500 text-xs border-b border-stone-200">
              <th className="text-right py-2">دراو</th><th className="text-right">کڕدراو</th><th className="text-right">فرۆشراو</th><th className="text-right">ژ. مامەڵە</th>
            </tr></thead>
            <tbody>
              {Object.keys(vol).length === 0 ? <tr><td colSpan={4}><Empty t="هیچ" /></td></tr> :
                Object.entries(vol).map(([cid, v]) => (
                  <tr key={cid} className="border-b border-stone-100">
                    <td className="py-2">{cur(cid).name}</td>
                    <td><Money v={v.buy} dec={cur(cid).dec} pos /></td>
                    <td><Money v={v.sell} dec={cur(cid).dec} /></td>
                    <td style={num}>{v.buyN + v.sellN} ({v.buyN} کڕین / {v.sellN} فرۆشتن)</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Card>
      </div>

      <Card className="p-4 overflow-x-auto">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div className="text-sm font-semibold text-slate-600">دابەشکردنی خێر بۆ وەبەرهێنەران — نەتی {c.name}: <Money v={netProfitSel} dec={c.dec} pos /></div>
          <div className="w-40"><Sel value={curId} onChange={(e) => setCurId(e.target.value)}>{data.currencies.map((cc) => <option key={cc.id} value={cc.id}>{cc.name}</option>)}</Sel></div>
        </div>
        <table className="w-full text-sm">
          <thead><tr className="text-slate-500 text-xs border-b border-stone-200">
            <th className="text-right py-2">وەبەرهێنەر</th><th className="text-right">سەرمایە</th><th className="text-right">بەشی سەرمایە</th><th className="text-right">بەشی خێر</th><th className="text-right">ڕێژە</th><th className="text-right">بۆ وەبەرهێنەر</th>
          </tr></thead>
          <tbody>
            <tr className="border-b border-stone-100"><td className="py-2 font-semibold">خۆم (ئەدمین)</td><td><Money v={myCap} dec={c.dec} /></td><td style={num}>{totalCap ? ((myCap / totalCap) * 100).toFixed(1) : 0}%</td><td colSpan={2}></td><td><Money v={adminTotal} dec={c.dec} pos /></td></tr>
            {rows.map(({ u, cap, share, gross, invAmt }) => (
              <tr key={u.id} className="border-b border-stone-100">
                <td className="py-2">{u.name}</td><td><Money v={cap} dec={c.dec} /></td>
                <td style={num}>{(share * 100).toFixed(1)}%</td><td><Money v={gross} dec={c.dec} /></td>
                <td style={num}>{u.rate}%</td><td><Money v={invAmt} dec={c.dec} pos /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="text-xs text-slate-400 mt-2">دابەشکردنەکە لەسەر خێری نەتی فرۆشتنەکانی هەمان ماوەیە (خێر − زەرەر). بەشی هەر وەبەرهێنەرێک = بەشی سەرمایەکەی × نەتی خێر × ڕێژەکەی، پاشماوە بۆ ئەدمین.</div>
      </Card>
    </div>
  );
}

/* ================= بەکارهێنەران ================= */
function UsersAdmin({ data, createUser, deleteUser, setUserRate, flash }) {
  const [f, setF] = useState({ name: "", role: "customer", rate: "", phone: "", address: "", note: "", password: "" });
  const roles = ["customer", "partner", "investor", "office"];
  const list = data.users.filter((u) => u.role !== "admin" && !u.deleted);
  return (
    <div className="space-y-4">
      <H>بەکارهێنەران</H>
      <Card className="p-4">
        <div className="text-sm font-semibold text-slate-600 mb-3">درووستکردنی ئەکاونتی نوێ</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div><Lbl>ناوی تەواو *</Lbl><Inp value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><Lbl>ڕۆڵ *</Lbl><Sel value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roles.map((r) => <option key={r} value={r}>{ROLE_KU[r]}</option>)}</Sel></div>
          {(f.role === "partner" || f.role === "investor") && <div><Lbl>ڕێژەی خێر ٪</Lbl><Inp type="number" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></div>}
          <div><Lbl>ژمارەی مۆبایل * (بۆ لۆگین)</Lbl><Inp type="tel" dir="ltr" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="07701234567" /></div>
          <div><Lbl>وشەی نهێنی * (کەمترین ٦ پیت)</Lbl><Inp type="password" dir="ltr" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="••••••" /></div>
          <div><Lbl>ناونیشان</Lbl><Inp value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} placeholder="شار / گەڕەک" /></div>
          <div><Lbl>تێبینی</Lbl><Inp value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
        </div>
        <div className="mt-3">
          <Btn className="flex items-center gap-1" onClick={() => {
            if (!f.name || !f.phone || !f.password) return flash("ناو، ژمارە، و وشەی نهێنی پێویستن");
            createUser(f);
            setF({ name: "", role: "customer", rate: "", phone: "", address: "", note: "", password: "" });
          }}><Plus className="w-4 h-4" /> درووستکردن</Btn>
        </div>
        <div className="text-xs text-slate-400 mt-2">دوای درووستکردن، کەسەکە دەتوانێت بە ژمارەکەی و وشەی نهێنییەکەی لۆگین بکات لە sarraf-system.vercel.app</div>
      </Card>
      {list.map((u) => (
        <Card key={u.id} className="p-3 flex items-center gap-3 flex-wrap">
          <div className="flex-1">
            <div className="font-semibold">{u.name}</div>
            <div className="text-xs text-slate-500">
              {ROLE_KU[u.role]}
              {u.phone && <span style={num}> · {u.phone}</span>}
              {u.address && <span> · {u.address}</span>}
            </div>
            {u.note && <div className="text-xs text-slate-400 mt-0.5">{u.note}</div>}
          </div>
          {(u.role === "partner" || u.role === "investor") && (
            <div className="flex items-center gap-1 text-sm">
              <span className="text-slate-500 text-xs">ڕێژە:</span>
              <input type="number" defaultValue={u.rate} onBlur={(e) => {
                if (+e.target.value !== u.rate) setUserRate(u, e.target.value);
              }} className="w-16 border border-stone-300 rounded px-2 py-1 text-sm" style={num} />
              <span className="text-xs">%</span>
            </div>
          )}
          <button onClick={() => deleteUser(u)} className="text-slate-400 hover:text-rose-700"><Trash2 className="w-4 h-4" /></button>
        </Card>
      ))}
    </div>
  );
}

/* ================= تۆماری گۆڕانکاری ================= */
function Audit({ data }) {
  return (
    <div className="space-y-3">
      <H>تۆماری گۆڕانکاری (Audit Log)</H>
      {data.audit.length === 0 ? <Card><Empty t="هێشتا هیچ کردارێک تۆمار نەکراوە" /></Card> :
        data.audit.slice(0, 100).map((a) => (
          <Card key={a.id} className="p-3 flex items-center gap-3 text-sm">
            <History className="w-4 h-4 text-slate-400 shrink-0" />
            <span className="font-semibold">{a.action}</span>
            <span className="text-slate-500 flex-1">{a.detail}</span>
            <span className="text-xs text-slate-400" style={num}>{new Date(a.date).toLocaleString("en-GB")}</span>
          </Card>
        ))}
    </div>
  );
}

/* ================= پۆرتاڵی ڕۆڵەکانی تر (بینین وەک...) ================= */
function Portal({ user, data, calc, cur, usr, officePay }) {
  if (user.role === "office") return <Office data={data} cur={cur} usr={usr} officePay={officePay} />;
  if (user.role === "customer") {
    const txs = data.txs.filter((t) => !t.deleted && t.cpId === user.id).reverse();
    const pend = calc.pending[user.id];
    return (
      <div className="space-y-4">
        <H>بەخێربێیت، {user.name}</H>
        {pend && (
          <Card className="p-4 border-amber-300 bg-amber-50">
            <div className="text-sm font-semibold text-amber-800 mb-1">پارەی چاوەڕوانکراو بۆت (لە نووسینگەوە):</div>
            {Object.entries(pend.byCur).map(([cid, v]) => <div key={cid}><Money v={v} dec={cur(cid).dec} /> {cur(cid).code}</div>)}
          </Card>
        )}
        <div className="text-sm font-semibold text-slate-600">مێژووی مامەڵەکانت ({txs.length})</div>
        {txs.length === 0 ? <Card><Empty t="هیچ مامەڵەیەکت نییە" /></Card> : txs.map((t) => <TxRow key={t.id} t={t} cur={cur} usr={usr} />)}
      </div>
    );
  }
  if (user.role === "partner") {
    return (
      <div className="space-y-4">
        <div className="text-sm text-slate-500">بەخێربێیت 👋</div>
        <PartnerDetail p={user} data={data} calc={calc} cur={cur} />
      </div>
    );
  }
  if (user.role === "investor") {
    return (
      <div className="space-y-4">
        <div className="text-sm text-slate-500">بەخێربێیت 👋</div>
        <InvestorDetail u={user} data={data} calc={calc} cur={cur} />
      </div>
    );
  }
  return null;
}
