/**
 * Knowing whether a receipt send actually landed.
 *
 * The reported failure is usually not a failure. The ingestion RPC is atomic: either the batch
 * and all its receipts are written, or nothing is. But the *answer* can be lost — a dropped
 * connection, a backgrounded tab, a reload. The browser then says "sending failed" about work
 * the database has already done.
 *
 * The consequence is worse than the wrong message. The receipts are in, marked accepted. When
 * the uploader tries again — which is exactly what "failed" told them to do — the duplicate
 * check finds their own earlier rows and refuses every one. The system now says "failed" and
 * "duplicate" forever, about a send that succeeded the first time.
 *
 * So the command is written down before it is sent, and it survives a reload. After any
 * failure, and on the next load, the batch id is looked up. Present means it landed and the
 * uploader is told so. Absent means it genuinely did not, and a retry is safe. Only when the
 * lookup itself cannot run is the outcome unknown — and that is said plainly rather than
 * being called a failure.
 */

const KEY = "zeman.receiptSend.pending";

/** Deliberately minimal: an identifier and a count. No amounts, no customer, no image data. */
const shape = (c) => ({
  batchId: c.batchId,
  idempotencyKey: c.idempotencyKey,
  receiptCount: Number(c.receiptCount) || 0,
  startedAt: c.startedAt || new Date().toISOString(),
});

const store = () => {
  try { return globalThis.localStorage || null; } catch { return null; }
};

/** Written before the send, so a reload can still find out what happened. */
export function rememberSend(command, receiptCount, storage = store()) {
  if (!command?.batchId || !storage) return null;
  const record = shape({ ...command, receiptCount });
  try { storage.setItem(KEY, JSON.stringify(record)); } catch { /* private mode */ }
  return record;
}

export function pendingSend(storage = store()) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.batchId ? parsed : null;
  } catch { return null; }
}

export function forgetSend(storage = store()) {
  if (!storage) return;
  try { storage.removeItem(KEY); } catch { /* nothing to do */ }
}

export const OUTCOME = Object.freeze({
  landed: "landed",
  notLanded: "not_landed",
  unknown: "unknown",
});

export const OUTCOME_TEXT = Object.freeze({
  landed: "فیشەکانت پێشتر گەیشتوون ✓ — پێویست ناکات دووبارە بیاننێریت",
  not_landed: "فیشەکان نەگەیشتن — بە سەلامەتی دووبارە هەوڵ بدەوە",
  unknown: "نەزانرا گەیشتوون یان نا — تکایە لیستی فیشەکانت بپشکنە پێش ئەوەی دووبارە بنێریت",
});
export const outcomeText = (o) => OUTCOME_TEXT[o] || o;

/**
 * Asks the database whether this batch exists.
 *
 * A row means the whole command committed, because the write is atomic. No row means it did
 * not. An error means the question could not be asked — which is not the same as "no", and is
 * never reported as a failure.
 */
export async function resolveSendOutcome(client, batchId) {
  if (!batchId) return { outcome: OUTCOME.notLanded, batchId: null };
  try {
    const { data, error } = await client
      .from("receipt_batches")
      .select("id,n,created_at")
      .eq("id", batchId)
      .maybeSingle();
    if (error) return { outcome: OUTCOME.unknown, batchId, error };
    if (data?.id) {
      return { outcome: OUTCOME.landed, batchId, receiptCount: Number(data.n) || null, at: data.created_at };
    }
    return { outcome: OUTCOME.notLanded, batchId };
  } catch (error) {
    return { outcome: OUTCOME.unknown, batchId, error };
  }
}

/**
 * The one call the send path makes when something went wrong: it turns an exception into the
 * truth about the receipts.
 *
 * `landed` is a success the user should be told about, not an error. Only `not_landed` is a
 * real failure worth retrying, and only `unknown` leaves the command remembered — because a
 * command whose outcome nobody knows must not be forgotten and silently repeated.
 */
export async function settleFailedSend(client, command, error, storage = store()) {
  const resolved = await resolveSendOutcome(client, command?.batchId);
  if (resolved.outcome === OUTCOME.landed || resolved.outcome === OUTCOME.notLanded) {
    forgetSend(storage);
  }
  return {
    ...resolved,
    text: outcomeText(resolved.outcome),
    // The original failure is kept so the operator can still be told which stage broke.
    stage: error?.stage || null,
    code: error?.code || null,
    requestId: error?.requestId || null,
  };
}

/** Plain language for the stage that failed, so "sending failed" is never the whole message. */
export const STAGE_TEXT = Object.freeze({
  storage: "وێنەکە نەگەیشتە سێرڤەر",
  finalize: "وێنەکان گەیشتن، بەڵام داتابەیس تۆماری نەکردن",
  verify: "نەزانرا تۆمار کراون یان نا",
  cleanup: "پاککردنەوەی وێنە تەواو نەبوو",
});
export const stageText = (s) => STAGE_TEXT[s] || "ناردن تەواو نەبوو";
