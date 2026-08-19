/**
 * What the manager sees, which is not what anybody else sees.
 *
 * The manager maintains the installation and sells it. They are not a party to any business's
 * trades, and their console shows businesses, accounts and the health of the system rather than
 * transactions, receipts and rates. Reaching a business's own figures means stepping into it
 * deliberately, not having them mixed into a dashboard by default.
 *
 * Nothing here computes a total from business data. That is the point: a manager reading a
 * different number from the business that owns it would be worse than reading none.
 */

const clean = (v) => String(v ?? "").normalize("NFKC").trim();

export const TENANT_ID_MIN = 3;

/** A business's id is typed once and lives forever in every row it owns. */
export function tenantIdObjection(id) {
  const value = clean(id);
  if (value.length < TENANT_ID_MIN) return `ناسنامەی سەرخێڵ لانیکەم ${TENANT_ID_MIN} پیت بێت`;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    return "تەنها پیتی ئینگلیزیی بچووک، ژمارە و داش (-)";
  }
  return null;
}

export function tenantNameObjection(name) {
  return clean(name).length < 2 ? "ناوی سەرخێڵ پێویستە" : null;
}

/** Every business, with what it holds. Manager only; the server refuses anybody else. */
export async function loadTenants(client) {
  const { data, error } = await client.rpc("sarraf_manager_tenants");
  if (error) throw error;
  return data || { tenants: [], total_accounts: 0 };
}

export async function createTenant(client, { id, name, note = null }) {
  const objection = tenantIdObjection(id) || tenantNameObjection(name);
  if (objection) throw new Error(objection);
  const { data, error } = await client.rpc("sarraf_manager_create_tenant", {
    p_id: clean(id), p_name: clean(name), p_note: clean(note) || null,
  });
  if (error) throw error;
  return data;
}

/**
 * Suspending a business rather than deleting it.
 *
 * Their data stays exactly where it is. A business that has stopped paying, or stopped trading,
 * is not a business whose books should be destroyed — and reversing a suspension is a switch
 * where reversing a deletion is a restore from backup.
 */
export async function setTenantActive(client, { id, active, reason }) {
  if (!clean(id)) throw new Error("سەرخێڵێک پێویستە");
  if (clean(reason).length < 4) throw new Error("هۆکارێک بنووسە");
  const { data, error } = await client.rpc("sarraf_manager_set_tenant_active", {
    p_id: clean(id), p_active: Boolean(active), p_reason: clean(reason),
  });
  if (error) throw error;
  return data;
}

/** The state of the installation itself: drift, tenancy gaps, rows belonging to nobody. */
export async function loadHealth(client) {
  const [schema, coverage, orphans] = await Promise.all([
    client.rpc("sarraf_schema_report"),
    client.rpc("sarraf_tenant_coverage"),
    client.rpc("sarraf_tenant_orphans"),
  ]);
  if (schema.error) throw schema.error;
  return {
    schema: schema.data || { tables: [], columns: [] },
    // A coverage or orphan read that fails must not hide the schema report that succeeded.
    coverage: coverage.error ? null : (coverage.data || []),
    orphans: orphans.error ? null : (orphans.data?.orphans || {}),
    coverageError: coverage.error ? String(coverage.error.message || coverage.error) : null,
    orphansError: orphans.error ? String(orphans.error.message || orphans.error) : null,
  };
}

/**
 * Is the installation in good order?
 *
 * Returns the list of what is wrong, in the order it matters. An empty list is the only good
 * answer, and it is stated as a list rather than a boolean so a screen can show what to do.
 */
export function healthProblems(health, lang = "ku") {
  const out = [];
  const ku = lang !== "en";
  for (const t of health?.schema?.tables || []) {
    out.push(ku
      ? `خشتەی ${t.table_name} — ${t.state === "missing from the database" ? "لە داتابەیسدا نییە" : "بەڕێوە نابرێت"}`
      : `table ${t.table_name} — ${t.state}`);
  }
  for (const c of health?.schema?.columns || []) {
    out.push(ku
      ? `ستوونی ${c.table_name}.${c.column_name} — چاوەڕوان ${c.expected}، دۆزرایەوە ${c.found}`
      : `${c.table_name}.${c.column_name} — expected ${c.expected}, found ${c.found}`);
  }
  for (const g of health?.coverage || []) {
    out.push(ku
      ? `${g.table_name} — جیاکردنەوەی سەرخێڵی نییە`
      : `${g.table_name} — ${g.problem}`);
  }
  for (const [table, n] of Object.entries(health?.orphans || {})) {
    out.push(ku ? `${table} — ${n} ڕیز خاوەنیان نییە` : `${table} — ${n} rows belong to nobody`);
  }
  return out;
}

/** Accounts across every business, for the one screen that is allowed to see across them. */
export async function loadAllAccounts(client) {
  const { data, error } = await client.rpc("sarraf_manager_accounts");
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}
