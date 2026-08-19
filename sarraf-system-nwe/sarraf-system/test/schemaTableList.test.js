import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The drift report's list of expected tables must match the migrations that create them.
 *
 * A list typed by hand falls behind the moment somebody adds a table and forgets, and a drift
 * report that is behind is worse than none: it reports "everything matches" about a schema it
 * has stopped describing. This test is what keeps the two in step, and it fails loudly with the
 * exact names to add or remove.
 */

const root = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.join(root, "supabase", "migrations");

const migrationText = () =>
  readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(path.join(migrationsDir, name), "utf8"))
    .join("\n");

const created = () => {
  const names = new Set();
  const pattern = /create table (?:if not exists )?public\.(\w+)/gi;
  let match;
  while ((match = pattern.exec(migrationText())) !== null) names.add(match[1]);
  return names;
};

const expectedInReport = () => {
  const file = readFileSync(
    path.join(migrationsDir, "202608220002_schema_drift_tables.sql"), "utf8");
  const block = file.slice(file.indexOf("with expected(t) as (values"), file.indexOf("), live as ("));
  const names = new Set();
  const pattern = /\('(\w+)'\)/g;
  let match;
  while ((match = pattern.exec(block)) !== null) names.add(match[1]);
  return names;
};

test("the drift report expects every table the migrations create", () => {
  const missing = [...created()].filter((name) => !expectedInReport().has(name)).sort();
  assert.deepEqual(missing, [],
    `these tables are created by a migration but absent from sarraf_schema_tables: ${missing.join(", ")}`);
});

test("the drift report expects no table the migrations do not create", () => {
  const stale = [...expectedInReport()].filter((name) => !created().has(name)).sort();
  assert.deepEqual(stale, [],
    `sarraf_schema_tables expects tables no migration creates: ${stale.join(", ")}`);
});

test("the list is not empty, which would make the report silently vacuous", () => {
  assert.ok(expectedInReport().size > 40, `only ${expectedInReport().size} tables listed`);
});
