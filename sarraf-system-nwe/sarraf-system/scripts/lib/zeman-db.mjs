// The database the verifiers run against.
//
// A real PostgreSQL, created from nothing on every run, with the Supabase surfaces the
// migrations build on and every migration applied in order. Two verifiers need exactly this —
// the accounting-invariant gate and the business-flow gate — and a second copy of it would be a
// second thing to keep in step with the migration list.
//
// Skips cleanly when no PostgreSQL is available, so it never produces a false green.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Every migration, in the order they must be applied. Both gates read this one list. */
export const MIGRATIONS = [
  "202608120001_double_entry_core.sql",
  "202608120002_cashbox_and_debt.sql",
  "202608120003_accounting_commands.sql",
  "202608120004_partner_and_office.sql",
  "202608120005_receipt_state_machine.sql",
  "202608120006_transaction_journal.sql",
  "202608120007_receipt_intake_commands.sql",
  "202608120008_receipt_forwarding.sql",
  "202608120009_forwarding_guard_fix.sql",
  "202608130001_day_close_integrity.sql",
  "202608130002_ledger_journal_reconciliation.sql",
  "202608140001_single_currency_ratio.sql",
  "202608140002_receipt_conversion_moves_money.sql",
  "202608150001_uploader_receipt_view.sql",
  "202608160001_canonical_batch_summary.sql",
  "202608170001_debt_register.sql",
  "202608180001_receipt_duplicate_keys.sql",
  "202608180002_ocr_attestation.sql",
  "202608180003_rate_limit_and_pending.sql",
  "202608190001_office_payment_confirmation.sql",
];

const PORT = process.env.ZEMAN_TEST_PGPORT || "55433";
const PGBIN = process.env.ZEMAN_PGBIN || "/usr/lib/postgresql/16/bin";
// PostgreSQL refuses to run as root. In a root container (CI images commonly are) the server
// is started through an unprivileged account instead of skipping the gate.
const AS_USER = process.getuid?.() === 0 ? (process.env.ZEMAN_PG_USER || "nobody") : null;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// A failed psql prints the reason on stderr and execFileSync puts the command line in the
// message, so without this a failure reads as a wall of quoting with the reason nowhere in it.
const run = (cmd, args, opts = {}) => {
  try {
    if (AS_USER) {
      const line = [cmd, ...args].map(shq).join(" ");
      return execFileSync("su", [AS_USER, "-s", "/bin/sh", "-c", line],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
    }
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  } catch (e) {
    const said = String(e.stderr || "").trim();
    if (said) e.message = said;
    throw e;
  }
};

const has = (bin) => existsSync(path.join(PGBIN, bin));
export const postgresAvailable = () => has("initdb") && has("pg_ctl");
export const PG_HINT = `no PostgreSQL at ${PGBIN}; set ZEMAN_PGBIN to run this gate.`;

const root = path.resolve(import.meta.dirname, "..", "..");
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

export function startDatabase() {
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
    create table if not exists public.rate_history (
      id text primary key, cur_id text references public.currencies(id),
      buy_rate numeric, sell_rate numeric, changed_by text,
      created_at timestamptz not null default now());
    create table if not exists public.audit (
      id text primary key, date timestamptz not null default now(), user_id text,
      action text, detail text);
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
    create table if not exists public.receipt_intake_items (
      id text primary key, batch_id text, intake_status text, counted boolean default true,
      currency text, net_amount numeric, partner_id text,
      transaction_id text, converted_at timestamptz);
    create table if not exists public.receipt_batches (
      id text primary key, tx_id text, status text, receipt_stage text,
      customer_id text, customer_name text, partner_id text, uploaded_by text,
      direction text, currency text,
      total_gross numeric, total_fee numeric, total_net numeric,
      n int, dup_n int, rejected_n int, source text,
      decision_status text, decision_by text, policy_version bigint, matched_score numeric,
      finalized_at timestamptz, finalized_by text, finalization_reason text,
      created_at timestamptz not null default now());
    -- The review-policy migration predates these and lives only in the production database;
    -- the fixture recreates the shape the finalization command reads and writes.
    create table if not exists public.receipt_control_policy (
      singleton boolean primary key default true check (singleton),
      min_match_score integer not null default 80,
      require_finalization boolean not null default true,
      require_separate_finalizer boolean not null default true,
      version bigint not null default 1);
    insert into public.receipt_control_policy(singleton) values(true) on conflict do nothing;
    create table if not exists public.receipt_review_commands (
      actor_id text not null, command_key text not null, batch_id text,
      decision text not null, result jsonb not null,
      created_at timestamptz not null default now(), primary key(actor_id, command_key));
    create table if not exists public.receipt_audit_events (
      id bigint generated always as identity primary key, event_type text not null,
      batch_id text not null, receipt_id text, actor_id text not null, command_key text not null,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now());
    create table if not exists public.receipts (
      id text primary key, batch_id text, customer_id text, customer_name text,
      partner_id text, uploaded_by text, direction text,
      amount numeric, fee numeric, net_amount numeric, currency text,
      sender text, receiver text, ref_no text, tx_time time, tx_date date,
      bank text, platform text, note text, status text, counted boolean default true,
      reject_code text, image_hash text, image_path text, raw jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now());
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
  for (const m of MIGRATIONS) {
    psqlFile(path.join(root, "supabase/migrations", m));
  }
  psql("insert into public.app_users(id,name,role) values ('u-a','A','admin') on conflict do nothing");

  // Run a statement as a different database role, with a JWT subject set, so row-level security
  // is actually applied rather than bypassed by the superuser the fixture is built with. Both
  // statements share one transaction: set_config with is_local = true is discarded at commit,
  // and psql runs each -c in a transaction of its own.
  const psqlAsRole = (role, uid, sql) => run(path.join(PGBIN, "psql"),
    ["-h", sock, "-p", PORT, "-U", role, "-d", "zeman_verify", "-v", "ON_ERROR_STOP=1", "-tAq",
     "-c", `begin; select set_config('request.jwt.claim.sub','${uid}',true); ${sql}; commit;`]);

  return { psql, psqlFile, psqlAsRole, root, stop };
}
