/**
 * Object URL lifecycle for receipt images (§12: "image memory cleanup/object URL revoke").
 *
 * Every processed receipt gets `URL.createObjectURL(blob)`. That URL pins the whole image blob
 * in memory until it is explicitly revoked — the garbage collector cannot reclaim it, because
 * the document itself holds the reference. Nothing revoked them, so a phone working through a
 * batch of receipts accumulated every full-size image it had ever decoded, and the tab was
 * eventually killed mid-batch.
 *
 * A URL becomes garbage in exactly two ways: its row is removed, or its row is given a new
 * image. Both are visible by comparing the list before and after a change, which is why this
 * is a comparison rather than a hook scattered through the call sites.
 */

const urlsIn = (rows) => {
  const out = new Set();
  for (const r of rows || []) if (r && typeof r.url === "string" && r.url.startsWith("blob:")) out.add(r.url);
  return out;
};

/**
 * Revokes every blob URL present before a change and absent after it.
 *
 * @returns {string[]} the URLs revoked, so a caller can assert on them
 */
export function revokeDroppedUrls(prev, next, revoke) {
  const before = urlsIn(prev);
  if (!before.size) return [];
  const after = urlsIn(next);
  const dropped = [...before].filter((url) => !after.has(url));
  for (const url of dropped) {
    // A revoke that throws must not take the state update down with it.
    try { revoke(url); } catch { /* already revoked, or not ours */ }
  }
  return dropped;
}

/** Revokes everything a list still holds — for unmount, where nothing survives. */
export function revokeAllUrls(rows, revoke) {
  return revokeDroppedUrls(rows, [], revoke);
}
