// A limit on how fast our own doors can be knocked on.
//
// Every provider we call has one, and we read theirs carefully. Our own routes had none, so a
// single account could hold the whole OCR budget open against every other customer, and an
// automated attempt at the admin route was limited only by how fast it could type.
//
// The counter lives in the database, not in this process. These routes are serverless: a
// per-process counter resets on every cold start and counts separately in every instance, which
// is the same as not counting at all.

const HEADERS = (verdict) => ({
  "X-RateLimit-Limit": String(verdict.limit),
  "X-RateLimit-Remaining": String(verdict.remaining),
  ...(verdict.allowed ? {} : { "Retry-After": String(verdict.retry_after_seconds || 60) }),
});

/**
 * Count this attempt and say whether it may proceed.
 *
 * A failure to reach the counter allows the request. A limiter that closes the business when the
 * database hiccups is a worse outage than the abuse it prevents, and every route behind it still
 * checks who is calling.
 */
export async function checkRateLimit({ url, key, bucket, subject, limit, windowSeconds }) {
  if (!url || !key || !subject) return { allowed: true, limit, remaining: limit, degraded: true };
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/sarraf_rate_limit`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_bucket: bucket, p_subject: String(subject),
        p_limit: limit, p_window_seconds: windowSeconds,
      }),
    });
    if (!res.ok) return { allowed: true, limit, remaining: limit, degraded: true };
    const verdict = await res.json();
    return {
      allowed: verdict?.allowed !== false,
      limit: Number(verdict?.limit) || limit,
      remaining: Number(verdict?.remaining) || 0,
      retry_after_seconds: Number(verdict?.retry_after_seconds) || windowSeconds,
      degraded: false,
    };
  } catch {
    return { allowed: true, limit, remaining: limit, degraded: true };
  }
}

/**
 * Apply a limit and, when it bites, answer the request. Returns true when the caller should stop.
 *
 * The refusal says when to come back, in the language the rest of the interface speaks.
 */
export async function refuseIfOverLimit(res, options) {
  const verdict = await checkRateLimit(options);
  for (const [k, v] of Object.entries(HEADERS(verdict))) res.setHeader(k, v);
  if (verdict.allowed) return false;
  res.status(429).json({
    error: `داواکاری زۆر زۆرە — تکایە دوای ${verdict.retry_after_seconds} چرکە دووبارە هەوڵ بدە`,
    code: "rate_limited",
    retryable: true,
    retryAfterSeconds: verdict.retry_after_seconds,
  });
  return true;
}

/**
 * Who is being limited. A signed-in caller is limited as themselves; an unauthenticated one is
 * limited by the address the request came from, so that failing to sign in is not a way of
 * escaping the limit.
 */
export function limitSubject(req, profileId) {
  if (profileId) return `user:${profileId}`;
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return `ip:${forwarded || req?.socket?.remoteAddress || "unknown"}`;
}
