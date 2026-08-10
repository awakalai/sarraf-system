import fs from "node:fs";
const sql = fs.readFileSync("supabase/migrations/202608100004_global_command_search.sql", "utf8").toLowerCase();
const ui = fs.readFileSync("src/components/operations/OperationalPalette.jsx", "utf8");
for (const token of ["security definer", "set search_path = pg_catalog, public", "auth.uid()", "result_limit", "revoke all", "grant execute"]) if (!sql.includes(token)) throw new Error(`Missing search security contract: ${token}`);
for (const token of ['role="dialog"', 'role="combobox"', 'aria-live="polite"', "event.metaKey", "event.ctrlKey", 'event.key === "Escape"']) if (!ui.includes(token)) throw new Error(`Missing palette accessibility contract: ${token}`);
console.log("Global Search authorization, bounds, command safety, and accessibility contracts passed.");
