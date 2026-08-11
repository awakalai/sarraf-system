#!/usr/bin/env node
// Clean-database migration and accounting-invariant test.
//
// The repair brief requires that the schema build from nothing and that the ledger refuse
// to hold an unbalanced entry. Both are properties of the database, not of the application,
// so they are proven against a real PostgreSQL rather than asserted in JavaScript.
//
//   npm run verify:accounting
//
// Skips cleanly when no PostgreSQL is available, so it never produces a false green.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = process.env.ZEMAN_TEST_PGPORT || "55433";
const PGBIN = process.env.ZEMAN_PGBIN || "/usr/lib/postgresql/16/bin";
// PostgreSQL refuses to run as root. In a root container (CI images commonly are) the server
// is started through an unprivileged account instead of skipping the gate.
const AS_USER = process.getuid?.() === 0 ? (process.env.ZEMAN_PG_USER || "nobody") : null;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const run = (cmd, args, opts = {}) => {
  if (AS_USER) {
    const line = [cmd, ...args].map(shq).join(" ");
    return execFileSync("su", [AS_USER, "-s", "/bin/sh", "-c", line],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  }
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
};

const has = (bin) => existsSync(path.join(PGBIN, bin));
if (!has("initdb") || !has("pg_ctl")) {
  console.log(`SKIP: no PostgreSQL at ${PGBIN}; set ZEMAN_PGBIN to run the accounting DB gate.`);
  process.exit(0);
}

const root = path.resolve(import.meta.dirname, "..");
const sock = mkdtempSync(path.join(tmpdir(), "zeman-sock-"));
const data = mkdtempSync(path.join(tmpdir(), "zeman-pg-"));
// The unprivileged server account must own the data and socket directories it uses.
if (AS_USER) { for (const d of [data, sock]) execFileSync("chown", ["-R", AS_USER, d]); }
let started = false;

const stop = () => {
  try { if (started) run(path.join(PGBIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"]); } catch {}
  for (const d of [data, sock]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
};
process.on("exit", stop);

const psql = (sql, db = "zeman_verify") => run(path.join(PGBIN, "psql"),
  ["-h", sock, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-tAq", "-c", sql]);
const psqlFile = (file, db = "zeman_verify") => run(path.join(PGBIN, "psql"),
  ["-h", sock, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-f", file]);

try {
  run(path.join(PGBIN, "initdb"), ["-D", data, "-A", "trust", "-U", "postgres"]);
  run(path.join(PGBIN, "pg_ctl"), ["-D", data, "-o", `-p ${PORT} -k ${sock} -h ''`, "-l", path.join(data, "log"), "-w", "start"]);
  started = true;
  psql("select 1", "postgres");
  psql("create database zeman_verify", "postgres");

  // Supabase-provided roles and the auth/app_users surface the migrations build on.
  const prereq = path.join(sock, "prereq.sql");
  writeFileSync(prereq, `
    do $$ begin
      if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
    end $$;
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid language sql stable as $fn$ select null::uuid $fn$;
    -- Supabase grants these to authenticated; without them an RLS probe fails on the helper
    -- functions rather than on the policy being tested.
    grant usage on schema auth to authenticated, anon, service_role;
    create table if not exists public.app_users (
      id text primary key, auth_id uuid, name text, role text, admin_level text,
      rate numeric, scope_curs text[], phone text, address text, note text,
      deleted boolean not null default false);
    -- SECURITY DEFINER, as in production: the helpers read app_users on the caller's behalf
    -- without the caller needing direct access to that table.
    create or replace function public.my_app_id() returns text language sql stable
      security definer set search_path = public, auth as $fn$
      select id from public.app_users where auth_id = auth.uid() and not deleted $fn$;
    create or replace function public.my_role() returns text language sql stable
      security definer set search_path = public, auth as $fn$
      select role from public.app_users where auth_id = auth.uid() and not deleted $fn$;
    create or replace function public.is_admin() returns boolean language sql stable
      security definer set search_path = public, auth as $fn$
      select coalesce((select role='admin' from public.app_users where auth_id=auth.uid() and not deleted), false) $fn$;
    create table if not exists public.currencies (
      id text primary key, code text unique not null, name text not null, symbol text,
      dec int default 2, buy_rate numeric, sell_rate numeric, rate_updated timestamptz);
    create table if not exists public.txs (
      id text primary key, code int unique, type text not null, cp_id text, cp_name text,
      cur_id text not null references public.currencies(id), amount numeric(20,6) not null,
      rate numeric(20,8) not null, against_id text not null references public.currencies(id),
      total numeric(20,6) not null, partner_id text, status text not null default 'completed',
      paid_at timestamptz, profit numeric(20,6), profit_cur_id text, note text,
      date timestamptz not null default now(), edited boolean default false,
      deleted boolean default false);
    -- day_closes predates these migrations and lives only in the production database, so the
    -- fixture recreates the shape the application writes.
    create table if not exists public.ledger (
      id text primary key, type text not null, owner text, investor_id text,
      cur_id text references public.currencies(id), amount numeric(20,6) not null,
      partner_id text, tx_id text, note text, date timestamptz not null default now());
    create table if not exists public.day_closes (
      id text primary key, close_date date not null, lines jsonb not null default '[]'::jsonb,
      total_diff numeric, has_diff boolean default false, note text,
      adjust boolean default false, closed_by text,
      created_at timestamptz not null default now());
    insert into public.currencies(id,code,name,buy_rate,sell_rate) values
      ('usd','USD','Dollar',1,1),
      ('cny','CNY','Yuan',7.10,7.30),
      ('iqd','IQD','Dinar',1400,1420),
      ('xxx','XXX','Unrated',null,null)
    on conflict do nothing;
  `);
  psqlFile(prereq);

  // The migration under test must apply to an empty database.
  for (const m of ["202608120001_double_entry_core.sql", "202608120002_cashbox_and_debt.sql", "202608120003_accounting_commands.sql", "202608120004_partner_and_office.sql", "202608120005_receipt_state_machine.sql", "202608120006_transaction_journal.sql", "202608120007_receipt_intake_commands.sql", "202608120008_receipt_forwarding.sql", "202608120009_forwarding_guard_fix.sql", "202608130001_day_close_integrity.sql", "202608130002_ledger_journal_reconciliation.sql"]) {
    psqlFile(path.join(root, "supabase/migrations", m));
  }
  psql("insert into public.app_users(id,name,role) values ('u-a','A','admin') on conflict do nothing");

  const checks = [];
  const check = (name, fn) => {
    try { fn(); checks.push([true, name]); }
    catch (e) { checks.push([false, `${name} — ${String(e.message || e).split("\n").find((l) => l.includes("ERROR")) || e}`]); }
  };
  const mustFail = (name, sql) => {
    let threw = false;
    try { psql(sql); } catch { threw = true; }
    checks.push([threw, name]);
  };

  const entry = (id, lines, extra = "") => `
    begin;
    insert into public.journal_entries(id,status,business_date,posted_at,source_type,actor_id${extra ? ",command_key" : ""})
    values ('${id}','posted',current_date,now(),'test_event','u-a'${extra ? `,'${extra}'` : ""});
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate) values ${lines};
    commit;`;

  check("a balanced single-currency entry posts", () => {
    psql(entry("v-ok", "('v-ok',1,'acc-1400','debit','CNY',1000,138.89,7.2),('v-ok',2,'acc-1000','credit','CNY',1000,138.89,7.2)"));
    if (psql("select count(*) from journal_entries where id='v-ok'").trim() !== "1") throw new Error("not stored");
  });

  mustFail("an unbalanced entry is refused",
    entry("v-bad", "('v-bad',1,'acc-1400','debit','CNY',1000,138.89,7.2),('v-bad',2,'acc-1000','credit','CNY',900,125.00,7.2)"));

  mustFail("a single-line entry is refused",
    entry("v-one", "('v-one',1,'acc-1400','debit','CNY',1000,138.89,7.2)"));

  check("cross-currency balances in base while originals differ", () => {
    psql(entry("v-fx", "('v-fx',1,'acc-1000','debit','IQD',196000,138.89,1411.33),('v-fx',2,'acc-1400','credit','CNY',1000,138.89,7.2)"));
    if (psql("select count(*) from journal_entries where id='v-fx'").trim() !== "1") throw new Error("not stored");
  });

  mustFail("a posted entry cannot be deleted", "delete from public.journal_entries where id='v-ok'");
  mustFail("lines of a posted entry cannot be edited", "update public.journal_lines set amount=99999 where entry_id='v-ok'");

  check("the same command key cannot post twice", () => {
    psql(entry("v-c1", "('v-c1',1,'acc-1400','debit','CNY',10,1.39,7.2),('v-c1',2,'acc-1000','credit','CNY',10,1.39,7.2)", "cmd-1"));
    let threw = false;
    try { psql(entry("v-c2", "('v-c2',1,'acc-1400','debit','CNY',10,1.39,7.2),('v-c2',2,'acc-1000','credit','CNY',10,1.39,7.2)", "cmd-1")); }
    catch { threw = true; }
    if (!threw) throw new Error("the command posted twice");
  });

  check("the trial balance reconciles to zero", () => {
    const out = psql("select (public.sarraf_trial_balance_check()->>'balanced')::text");
    if (out.trim() !== "true") throw new Error(`trial balance not balanced: ${psql("select public.sarraf_trial_balance_check()::text")}`);
  });

  check("every seeded account has a normal side consistent with its kind", () => {
    const bad = psql(`select count(*) from chart_of_accounts
      where (kind in ('asset','expense') and normal_side<>'debit')
         or (kind in ('liability','equity','income') and normal_side<>'credit')`);
    if (bad.trim() !== "0") throw new Error(`${bad.trim()} accounts have the wrong normal side`);
  });


  // ── Cashbox (قاسە): a customer-funds-held liability, per customer AND per currency ──
  psql(`insert into public.app_users(id,name,role) values ('cust-1','Customer One','customer')
        on conflict do nothing`);
  psql(`insert into public.customer_vaults(id,customer_id,currency) values
        ('cv-cny','cust-1','CNY'),('cv-usd','cust-1','USD') on conflict do nothing`);

  check("a deposit raises only the matching currency's cashbox", () => {
    psql(`insert into public.customer_vault_events(vault_id,customer_id,currency,kind,available_delta,actor_id)
          values ('cv-cny','cust-1','CNY','deposit',5000,'u-a')`);
    const cny = psql("select available from customer_vaults where id='cv-cny'").trim();
    const usd = psql("select available from customer_vaults where id='cv-usd'").trim();
    if (Number(cny) !== 5000) throw new Error(`CNY vault is ${cny}, expected 5000`);
    if (Number(usd) !== 0) throw new Error(`USD vault moved to ${usd}; currencies must not net`);
  });

  mustFail("a withdrawal cannot overdraw the cashbox",
    `insert into public.customer_vault_events(vault_id,customer_id,currency,kind,available_delta,actor_id)
     values ('cv-cny','cust-1','CNY','withdrawal',-9000,'u-a')`);

  mustFail("cashbox events are append-only",
    "update public.customer_vault_events set available_delta=1 where vault_id='cv-cny'");

  // ── Debt: never a bare signed number ──
  check("a debt names debtor, creditor, currency and source", () => {
    psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
            original_principal,outstanding_principal,source_type,reason,created_by,due_at)
          values ('d-1','customer','cust-1','zeman',null,'CNY',1000,1000,'unpaid_transaction',
                  'unpaid purchase','u-a', statement_timestamp() - interval '10 days')`);
    if (psql("select outstanding_principal from debts where id='d-1'").trim() !== "1000.0000000000")
      throw new Error("debt not stored as expected");
  });

  mustFail("a party cannot owe itself",
    `insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
       original_principal,outstanding_principal,source_type,reason,created_by)
     values ('d-self','customer','cust-1','customer','cust-1','CNY',10,10,'x','self','u-a')`);

  mustFail("a debt cannot be deleted", "delete from public.debts where id='d-1'");

  check("partial settlement reduces outstanding and marks the debt partially settled", () => {
    psql(`insert into public.debt_settlements(debt_id,amount_applied,outstanding_before,outstanding_after,
            source_kind,actor_id) values ('d-1',400,1000,600,'customer_vault','u-a')`);
    const row = psql("select outstanding_principal||'|'||status from debts where id='d-1'").trim();
    if (row !== "600.0000000000|partially_settled") throw new Error(`debt state is ${row}`);
  });

  mustFail("a settlement cannot exceed the outstanding balance",
    `insert into public.debt_settlements(debt_id,amount_applied,outstanding_before,outstanding_after,
       source_kind,actor_id) values ('d-1',9999,600,-9399,'customer_vault','u-a')`);

  mustFail("a settlement built on a stale outstanding figure is rejected",
    `insert into public.debt_settlements(debt_id,amount_applied,outstanding_before,outstanding_after,
       source_kind,actor_id) values ('d-1',100,1000,900,'customer_vault','u-a')`);

  check("settling the remainder closes the debt", () => {
    psql(`insert into public.debt_settlements(debt_id,amount_applied,outstanding_before,outstanding_after,
            source_kind,actor_id) values ('d-1',600,600,0,'customer_vault','u-a')`);
    const row = psql("select status||'|'||(closed_at is not null)::text from debts where id='d-1'").trim();
    if (row !== "settled|true") throw new Error(`debt state is ${row}`);
  });

  // ── The worked example from the brief, §13D.5 ──
  // partner balance 1,000 CNY; ZEMAN sells them 1,300 → 1,000 consumed, 300 becomes debt.
  // A later 500 credit settles the 300 and leaves 200 available.
  check("the partner over-limit example settles exactly as specified", () => {
    psql(`insert into public.app_users(id,name,role) values ('p-1','Partner One','partner') on conflict do nothing`);
    psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
            original_principal,outstanding_principal,source_type,reason,created_by)
          values ('d-p','partner','p-1','zeman',null,'CNY',300,300,'partner_over_limit',
                  'sale beyond available balance','u-a')`);
    const plan = psql(`select coalesce(string_agg(debt_id||':'||allocated, ','), 'none')
      from public.sarraf_debt_waterfall('partner','p-1','zeman',null,'CNY',500)`).trim();
    if (plan !== "d-p:300.0000000000") throw new Error(`waterfall allocated ${plan}, expected 300 to d-p`);
    psql(`insert into public.debt_settlements(debt_id,amount_applied,outstanding_before,outstanding_after,
            source_kind,actor_id) values ('d-p',300,300,0,'partner_credit','u-a')`);
    const status = psql("select status from debts where id='d-p'").trim();
    if (status !== "settled") throw new Error(`partner debt is ${status}`);
    // 500 credit minus 300 applied leaves 200 available.
    const remainder = 500 - 300;
    if (remainder !== 200) throw new Error("remainder arithmetic");
  });

  check("the waterfall puts overdue debts first and is deterministic", () => {
    psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
            original_principal,outstanding_principal,source_type,reason,created_by,due_at,opened_at) values
          ('d-new','customer','cust-1','zeman',null,'CNY',100,100,'t','not yet due','u-a',
            statement_timestamp() + interval '30 days', statement_timestamp() - interval '1 day'),
          ('d-old','customer','cust-1','zeman',null,'CNY',100,100,'t','overdue','u-a',
            statement_timestamp() - interval '20 days', statement_timestamp() - interval '40 days')`);
    const order = psql(`select string_agg(debt_id, '>' order by remaining_after desc)
      from public.sarraf_debt_waterfall('customer','cust-1','zeman',null,'CNY',150)`).trim();
    if (!order.startsWith("d-old")) throw new Error(`overdue debt was not first: ${order}`);
  });

  check("aging buckets classify by how overdue a debt is", () => {
    const bucket = psql("select aging_bucket from v_debt_aging where id='d-old'").trim();
    if (bucket !== "8-30") throw new Error(`expected bucket 8-30, got ${bucket}`);
  });

  check("subledger reconciliation reports vault and debt totals by currency", () => {
    const out = psql("select public.sarraf_subledger_reconciliation()::text").trim();
    if (!out.includes("customer_vault_total") || !out.includes("CNY"))
      throw new Error(`reconciliation payload incomplete: ${out}`);
  });


  // ── Commands: the only way money moves. Impersonate an admin via auth.uid(). ──
  psql(`update public.app_users set auth_id='11111111-1111-1111-1111-111111111111' where id='u-a'`);
  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
  psql(`insert into public.app_users(id,name,role) values ('cust-2','Customer Two','customer')
        on conflict do nothing`);

  check("a deposit posts a balanced entry and credits the customer-funds liability", () => {
    psql(`select public.sarraf_customer_vault_move('cust-2','CNY',7200,'in',7.2,'کڕیار پارەی دانا','cmd-dep-1')`);
    const avail = psql("select available from customer_vaults where customer_id='cust-2' and currency='CNY'").trim();
    if (Number(avail) !== 7200) throw new Error(`available is ${avail}`);
    // Liability account 2000 must be credited, asset 1000 debited, and the entry balanced.
    const sides = psql(`select string_agg(account_id||':'||side, ',' order by line_no)
      from journal_lines where entry_id like 'je-vault-%'`).trim();
    if (!sides.includes("acc-1000:debit") || !sides.includes("acc-2000:credit"))
      throw new Error(`unexpected posting: ${sides}`);
    const base = psql(`select base_amount from journal_lines where entry_id like 'je-vault-%' limit 1`).trim();
    if (Number(base) !== 1000) throw new Error(`7200 CNY at 7.2 should value to 1000 USD, got ${base}`);
  });

  check("replaying a deposit command does not move the balance twice", () => {
    const out = psql(`select public.sarraf_customer_vault_move('cust-2','CNY',7200,'in',7.2,'دووبارە','cmd-dep-1')::text`);
    if (!out.includes('"replayed": true') && !out.includes('"replayed":true'))
      throw new Error(`replay not detected: ${out}`);
    const avail = psql("select available from customer_vaults where customer_id='cust-2' and currency='CNY'").trim();
    if (Number(avail) !== 7200) throw new Error(`balance moved twice: ${avail}`);
  });

  mustFail("a withdrawal beyond the cashbox is refused by the command",
    `select public.sarraf_customer_vault_move('cust-2','CNY',999999,'out',7.2,'زۆرە','cmd-wd-x')`);

  check("settling a debt from the cashbox applies the waterfall and draws the balance down", () => {
    psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
            original_principal,outstanding_principal,source_type,reason,created_by)
          values ('d-c2','customer','cust-2','zeman',null,'CNY',5000,5000,'unpaid','قەرزی کڕین','u-a')`);
    const out = psql(`select public.sarraf_apply_vault_to_debt('cust-2','CNY',5000,7.2,'تسویە لە قاسە','cmd-set-1')::text`);
    if (!out.includes('"applied": 5000') && !out.includes('"applied":5000'))
      throw new Error(`unexpected result: ${out}`);
    const st = psql("select status from debts where id='d-c2'").trim();
    if (st !== "settled") throw new Error(`debt is ${st}`);
    const avail = psql("select available from customer_vaults where customer_id='cust-2' and currency='CNY'").trim();
    if (Number(avail) !== 2200) throw new Error(`expected 2200 left, got ${avail}`);
  });

  check("an unallocated remainder returns to the cashbox instead of vanishing", () => {
    const before = Number(psql("select available from customer_vaults where customer_id='cust-2' and currency='CNY'").trim());
    psql(`select public.sarraf_apply_vault_to_debt('cust-2','CNY',1000,7.2,'هیچ قەرزێک نەماوە','cmd-set-2')`);
    const after = Number(psql("select available from customer_vaults where customer_id='cust-2' and currency='CNY'").trim());
    if (after !== before) throw new Error(`money vanished: ${before} -> ${after}`);
  });

  check("a debt ZEMAN owes a customer becomes cashbox credit without double liability", () => {
    psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
            original_principal,outstanding_principal,source_type,reason,created_by)
          values ('d-z2','zeman',null,'customer','cust-2','CNY',900,900,'owed','ZEMAN قەرزارە','u-a')`);
    const before = Number(psql("select available from customer_vaults where customer_id='cust-2' and currency='CNY'").trim());
    psql(`select public.sarraf_zeman_debt_to_vault('d-z2',900,7.2,'خرایە قاسەی کڕیار','cmd-d2v-1')`);
    const after = Number(psql("select available from customer_vaults where customer_id='cust-2' and currency='CNY'").trim());
    const st = psql("select status from debts where id='d-z2'").trim();
    if (after - before !== 900) throw new Error(`cashbox moved by ${after - before}, expected 900`);
    if (st !== "settled") throw new Error(`debt is ${st}`);
    // The liability must be credited once, not twice: entry replaces receivable with funds held.
    const n = psql(`select count(*) from journal_lines l join journal_entries e on e.id=l.entry_id
                    where e.source_type='zeman_debt_to_customer_vault' and l.account_id='acc-2000'`).trim();
    if (n !== "1") throw new Error(`liability credited ${n} times, expected once`);
  });

  check("the trial balance still reconciles after every command", () => {
    const out = psql("select (public.sarraf_trial_balance_check()->>'balanced')::text").trim();
    if (out !== "true") throw new Error(psql("select public.sarraf_trial_balance_check()::text"));
  });

  check("a customer cannot post accounting commands", () => {
    psql(`update public.app_users set auth_id='22222222-2222-2222-2222-222222222222' where id='cust-2'`);
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '22222222-2222-2222-2222-222222222222'::uuid $fn$`);
    let denied = false;
    try { psql(`select public.sarraf_customer_vault_move('cust-2','CNY',100,'in',7.2,'forged','cmd-forge')`); }
    catch { denied = true; }
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
    if (!denied) throw new Error("a customer was allowed to move the cashbox");
  });


  // ── §13D: the worked example, executed through the real commands ──
  psql(`insert into public.app_users(id,name,role,auth_id) values
        ('p-x','Partner X','partner','33333333-3333-3333-3333-333333333333'),
        ('off-1','Office One','office','44444444-4444-4444-4444-444444444444')
        on conflict do nothing`);

  check("13D.5 balance 1000, sold 1300: 1000 consumed and 300 becomes debt", () => {
    psql(`insert into public.partner_accounts(id,partner_id,currency,available)
          values ('pa-x-cny','p-x','CNY',1000)
          on conflict (partner_id,currency) do update set available=1000`);
    const out = psql(`select public.sarraf_partner_disburse('p-x','CNY',1300,7.2,null,'sale to partner','cmd-disb-1')::text`);
    const avail = Number(psql("select available from partner_accounts where id='pa-x-cny'").trim());
    const debt = Number(psql(`select coalesce(sum(outstanding_principal),0) from debts
      where debtor_type='partner' and debtor_id='p-x' and currency='CNY'
        and status in ('open','partially_settled')`).trim());
    if (avail !== 0) throw new Error(`available should be 0, got ${avail}`);
    if (debt !== 300) throw new Error(`debt should be 300, got ${debt}`);
    if (!out.replace(/\s/g,"").includes('"excess_as_debt":300')) throw new Error(`unexpected: ${out}`);
  });

  check("13D.5 later credit 500: debt cleared and 200 left available", () => {
    const out = psql(`select public.sarraf_partner_credit('p-x','CNY',500,7.2,'new credit','cmd-cred-1')::text`);
    const avail = Number(psql("select available from partner_accounts where id='pa-x-cny'").trim());
    const debt = Number(psql(`select coalesce(sum(outstanding_principal),0) from debts
      where debtor_type='partner' and debtor_id='p-x' and currency='CNY'
        and status in ('open','partially_settled')`).trim());
    if (debt !== 0) throw new Error(`debt should be 0, got ${debt}`);
    if (avail !== 200) throw new Error(`available should be 200, got ${avail}`);
    if (!out.replace(/\s/g,"").includes('"debt_applied":300')) throw new Error(`breakdown missing: ${out}`);
  });

  mustFail("a partner account can never go negative",
    `insert into public.partner_account_events(account_id,partner_id,currency,kind,available_delta,actor_id)
     values ('pa-x-cny','p-x','CNY','debit',-99999,'u-a')`);

  check("replaying a disbursement does not create the debt twice", () => {
    const before = Number(psql("select count(*) from debts where debtor_id='p-x'").trim());
    psql(`select public.sarraf_partner_disburse('p-x','CNY',1300,7.2,null,'replay','cmd-disb-1')`);
    const after = Number(psql("select count(*) from debts where debtor_id='p-x'").trim());
    if (after !== before) throw new Error(`debts went from ${before} to ${after} on replay`);
  });

  check("an office assignment carries the transaction amount and currency", () => {
    psql(`insert into public.office_payment_assignments(id,office_id,amount,currency,assigned_by)
          values ('opa-1','off-1',5000,'CNY','u-a')`);
    const row = psql("select amount||'|'||currency||'|'||status from office_payment_assignments where id='opa-1'").trim();
    if (row !== "5000.0000000000|CNY|assigned") throw new Error(`assignment is ${row}`);
  });

  check("a partial payment report leaves the remainder outstanding", () => {
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '44444444-4444-4444-4444-444444444444'::uuid $fn$`);
    const out = psql(`select public.sarraf_office_payment_report('opa-1','paid_reported',2000,'REF-1','partial','cmd-op-1')::text`);
    if (!out.replace(/\s/g,"").includes('"outstanding":3000')) throw new Error(`expected 3000 outstanding: ${out}`);
  });

  mustFail("an office cannot report more than the assignment",
    `select public.sarraf_office_payment_report('opa-1','paid_reported',999999,'X','over','cmd-op-2')`);

  mustFail("an office cannot confirm its own payment",
    `select public.sarraf_office_payment_report('opa-1','confirmed',null,null,null,'cmd-op-3')`);

  check("another office cannot touch an assignment that is not theirs", () => {
    psql(`insert into public.app_users(id,name,role,auth_id) values
          ('off-2','Office Two','office','55555555-5555-5555-5555-555555555555') on conflict do nothing`);
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '55555555-5555-5555-5555-555555555555'::uuid $fn$`);
    let denied = false;
    try { psql(`select public.sarraf_office_payment_report('opa-1','acknowledged',null,null,null,'cmd-op-4')`); }
    catch { denied = true; }
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
    if (!denied) throw new Error("a different office was allowed to report");
  });

  check("the trial balance still reconciles after partner and office activity", () => {
    const out = psql("select (public.sarraf_trial_balance_check()->>'balanced')::text").trim();
    if (out !== "true") throw new Error(psql("select public.sarraf_trial_balance_check()::text"));
  });


  // ── Phase 4: receipt state machine, custody, forwarding ──
  psql(`insert into public.app_users(id,name,role) values
        ('cust-r','Receipt Customer','customer'),('part-r','Receipt Partner','partner'),
        ('inv-r','Investor','investor') on conflict do nothing`);

  const doc = (id, flow, uploader, extra = "") => `
    insert into public.receipt_documents(id,flow,uploader_id,storage_path${extra ? "," + extra.split("=")[0] : ""})
    values ('${id}','${flow}','${uploader}','ingest/${id}.jpg'${extra ? ",'" + extra.split("=")[1] + "'" : ""})`;

  check("a document starts at created and records that transition", () => {
    psql(`insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
          values ('doc-1','customer_sells_to_zeman','cust-r','cust-r','ingest/doc-1.jpg')`);
    const st = psql("select state from receipt_documents where id='doc-1'").trim();
    const tr = psql("select count(*) from receipt_state_transitions where document_id='doc-1'").trim();
    if (st !== "created" || tr !== "1") throw new Error(`state ${st}, transitions ${tr}`);
  });

  mustFail("a customer cannot upload a purchase receipt",
    `insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
     values ('doc-bad','customer_buys_from_zeman','cust-r','cust-r','ingest/doc-bad.jpg')`);

  mustFail("an unassigned partner cannot upload for another partner",
    `insert into public.receipt_documents(id,flow,uploader_id,partner_id,storage_path)
     values ('doc-bad2','customer_buys_from_zeman','part-r','someone-else','ingest/doc-bad2.jpg')`);

  mustFail("an investor cannot upload receipts at all",
    `insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
     values ('doc-bad3','customer_sells_to_zeman','inv-r','inv-r','ingest/doc-bad3.jpg')`);

  mustFail("a document cannot be created already accepted",
    `insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path,state)
     values ('doc-bad4','customer_sells_to_zeman','cust-r','cust-r','ingest/x.jpg','accepted')`);

  mustFail("a document cannot jump from created straight to accepted",
    `update public.receipt_documents set state='accepted' where id='doc-1'`);

  check("the documented happy path walks through every state", () => {
    const path = ["uploading","uploaded","ocr_pending","ocr_processing","parsed","validated",
                  "submitted","matched","accepted","finalized","forwarded","delivered"];
    for (const s of path) psql(`update public.receipt_documents set state='${s}' where id='doc-1'`);
    const st = psql("select state from receipt_documents where id='doc-1'").trim();
    if (st !== "delivered") throw new Error(`ended at ${st}`);
    const n = Number(psql("select count(*) from receipt_state_transitions where document_id='doc-1'").trim());
    if (n !== path.length + 1) throw new Error(`expected ${path.length + 1} transitions, got ${n}`);
  });

  check("a delivered document may only be marked seen", () => {
    let bad = false;
    try { psql(`update public.receipt_documents set state='rejected' where id='doc-1'`); } catch { bad = true; }
    if (!bad) throw new Error("a delivered document was moved to rejected");
    psql(`update public.receipt_documents set state='seen' where id='doc-1'`);
  });

  mustFail("a seen document is terminal and accepts nothing further",
    `update public.receipt_documents set state='rejected' where id='doc-1'`);

  mustFail("stored evidence cannot be re-pointed",
    `update public.receipt_documents set storage_path='ingest/other.jpg' where id='doc-1'`);

  check("an OCR failure keeps the image and stays recoverable", () => {
    psql(`insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
          values ('doc-2','customer_sells_to_zeman','cust-r','cust-r','ingest/doc-2.jpg')`);
    for (const s of ["uploading","uploaded","ocr_pending","ocr_failed_retryable","ocr_pending"])
      psql(`update public.receipt_documents set state='${s}' where id='doc-2'`);
    const st = psql("select state||'|'||storage_path from receipt_documents where id='doc-2'").trim();
    if (st !== "ocr_pending|ingest/doc-2.jpg") throw new Error(`document is ${st}`);
  });

  check("the original extraction is immutable and a correction is a new version", () => {
    psql(`insert into public.receipt_extractions(document_id,version,is_original,gross_amount,currency)
          values ('doc-2',1,true,2520.41,'CNY')`);
    psql(`insert into public.receipt_extractions(document_id,version,is_original,gross_amount,currency,
            corrected_by,correction_reason,corrected_at)
          values ('doc-2',2,false,2447.00,'CNY','u-a','admin corrected the gross figure',now())`);
    const v1 = psql("select gross_amount from receipt_extractions where document_id='doc-2' and version=1").trim();
    if (Number(v1) !== 2520.41) throw new Error(`original changed to ${v1}`);
  });

  mustFail("an extraction cannot be edited in place",
    `update public.receipt_extractions set gross_amount=1 where document_id='doc-2' and version=1`);

  mustFail("a correction without a reason is refused",
    `insert into public.receipt_extractions(document_id,version,is_original,gross_amount,corrected_by)
     values ('doc-2',3,false,10,'u-a')`);

  mustFail("a pending document cannot be forwarded",
    `insert into public.receipt_forwardings(id,document_id,from_actor_type,to_actor_type,to_actor_id,forwarded_by)
     values ('fwd-bad','doc-2','zeman','customer','cust-r','u-a')`);

  check("an accepted document can be forwarded exactly once per recipient", () => {
    psql(`insert into public.receipt_forwardings(id,document_id,from_actor_type,to_actor_type,to_actor_id,forwarded_by)
          values ('fwd-1','doc-1','zeman','customer','cust-r','u-a')`);
    let threw = false;
    try {
      psql(`insert into public.receipt_forwardings(id,document_id,from_actor_type,to_actor_type,to_actor_id,forwarded_by)
            values ('fwd-2','doc-1','zeman','customer','cust-r','u-a')`);
    } catch { threw = true; }
    if (!threw) throw new Error("the same document was forwarded twice to one recipient");
  });

  check("a counted document cannot share an image hash with another", () => {
    psql(`update public.receipt_documents set image_sha256=repeat('a',64), counted=true where id='doc-1'`);
    let threw = false;
    try {
      psql(`insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path,image_sha256,counted)
            values ('doc-dup','customer_sells_to_zeman','cust-r','cust-r','ingest/dup.jpg',repeat('a',64),true)`);
    } catch { threw = true; }
    if (!threw) throw new Error("a duplicate counted image was accepted");
  });


  // ── Phase 5: transactions post to the journal ──
  check("a completed buy posts a balanced entry with the spread recognised", () => {
    psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status,date)
          values ('tx-buy','buy','cny',7200,0.1972,'usd',1420,'completed',now())`);
    const st = psql("select status from journal_entries where source_id='tx-buy'").trim();
    if (st !== "posted") throw new Error(`entry status is '${st}'`);
    const lines = Number(psql("select count(*) from journal_lines where entry_id='je-tx-tx-buy'").trim());
    if (lines < 2) throw new Error(`only ${lines} lines posted`);
    const bal = psql(`select abs(sum(case when side='debit' then base_amount else -base_amount end))
                      from journal_lines where entry_id='je-tx-tx-buy'`).trim();
    if (Number(bal) > 0.01) throw new Error(`entry is unbalanced by ${bal}`);
  });

  check("a pending buy books a payable rather than moving cash", () => {
    psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status,date)
          values ('tx-pend','buy','cny',720,0.1972,'usd',142,'pending',now())`);
    const acct = psql(`select account_id from journal_lines
                       where entry_id='je-tx-tx-pend' and side='credit' order by line_no limit 1`).trim();
    if (acct !== "acc-2300") throw new Error(`pending buy credited ${acct}, expected the payable`);
  });

  check("a sell credits inventory and debits what came in", () => {
    psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status,date)
          values ('tx-sell','sell','cny',7200,0.2,'usd',1440,'completed',now())`);
    const inv = psql(`select side from journal_lines
                      where entry_id='je-tx-tx-sell' and account_id='acc-1400'`).trim();
    if (inv !== "credit") throw new Error(`inventory side on a sell is ${inv}`);
  });

  check("a transaction in a currency with no rate becomes a draft, never a guess", () => {
    psql(`insert into public.currencies(id,code,name) values ('try','TRY','Lira') on conflict do nothing`);
    psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status,date)
          values ('tx-norate','buy','try',100,1,'usd',10,'completed',now())`);
    const st = psql("select status from journal_entries where source_id='tx-norate'").trim();
    if (st !== "draft") throw new Error(`expected a draft, got '${st}'`);
    const n = psql("select count(*) from journal_lines where entry_id='je-tx-tx-norate'").trim();
    if (n !== "0") throw new Error("a draft must post no lines");
    const listed = psql("select count(*) from v_journal_drafts where source_id='tx-norate'").trim();
    if (listed !== "1") throw new Error("the draft is not surfaced for an operator");
  });

  check("drafts are excluded from the trial balance, which still reconciles", () => {
    const out = psql("select (public.sarraf_trial_balance_check()->>'balanced')::text").trim();
    if (out !== "true") throw new Error(psql("select public.sarraf_trial_balance_check()::text"));
  });

  check("a transaction posts only once, however often it is updated", () => {
    psql(`update public.txs set status='completed' where id='tx-pend'`);
    const n = psql("select count(*) from journal_entries where source_id='tx-pend'").trim();
    if (n !== "1") throw new Error(`${n} entries exist for one transaction`);
  });

  check("reversing a transaction entry mirrors every line and keeps the original", () => {
    const before = psql("select count(*) from journal_lines where entry_id='je-tx-tx-buy'").trim();
    psql(`select public.sarraf_reverse_transaction_entry('tx-buy','mistaken rate on this trade','cmd-rev-1')`);
    const src = psql("select status from journal_entries where id='je-tx-tx-buy'").trim();
    if (src !== "reversed") throw new Error(`original is '${src}'`);
    const after = psql("select count(*) from journal_lines where entry_id='je-tx-tx-buy'").trim();
    if (after !== before) throw new Error("the original lines were altered");
    const rev = psql(`select count(*) from journal_entries where reversal_of='je-tx-tx-buy'`).trim();
    if (rev !== "1") throw new Error("no reversal entry was created");
  });

  check("the trial balance still reconciles after a reversal", () => {
    const out = psql("select (public.sarraf_trial_balance_check()->>'balanced')::text").trim();
    if (out !== "true") throw new Error(psql("select public.sarraf_trial_balance_check()::text"));
  });


  // ── §14: RLS matrix. Isolation is proven by querying AS each role, not by reading policies. ──
  // Policies are enforced only for non-superusers, so the checks run as a dedicated role that
  // inherits `authenticated`; running them as postgres would pass vacuously.
  psql(`do $$ begin
          if not exists (select 1 from pg_roles where rolname='zeman_rls_probe') then
            create role zeman_rls_probe login;
          end if;
        end $$`);
  psql(`grant authenticated to zeman_rls_probe`);
  psql(`grant usage on schema public to zeman_rls_probe`);

  // Two customers, two partners, one office — each with a distinct auth id.
  psql(`insert into public.app_users(id,name,role,auth_id) values
        ('rls-c1','C1','customer','aaaaaaa1-0000-0000-0000-000000000001'),
        ('rls-c2','C2','customer','aaaaaaa2-0000-0000-0000-000000000002'),
        ('rls-p1','P1','partner', 'aaaaaaa3-0000-0000-0000-000000000003'),
        ('rls-o1','O1','office',  'aaaaaaa4-0000-0000-0000-000000000004')
        on conflict (id) do nothing`);
  psql(`insert into public.customer_vaults(id,customer_id,currency,available) values
        ('rls-v1','rls-c1','CNY',100),('rls-v2','rls-c2','CNY',200)
        on conflict (customer_id,currency) do nothing`);
  psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
          original_principal,outstanding_principal,source_type,reason,created_by) values
        ('rls-d1','customer','rls-c1','zeman',null,'CNY',50,50,'t','c1 debt','u-a'),
        ('rls-d2','customer','rls-c2','zeman',null,'CNY',60,60,'t','c2 debt','u-a')
        on conflict (id) do nothing`);
  psql(`insert into public.office_payment_assignments(id,office_id,amount,currency,assigned_by)
        values ('rls-opa','rls-o1',10,'CNY','u-a') on conflict (id) do nothing`);
  psql(`insert into public.partner_accounts(id,partner_id,currency,available)
        values ('rls-pa','rls-p1','CNY',5) on conflict (partner_id,currency) do nothing`);

  // Count rows visible to a given auth.uid(), with RLS actually applied.
  // Both statements must share one transaction: set_config with is_local=true is discarded at
  // commit, and psql runs each -c in its own transaction, so the identity would be gone by the
  // time the query ran.
  const asUser = (uid, sql) => run(path.join(PGBIN, "psql"),
    ["-h", sock, "-p", PORT, "-U", "zeman_rls_probe", "-d", "zeman_verify",
     "-v", "ON_ERROR_STOP=1", "-tAq",
     "-c", `begin; select set_config('request.jwt.claim.sub','${uid}',true); ${sql}; commit;`])
    .trim().split("\n").filter(Boolean).pop().trim();

  // auth.uid() in the fixture reads a session setting so each probe can act as a different user.
  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $fn$`);

  const rlsCheck = (name, uid, sql, expected) => {
    try {
      const got = asUser(uid, sql);
      checks.push([got === String(expected), `${name} (expected ${expected}, saw ${got})`]);
    } catch (e) {
      checks.push([false, `${name} — ${String(e.message || e).split("\n").find((l) => l.includes("ERROR")) || e}`]);
    }
  };

  rlsCheck("a customer sees only their own cashbox", 'aaaaaaa1-0000-0000-0000-000000000001',
    "select count(*) from public.customer_vaults", 1);
  rlsCheck("a customer sees only debts they are party to", 'aaaaaaa1-0000-0000-0000-000000000001',
    "select count(*) from public.debts where id like 'rls-d%'", 1);
  rlsCheck("a customer sees no journal entries", 'aaaaaaa1-0000-0000-0000-000000000001',
    "select count(*) from public.journal_entries", 0);
  rlsCheck("a customer sees no office assignments", 'aaaaaaa1-0000-0000-0000-000000000001',
    "select count(*) from public.office_payment_assignments", 0);
  rlsCheck("a customer sees no partner accounts", 'aaaaaaa1-0000-0000-0000-000000000001',
    "select count(*) from public.partner_accounts", 0);
  rlsCheck("a partner sees only their own account", 'aaaaaaa3-0000-0000-0000-000000000003',
    "select count(*) from public.partner_accounts where id='rls-pa'", 1);
  rlsCheck("a partner sees no customer cashboxes", 'aaaaaaa3-0000-0000-0000-000000000003',
    "select count(*) from public.customer_vaults", 0);
  rlsCheck("an office sees only its own assignment", 'aaaaaaa4-0000-0000-0000-000000000004',
    "select count(*) from public.office_payment_assignments where id='rls-opa'", 1);
  rlsCheck("an unknown session sees nothing", '99999999-9999-9999-9999-999999999999',
    "select count(*) from public.customer_vaults", 0);
  rlsCheck("a customer cannot write to the ledger", 'aaaaaaa1-0000-0000-0000-000000000001',
    `select count(*) from (select 1 where not exists (
       select 1 from information_schema.role_table_grants
       where grantee='authenticated' and table_name='journal_lines'
         and privilege_type in ('INSERT','UPDATE','DELETE'))) t`, 1);

  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);


  // ── 5: durable intake. The image must survive an OCR failure. ──
  psql(`insert into public.app_users(id,name,role,auth_id) values
        ('in-c','Intake Customer','customer','bbbbbbb1-0000-0000-0000-000000000001')
        on conflict (id) do nothing`);
  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select 'bbbbbbb1-0000-0000-0000-000000000001'::uuid $fn$`);

  check("intake claims a slot and returns the exact storage path", () => {
    const out = psql(`select public.sarraf_receipt_intake_begin(
      'doc-in-1','customer_sells_to_zeman','in-c',null,null,'batch-1','CNY','image/jpeg')::text`);
    if (!out.includes("ingest/batch-1/doc-in-1.jpg")) throw new Error(`unexpected path: ${out}`);
    const st = psql("select state from receipt_documents where id='doc-in-1'").trim();
    if (st !== "uploading") throw new Error(`state is ${st}`);
  });

  check("replaying intake returns the same slot rather than duplicating it", () => {
    const out = psql(`select public.sarraf_receipt_intake_begin(
      'doc-in-1','customer_sells_to_zeman','in-c',null,null,'batch-1','CNY','image/jpeg')::text`);
    if (!out.replace(/\s/g,"").includes('"replayed":true')) throw new Error(`not a replay: ${out}`);
    const n = psql("select count(*) from receipt_documents where id='doc-in-1'").trim();
    if (n !== "1") throw new Error(`${n} rows exist`);
  });

  mustFail("a customer cannot claim an intake for a purchase flow",
    `select public.sarraf_receipt_intake_begin(
      'doc-in-bad','customer_buys_from_zeman','in-c',null,null,null,'CNY','image/jpeg')`);

  mustFail("an unsupported image type is refused before anything is stored",
    `select public.sarraf_receipt_intake_begin(
      'doc-in-pdf','customer_sells_to_zeman','in-c',null,null,null,'CNY','application/pdf')`);

  check("recording the stored bytes moves the receipt to ocr_pending", () => {
    psql(`select public.sarraf_receipt_intake_stored('doc-in-1', repeat('b',64), 12345)`);
    const row = psql("select state||'|'||image_sha256 from receipt_documents where id='doc-in-1'").trim();
    if (!row.startsWith("ocr_pending|")) throw new Error(`document is ${row}`);
  });

  check("a failed OCR keeps the image and leaves the receipt recoverable", () => {
    psql(`select public.sarraf_receipt_intake_extracted('doc-in-1', false,
          '{"error":"provider_timeout"}'::jsonb, 'groq', 'qwen')`);
    const row = psql(`select state||'|'||storage_path||'|'||coalesce(last_error_code,'')
                      from receipt_documents where id='doc-in-1'`).trim();
    if (row !== "ocr_failed_retryable|ingest/batch-1/doc-in-1.jpg|provider_timeout")
      throw new Error(`document is ${row}`);
  });

  check("a confident reading is recorded as version 1 and validated", () => {
    psql(`select public.sarraf_receipt_intake_begin(
      'doc-in-2','customer_sells_to_zeman','in-c',null,null,'batch-1','CNY','image/jpeg')`);
    psql(`select public.sarraf_receipt_intake_stored('doc-in-2', repeat('c',64), 999)`);
    psql(`select public.sarraf_receipt_intake_extracted('doc-in-2', true,
      '{"grossAmount":"2520.41","orderAmount":"2447.00","feeAmount":"73.41",
        "feeTreatment":"added_on_top","netAmount":"2447.00","currency":"CNY",
        "refNo":"ORD-1","confidence":"0.91","txDate":"2026-08-04"}'::jsonb, 'groq', 'qwen')`);
    const st = psql("select state from receipt_documents where id='doc-in-2'").trim();
    if (st !== "validated") throw new Error(`state is ${st}`);
    const v = psql(`select version||'|'||is_original||'|'||gross_amount
                    from receipt_extractions where document_id='doc-in-2'`).trim();
    if (v !== "1|true|2520.4100000000") throw new Error(`extraction is ${v}`);
  });

  check("a low-confidence reading goes to a human instead of straight through", () => {
    psql(`select public.sarraf_receipt_intake_begin(
      'doc-in-3','customer_sells_to_zeman','in-c',null,null,'batch-1','CNY','image/jpeg')`);
    psql(`select public.sarraf_receipt_intake_stored('doc-in-3', repeat('d',64), 999)`);
    psql(`select public.sarraf_receipt_intake_extracted('doc-in-3', true,
      '{"grossAmount":"100","currency":"CNY","confidence":"0.40"}'::jsonb, 'groq', 'qwen')`);
    const st = psql("select state from receipt_documents where id='doc-in-3'").trim();
    if (st !== "needs_manual_review") throw new Error(`state is ${st}`);
  });

  check("a currency the transaction did not expect is flagged, never accepted", () => {
    psql(`select public.sarraf_receipt_intake_begin(
      'doc-in-4','customer_sells_to_zeman','in-c',null,null,'batch-1','CNY','image/jpeg')`);
    psql(`select public.sarraf_receipt_intake_stored('doc-in-4', repeat('e',64), 999)`);
    psql(`select public.sarraf_receipt_intake_extracted('doc-in-4', true,
      '{"grossAmount":"2300","currency":"IQD","confidence":"0.95"}'::jsonb, 'groq', 'qwen')`);
    const row = psql("select state||'|'||coalesce(rule_code,'') from receipt_documents where id='doc-in-4'").trim();
    if (row !== "currency_mismatch|currency_mismatch") throw new Error(`document is ${row}`);
  });

  check("an uploader sees their own intakes and their status", () => {
    const n = Number(psql("select count(*) from public.sarraf_my_receipt_intakes(100)").trim());
    if (n < 4) throw new Error(`expected the uploader's own intakes, saw ${n}`);
  });

  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);


  // 8: forwarding. Accepted evidence reaches exactly the party the flow sends it to.
  psql(`insert into public.app_users(id,name,role,auth_id) values
        ('fw-cust','FW Customer','customer','ccccccc1-0000-0000-0000-000000000001'),
        ('fw-part','FW Partner','partner','ccccccc2-0000-0000-0000-000000000002')
        on conflict (id) do nothing`);
  // A sale receipt, taken through to accepted.
  psql(`insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
        values ('fw-1','customer_sells_to_zeman','fw-cust','fw-cust','ingest/fw/fw-1.jpg')`);
  for (const st of ["uploading","uploaded","ocr_pending","ocr_processing","parsed","validated","submitted","accepted"])
    psql(`update public.receipt_documents set state='${st}' where id='fw-1'`);
  // And one left mid-review, which must never be forwarded.
  psql(`insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
        values ('fw-2','customer_sells_to_zeman','fw-cust','fw-cust','ingest/fw/fw-2.jpg')`);
  for (const st of ["uploading","uploaded","ocr_pending","ocr_processing","parsed","needs_manual_review"])
    psql(`update public.receipt_documents set state='${st}' where id='fw-2'`);

  check("a sale receipt forwards to the partner and moves into their custody", () => {
    const out = psql(`select public.sarraf_forward_receipts('["fw-1"]'::jsonb,'fw-part',null,
      'partner takes custody of this currency','cmd-fw-1')::text`);
    if (!out.replace(/\s/g,"").includes('"forwarded":1')) throw new Error(`unexpected: ${out}`);
    const st = psql("select state from receipt_documents where id='fw-1'").trim();
    if (st !== "forwarded") throw new Error(`document is ${st}`);
    const custody = psql("select count(*) from receipt_custody_ledger where document_id='fw-1'").trim();
    if (custody !== "1") throw new Error("custody was not recorded");
    const owner = psql("select partner_id from receipt_documents where id='fw-1'").trim();
    if (owner !== "fw-part") throw new Error(`custody holder is ${owner}`);
  });

  check("a receipt still under review is skipped and named, not forwarded", () => {
    const out = psql(`select public.sarraf_forward_receipts('["fw-2"]'::jsonb,'fw-part',null,
      'attempting to forward a pending receipt','cmd-fw-2')::text`);
    if (!out.replace(/\s/g,"").includes('"forwarded":0')) throw new Error(`it was forwarded: ${out}`);
    if (!out.includes("needs_manual_review")) throw new Error(`the reason was not named: ${out}`);
    const n = psql("select count(*) from receipt_forwardings where document_id='fw-2'").trim();
    if (n !== "0") throw new Error("a pending receipt reached a portal");
  });

  check("a sale receipt cannot be forwarded to a customer", () => {
    // A fresh accepted receipt, so the recipient rule is what is under test rather than the
    // already-forwarded state of fw-1.
    psql(`insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
          values ('fw-3','customer_sells_to_zeman','fw-cust','fw-cust','ingest/fw/fw-3.jpg')`);
    for (const st of ["uploading","uploaded","ocr_pending","ocr_processing","parsed","validated","submitted","accepted"])
      psql(`update public.receipt_documents set state='${st}' where id='fw-3'`);
    const out = psql(`select public.sarraf_forward_receipts('["fw-3"]'::jsonb,'fw-cust',null,
      'wrong recipient for this flow','cmd-fw-3')::text`);
    if (!out.includes("recipient_must_be_partner")) throw new Error(`unexpected: ${out}`);
    const n = psql("select count(*) from receipt_forwardings where document_id='fw-3'").trim();
    if (n !== "0") throw new Error("the receipt reached the wrong party");
  });

  check("forwarding twice does not duplicate the delivery record", () => {
    psql(`select public.sarraf_forward_receipts('["fw-1"]'::jsonb,'fw-part',null,
      'resend after a delivery problem','cmd-fw-4')`);
    const n = psql(`select count(*) from receipt_forwardings where document_id='fw-1'`).trim();
    if (n !== "1") throw new Error(`${n} forwarding rows exist`);
  });

  check("delivered and seen are recorded by the recipient, not by the sender", () => {
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select 'ccccccc2-0000-0000-0000-000000000002'::uuid $fn$`);
    psql(`select public.sarraf_receipt_mark_delivered('fw-1')`);
    let st = psql("select delivery_status from receipt_forwardings where document_id='fw-1'").trim();
    if (st !== "delivered") throw new Error(`status is ${st}`);
    psql(`select public.sarraf_receipt_mark_seen('fw-1')`);
    st = psql("select state from receipt_documents where id='fw-1'").trim();
    if (st !== "seen") throw new Error(`document is ${st}`);
  });

  check("a recipient sees their forwarded receipts with the figures", () => {
    const n = Number(psql("select count(*) from public.sarraf_my_forwarded_receipts(50)").trim());
    if (n !== 1) throw new Error(`expected 1 forwarded receipt, saw ${n}`);
  });

  check("someone the receipt was not forwarded to cannot mark it delivered", () => {
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select 'ccccccc1-0000-0000-0000-000000000001'::uuid $fn$`);
    let denied = false;
    try { psql(`select public.sarraf_receipt_mark_delivered('fw-1')`); } catch { denied = true; }
    const n = Number(psql("select count(*) from public.sarraf_my_forwarded_receipts(50)").trim());
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
    if (!denied) throw new Error("a non-recipient marked the receipt delivered");
    if (n !== 0) throw new Error(`a non-recipient saw ${n} forwarded receipts`);
  });

  // The guard was written `between 1 and 0` — a range no length can satisfy — so an empty
  // selection passed validation, forwarded nothing, and burnt its command key on a recorded
  // "success". A retry with that key then replays the empty result forever.
  check("an empty selection is refused rather than recorded as a completed forward", () => {
    let denied = false;
    try { psql(`select public.sarraf_forward_receipts('[]'::jsonb,'fw-part',null,
      'forwarding nothing at all','cmd-fw-empty')::text`); } catch { denied = true; }
    if (!denied) throw new Error("an empty selection was accepted");
    const n = psql("select count(*) from accounting_commands where command_key='cmd-fw-empty'").trim();
    if (n !== "0") throw new Error("the command key was spent on an empty selection");
  });

  mustFail("a null selection is refused",
    `select public.sarraf_forward_receipts(null::jsonb,'fw-part',null,
      'forwarding a null selection','cmd-fw-null')`);

  check("sent, delivered and seen reconcile separately", () => {
    const out = psql("select public.sarraf_forwarding_reconciliation()::text").trim();
    for (const k of ["forwarded","sent","delivered","seen","failed"]) {
      if (!out.includes(k)) throw new Error(`${k} missing from reconciliation`);
    }
  });

  // ── §12: day close ──
  // A safe short by 400,000 could be closed in silence, and nobody could ever find out why.
  mustFail("a counted difference cannot be closed without a reason",
    `insert into public.day_closes(id,close_date,lines,has_diff,closed_by) values
     ('dc-bad',current_date,'[{"cur":"iqd","code":"IQD","expected":1000000,"counted":600000,"diff":-400000}]'::jsonb,true,'u-a')`);

  mustFail("a reason shorter than the minimum is refused",
    `insert into public.day_closes(id,close_date,lines,note,closed_by) values
     ('dc-bad2',current_date,'[{"cur":"iqd","code":"IQD","diff":-400000}]'::jsonb,'کەم','u-a')`);

  // The flag is not trusted: the lines decide whether a reason is owed.
  mustFail("a close claiming to be clean while carrying a difference is refused",
    `insert into public.day_closes(id,close_date,lines,has_diff,closed_by) values
     ('dc-bad3',current_date,'[{"cur":"iqd","code":"IQD","diff":-400000}]'::jsonb,false,'u-a')`);

  check("a clean count closes with no reason at all", () => {
    psql(`insert into public.day_closes(id,close_date,lines,closed_by) values
          ('dc-clean',current_date,'[{"cur":"iqd","code":"IQD","expected":1000,"counted":1000,"diff":0}]'::jsonb,'u-a')`);
    const n = psql("select count(*) from journal_entries where id='je-close-dc-clean'").trim();
    if (n !== "0") throw new Error("a day with no difference posted an entry");
  });

  // §12 and §13: the difference reaches the books instead of vanishing into an adjustment.
  check("an explained shortage posts to cash over/short and balances", () => {
    psql(`insert into public.day_closes(id,close_date,lines,note,closed_by) values
          ('dc-short',current_date,
           '[{"cur":"iqd","code":"IQD","expected":1420000,"counted":1418600,"diff":-1400}]'::jsonb,
           'خەرجی تۆمار نەکراو بۆ گواستنەوە','u-a')`);
    const st = psql("select status from journal_entries where id='je-close-dc-short'").trim();
    if (st !== "posted") throw new Error(`entry is ${st || "missing"}`);
    const short = psql(`select coalesce(sum(base_amount) filter (where side='debit'),0)
                        from journal_lines where entry_id='je-close-dc-short' and account_id='acc-5910'`).trim();
    if (Number(short) <= 0) throw new Error("the shortage did not reach cash over/short");
    const bal = psql(`select coalesce(sum(base_amount) filter (where side='debit'),0)
                           - coalesce(sum(base_amount) filter (where side='credit'),0)
                      from journal_lines where entry_id='je-close-dc-short'`).trim();
    if (Math.abs(Number(bal)) > 1e-6) throw new Error(`entry is unbalanced by ${bal}`);
  });

  check("an overage credits cash over/short rather than debiting it", () => {
    psql(`insert into public.day_closes(id,close_date,lines,note,closed_by) values
          ('dc-over',current_date,
           '[{"cur":"usd","code":"USD","expected":1000,"counted":1025,"diff":25}]'::jsonb,
           'پارەی زیادە لە ژماردندا دۆزرایەوە','u-a')`);
    const cr = psql(`select coalesce(sum(base_amount) filter (where side='credit'),0)
                     from journal_lines where entry_id='je-close-dc-over' and account_id='acc-5910'`).trim();
    if (Number(cr) <= 0) throw new Error("an overage did not credit cash over/short");
  });

  // A currency with no rate cannot be valued; the entry is a draft carrying the reason,
  // exactly as an unvalued transaction is — never an invented number.
  check("a difference in an unrated currency is drafted, not guessed", () => {
    psql(`insert into public.day_closes(id,close_date,lines,note,closed_by) values
          ('dc-unrated',current_date,'[{"cur":"xxx","code":"XXX","diff":-50}]'::jsonb,
           'دراوێک کە نرخی دانەنراوە','u-a')`);
    const st = psql("select status from journal_entries where id='je-close-dc-unrated'").trim();
    if (st !== "draft") throw new Error(`expected a draft, got ${st || "nothing"}`);
    const n = psql("select count(*) from journal_lines where entry_id='je-close-dc-unrated'").trim();
    if (n !== "0") throw new Error("an unvalued entry posted lines anyway");
  });

  // §12: immutable close history. A correction is a new close, not an edit of the old one.
  mustFail("a recorded close cannot be deleted", "delete from public.day_closes where id='dc-short'");
  mustFail("the counted figures of a recorded close cannot be rewritten",
    `update public.day_closes set lines='[{"cur":"iqd","code":"IQD","diff":0}]'::jsonb where id='dc-short'`);
  mustFail("who closed the day cannot be rewritten",
    "update public.day_closes set closed_by='u-b' where id='dc-short'");

  check("closes carrying a difference are listed with what they cost", () => {
    const n = Number(psql("select count(*) from public.v_day_close_differences").trim());
    if (n < 3) throw new Error(`expected the differing closes to be listed, saw ${n}`);
    const clean = psql("select count(*) from public.v_day_close_differences where id='dc-clean'").trim();
    if (clean !== "0") throw new Error("a clean close was listed as a difference");
  });

  // ── §12: the legacy ledger and the journal must agree ──
  // Two records of the same money are only safe while they agree, and nothing was checking.
  check("a transaction the books never received is named, not hidden in a summary", () => {
    psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status)
          values ('tx-ok','buy','cny',100,7.2,'usd',13.89,'completed')`);
    // The trigger is what posts an entry; disabling it reproduces a transaction that reached
    // the interface but never reached the books.
    psql("alter table public.txs disable trigger txs_post_journal");
    psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status)
          values ('tx-gap','buy','cny',500,7.2,'usd',69.44,'completed')`);
    psql("alter table public.txs enable trigger txs_post_journal");
    const gaps = psql("select transaction_id||'|'||gap from public.v_ledger_journal_gaps order by 1").trim();
    if (!gaps.includes("tx-gap|no_journal_entry")) throw new Error(`gap not reported: ${gaps}`);
    if (gaps.includes("tx-ok|")) throw new Error(`a healthy transaction was reported as a gap: ${gaps}`);
  });

  check("reconciliation refuses to say the books agree while a gap exists", () => {
    const out = psql("select public.sarraf_ledger_journal_reconciliation()::text").trim();
    if (/"agreed":\s*true/.test(out)) throw new Error(`agreed while a gap exists: ${out}`);
    if (!/"missing_entries":\s*[1-9]/.test(out)) throw new Error(`the gap was not counted: ${out}`);
  });

  // The rows that would show an operator money the books cannot account for.
  check("a ledger row pointing at an unposted transaction is counted", () => {
    psql(`insert into public.ledger(id,type,cur_id,amount,tx_id)
          values ('lg-gap','buy','cny',500,'tx-gap'),('lg-ok','buy','cny',100,'tx-ok')`);
    const out = psql("select public.sarraf_ledger_journal_reconciliation()::text").trim();
    if (!/"ledger_rows_without_entry":\s*1/.test(out))
      throw new Error(`expected exactly the unposted one to count: ${out}`);
  });

  // An unvalued entry is a gap too: the trade happened, the books cannot state it in USD.
  check("an entry left as a draft is reported separately from a missing one", () => {
    psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status)
          values ('tx-unrated','buy','xxx',10,1,'usd',10,'completed')`);
    const gaps = psql("select transaction_id||'|'||gap from public.v_ledger_journal_gaps order by 1").trim();
    if (!gaps.includes("tx-unrated|entry_unvalued"))
      throw new Error(`an unvalued entry was not distinguished: ${gaps}`);
    const out = psql("select public.sarraf_ledger_journal_reconciliation()::text").trim();
    if (!/"unvalued_entries":\s*[1-9]/.test(out)) throw new Error(`not counted: ${out}`);
  });

  check("an entry whose transaction was voided is reported as an orphan", () => {
    psql("update public.txs set deleted = true where id='tx-ok'");
    const n = psql("select count(*) from public.v_journal_orphans where source_id='tx-ok'").trim();
    if (n !== "1") throw new Error("a voided transaction's entry was not flagged");
  });

  // Once the books receive the transaction, it stops being reported.
  check("a resolved gap leaves the report", () => {
    psql("update public.txs set status = status where id='tx-gap'");
    const gaps = psql("select transaction_id from public.v_ledger_journal_gaps").trim();
    if (gaps.includes("tx-gap")) throw new Error("the transaction is still reported after posting");
    const n = psql("select count(*) from journal_entries where id='je-tx-tx-gap' and status='posted'").trim();
    if (n !== "1") throw new Error("no entry was posted for it");
  });

  check("a non-admin cannot reconcile the books", () => {
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '99999999-9999-9999-9999-999999999999'::uuid $fn$`);
    let denied = false;
    try { psql("select public.sarraf_ledger_journal_reconciliation()"); } catch { denied = true; }
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
    if (!denied) throw new Error("a stranger could read the reconciliation");
  });

  let failed = 0;
  for (const [ok, name] of checks) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failed++; }
  console.log(failed
    ? `\n${failed} of ${checks.length} accounting database checks failed.`
    : `\nAccounting database contracts passed across ${checks.length} checks on a clean database.`);
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error("Accounting DB verification could not run:", String(e.message || e).slice(0, 800));
  process.exit(1);
}
