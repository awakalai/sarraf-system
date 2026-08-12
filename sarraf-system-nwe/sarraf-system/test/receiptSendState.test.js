import test from "node:test";
import assert from "node:assert/strict";
import {
  OUTCOME, forgetSend, outcomeText, pendingSend, rememberSend,
  resolveSendOutcome, settleFailedSend, stageText,
} from "../src/services/receiptSendState.js";

const fakeStorage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
};

const clientReturning = (result) => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => result }) }) }),
});

const command = { batchId: "b-1", idempotencyKey: "receipt-ingest:b-1" };

// ── remembering the command ──────────────────────────────────────────────────

test("the command is written down before the send", () => {
  const s = fakeStorage();
  rememberSend(command, 4, s);
  const back = pendingSend(s);
  assert.equal(back.batchId, "b-1");
  assert.equal(back.receiptCount, 4);
});

// Losing the page must not lose the question "did my receipts arrive?".
test("a reload can still find the unresolved send", () => {
  const s = fakeStorage();
  rememberSend(command, 2, s);
  const afterReload = pendingSend(fakeStorage_from(s));
  assert.equal(afterReload.batchId, "b-1");
});
function fakeStorage_from(other) {
  const s = fakeStorage();
  for (const [k, v] of other._map) s.setItem(k, v);
  return s;
}

test("only an identifier and a count are kept — never the money", () => {
  const s = fakeStorage();
  rememberSend({ ...command, amount: 3400, customer: "someone" }, 1, s);
  const kept = JSON.parse(s.getItem("zeman.receiptSend.pending"));
  assert.deepEqual(Object.keys(kept).sort(), ["batchId", "idempotencyKey", "receiptCount", "startedAt"]);
});

test("forgetting clears it", () => {
  const s = fakeStorage();
  rememberSend(command, 1, s);
  forgetSend(s);
  assert.equal(pendingSend(s), null);
});

test("a browser with no storage is not an error", () => {
  assert.equal(rememberSend(command, 1, null), null);
  assert.equal(pendingSend(null), null);
});

test("corrupted storage reads as nothing pending", () => {
  const s = fakeStorage();
  s.setItem("zeman.receiptSend.pending", "{not json");
  assert.equal(pendingSend(s), null);
});

// ── finding out what really happened ─────────────────────────────────────────

// The defect this whole module exists for: the write succeeded, the answer was lost.
test("a batch that exists means the receipts landed", async () => {
  const r = await resolveSendOutcome(clientReturning({ data: { id: "b-1", n: 4 }, error: null }), "b-1");
  assert.equal(r.outcome, OUTCOME.landed);
  assert.equal(r.receiptCount, 4);
});

test("no batch means the send genuinely did not land", async () => {
  const r = await resolveSendOutcome(clientReturning({ data: null, error: null }), "b-1");
  assert.equal(r.outcome, OUTCOME.notLanded);
});

// "Cannot ask" is not the same as "no", and must never be reported as a failure.
test("a lookup that cannot run is unknown, not a failure", async () => {
  const r = await resolveSendOutcome(clientReturning({ data: null, error: { message: "Failed to fetch" } }), "b-1");
  assert.equal(r.outcome, OUTCOME.unknown);
});

test("a thrown lookup is also unknown rather than crashing the send", async () => {
  const throwing = { from: () => { throw new Error("offline"); } };
  const r = await resolveSendOutcome(throwing, "b-1");
  assert.equal(r.outcome, OUTCOME.unknown);
});

// ── settling a reported failure ──────────────────────────────────────────────

// The exact situation the owner reported: told it failed, when it had not.
test("a failure whose receipts actually landed is reported as success", async () => {
  const s = fakeStorage();
  rememberSend(command, 4, s);
  const settled = await settleFailedSend(
    clientReturning({ data: { id: "b-1", n: 4 }, error: null }),
    command, { stage: "verify" }, s,
  );
  assert.equal(settled.outcome, OUTCOME.landed);
  assert.match(settled.text, /گەیشتوون/);
  assert.equal(pendingSend(s), null, "a resolved command is not kept");
});

test("a send that truly failed is safe to retry and stops being pending", async () => {
  const s = fakeStorage();
  rememberSend(command, 4, s);
  const settled = await settleFailedSend(
    clientReturning({ data: null, error: null }), command, { stage: "storage" }, s,
  );
  assert.equal(settled.outcome, OUTCOME.notLanded);
  assert.equal(pendingSend(s), null);
});

// A command nobody knows the outcome of must not be forgotten and quietly repeated.
test("an unknown outcome stays pending so it can be resolved later", async () => {
  const s = fakeStorage();
  rememberSend(command, 4, s);
  const settled = await settleFailedSend(
    clientReturning({ data: null, error: { message: "Failed to fetch" } }),
    command, { stage: "verify" }, s,
  );
  assert.equal(settled.outcome, OUTCOME.unknown);
  assert.equal(pendingSend(s)?.batchId, "b-1", "it must still be resolvable after a reload");
});

test("the stage that failed is carried through, not swallowed", async () => {
  const settled = await settleFailedSend(
    clientReturning({ data: null, error: null }),
    command, { stage: "storage", code: "E_UP", requestId: "rq-9" },
  );
  assert.equal(settled.stage, "storage");
  assert.equal(settled.code, "E_UP");
  assert.equal(settled.requestId, "rq-9");
});

// ── what the person is told ──────────────────────────────────────────────────

// "Sending failed" on its own is what made this unfixable from the outside.
test("every stage says what actually broke", () => {
  for (const s of ["storage", "finalize", "verify", "cleanup"]) {
    assert.notEqual(stageText(s), "ناردن تەواو نەبوو", `${s} needs its own wording`);
  }
});

test("an unrecognised stage still says something rather than nothing", () => {
  assert.equal(typeof stageText("something-new"), "string");
  assert.ok(stageText("something-new").length > 0);
});

test("a landed send is never worded as a failure", () => {
  assert.ok(!/نەبوو|نەگەیشت/.test(outcomeText(OUTCOME.landed)));
});

test("each outcome reads differently", () => {
  const set = new Set([outcomeText(OUTCOME.landed), outcomeText(OUTCOME.notLanded), outcomeText(OUTCOME.unknown)]);
  assert.equal(set.size, 3);
});
