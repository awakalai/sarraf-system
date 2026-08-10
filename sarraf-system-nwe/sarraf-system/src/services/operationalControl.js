export const SEARCH_LIMIT = 20;
export function safeCommand(command) {
  return command && command.kind === "navigation" && typeof command.path === "string" && /^#\/[^?#]+$/.test(command.path);
}

export async function operationalSearch(client, query, { cursor = null, limit = SEARCH_LIMIT } = {}) {
  const q = String(query || "").normalize("NFKC").trim().slice(0, 80);
  if (q.length < 2) return { results: [], nextCursor: null };
  const bounded = Math.min(SEARCH_LIMIT, Math.max(1, Number(limit) || SEARCH_LIMIT));
  const { data, error } = await client.rpc("sarraf_operational_search", { p_query: q, p_limit: bounded, p_cursor: cursor });
  if (error) throw error;
  return { results: data || [], nextCursor: data?.length === bounded ? data.at(-1)?.cursor || null : null };
}
