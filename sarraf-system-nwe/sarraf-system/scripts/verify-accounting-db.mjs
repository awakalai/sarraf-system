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
    create table if not exists public.app_users (
      id text primary key, auth_id uuid, name text, role text, admin_level text,
      rate numeric, scope_curs text[], phone text, address text, note text,
      deleted boolean not null default false);
    create or replace function public.my_app_id() returns text language sql stable as $fn$
      select id from public.app_users where auth_id = auth.uid() and not deleted $fn$;
    create or replace function public.my_role() returns text language sql stable as $fn$
      select role from public.app_users where auth_id = auth.uid() and not deleted $fn$;
    create or replace function public.is_admin() returns boolean language sql stable as $fn$
      select coalesce((select role='admin' from public.app_users where auth_id=auth.uid() and not deleted), false) $fn$;
  `);
  psqlFile(prereq);

  // The migration under test must apply to an empty database.
  psqlFile(path.join(root, "supabase/migrations/202608120001_double_entry_core.sql"));
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
