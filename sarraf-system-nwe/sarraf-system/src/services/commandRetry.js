/**
 * Idempotent command execution (§12: "queued action conflict/replay policy",
 * "کردارێکی دارایی بە درۆ success نەکات").
 *
 * Every financial command carries a command key, and the server replays the first result when
 * it sees that key again. That machinery only works if a retry carries the SAME key — and a
 * key minted fresh on each attempt turns it into decoration.
 *
 * The failure it has to survive is the ambiguous one. A transaction is sent, the server commits
 * it, and the response is lost — a dropped connection, a timeout, a throttled tab. The browser
 * sees a network error and has no way to know whether the money moved. Telling the operator
 * "try again" there is the worst possible answer: they try again, a new key is minted, and the
 * transaction posts twice.
 *
 * So this module does three things:
 *
 *   1. Separates a definite failure (the server answered, with a code) from an ambiguous one
 *      (nobody answered). Only the server's own refusals are treated as certain.
 *   2. Retries ambiguous failures with the SAME key, which is safe precisely because the server
 *      replays rather than re-executing.
 *   3. When even the retries cannot reach the server, says the outcome is unknown — never that
 *      it failed — and keeps the key, so a manual retry still replays instead of duplicating.
 */

/** A failure the server itself reported. Safe to surface, safe not to retry. */
export const DEFINITE = "definite";
/** Nobody answered. The command may or may not have run. */
export const AMBIGUOUS = "ambiguous";

const NETWORK_PATTERNS =
  /failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout|timed out|aborted|the operation was aborted|econnreset|econnrefused|etimedout|socket hang up|connection closed/i;

/** Gateway and throttling responses mean the request may not have reached the database. */
const AMBIGUOUS_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * A PostgreSQL SQLSTATE (five alphanumerics) or a PostgREST code means the server spoke.
 * Anything else — including no code at all — is treated as ambiguous, because the dangerous
 * mistake is calling a command failed when it actually committed.
 */
export function classifyFailure(error) {
  if (!error) return AMBIGUOUS;

  const status = Number(error.status ?? error.statusCode);
  if (Number.isFinite(status) && AMBIGUOUS_STATUS.has(status)) return AMBIGUOUS;

  const message = String(error.message || error.error_description || error);
  if (NETWORK_PATTERNS.test(message)) return AMBIGUOUS;
  if (error.name === "AbortError" || error.name === "TimeoutError") return AMBIGUOUS;
  // A bare TypeError is what fetch throws when it never reached anything.
  if (error.name === "TypeError" && !error.code) return AMBIGUOUS;

  const code = typeof error.code === "string" ? error.code : null;
  if (code && (/^[0-9A-Za-z]{5}$/.test(code) || code.startsWith("PGRST"))) return DEFINITE;

  return AMBIGUOUS;
}

/** Raised when the command could not be confirmed either way. Never means "it failed". */
export class OutcomeUnknownError extends Error {
  constructor(cause, attempts) {
    super("پەیوەندی پچڕا — نازانرێت کردارەکە تۆمار کراوە یان نا. تکایە سەرەتا بیپشکنە، دووبارەی مەکەرەوە");
    this.name = "OutcomeUnknownError";
    this.cause = cause;
    this.attempts = attempts;
    // The caller must not present this as a failure, and must not clear the command key.
    this.outcomeUnknown = true;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a command, retrying only what is safe to retry, always under the same key.
 *
 * @param {(key: string) => Promise<any>} invoke called with the command key; must throw on failure
 * @param {string} commandKey the key that makes a retry a replay
 * @param {number} attempts total tries, including the first
 * @returns {Promise<any>} whatever `invoke` resolves to
 * @throws the server's own error on a definite failure; OutcomeUnknownError otherwise
 */
export async function runIdempotentCommand({
  invoke, commandKey, attempts = 3, backoffMs = 400, sleep = wait, onRetry = () => {},
} = {}) {
  if (typeof invoke !== "function") throw new Error("invoke is required");
  if (!commandKey) throw new Error("a command key is required");

  let last = null;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    try {
      return await invoke(commandKey);
    } catch (error) {
      last = error;
      // The server refused. Retrying cannot change that, and the operator needs the reason.
      if (classifyFailure(error) === DEFINITE) throw error;
      if (attempt >= attempts) break;
      onRetry({ attempt, error });
      // Same key on the way back in: the server replays rather than re-executing.
      await sleep(backoffMs * attempt);
    }
  }
  throw new OutcomeUnknownError(last, Math.max(1, attempts));
}

/**
 * Hands out one key per intent and keeps it until the outcome is known.
 *
 * The point is the manual retry. An operator told "the outcome is unknown" may press save
 * again; if that mints a new key the command runs a second time for real. Holding the key
 * against the intent means their retry is still a replay.
 */
export class CommandKeyBook {
  constructor(newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`) {
    this.newId = newId;
    this.keys = new Map();
  }

  /** The key for this intent — the same one until it is released. */
  keyFor(intent, kind = "cmd", actorId = "user") {
    const id = String(intent || kind);
    if (!this.keys.has(id)) this.keys.set(id, `${kind}:${actorId}:${this.newId()}`);
    return this.keys.get(id);
  }

  /** Called once the outcome is known — success, or a refusal the server actually stated. */
  release(intent) { this.keys.delete(String(intent)); }

  /** Kept deliberately: an unknown outcome must not get a fresh key on the next attempt. */
  has(intent) { return this.keys.has(String(intent)); }

  get size() { return this.keys.size; }
}
