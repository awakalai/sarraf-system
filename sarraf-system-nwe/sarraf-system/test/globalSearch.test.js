import test from "node:test";
import assert from "node:assert/strict";
import { operationalSearch, safeCommand } from "../src/services/operationalControl.js";

test("global search is bounded and delegates authorization to one RPC", async () => {
  let call;
  const client = { rpc: async (name, args) => { call = { name, args }; return { data: [] }; } };
  const result = await operationalSearch(client, "  Order  ", { limit: 999 });
  assert.equal(call.name, "sarraf_operational_search");
  assert.equal(call.args.p_query, "Order");
  assert.equal(call.args.p_limit, 20);
  assert.deepEqual(result, { results: [], nextCursor: null });
});

test("commands permit navigation only and reject data-bearing paths", () => {
  assert.equal(safeCommand({ kind: "navigation", path: "#/receipts" }), true);
  for (const kind of ["approve", "link", "settle", "delete"]) assert.equal(safeCommand({ kind, path: "#/txs" }), false);
  assert.equal(safeCommand({ kind: "navigation", path: "#/txs?id=hidden" }), false);
});
