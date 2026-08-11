import test from "node:test";
import assert from "node:assert/strict";
import {
  AMBIGUOUS, CommandKeyBook, DEFINITE, OutcomeUnknownError,
  classifyFailure, runIdempotentCommand,
} from "../src/services/commandRetry.js";

const noSleep = async () => {};

// ── classification ───────────────────────────────────────────────────────────

test("a PostgreSQL error is definite — the server refused and said why", () => {
  assert.equal(classifyFailure({ code: "22023", message: "an 8-character reason is required" }), DEFINITE);
  assert.equal(classifyFailure({ code: "42501", message: "not authorized" }), DEFINITE);
  assert.equal(classifyFailure({ code: "P0002", message: "not found" }), DEFINITE);
});

test("a PostgREST error is definite", () => {
  assert.equal(classifyFailure({ code: "PGRST202", message: "function does not exist" }), DEFINITE);
});

// The whole reason this module exists: a lost response must never look like a refusal.
test("a dropped connection is ambiguous, not a failure", () => {
  for (const message of [
    "TypeError: Failed to fetch", "NetworkError when attempting to fetch resource",
    "Network request failed", "Load failed", "fetch failed",
    "request timed out", "socket hang up", "ECONNRESET",
  ]) {
    assert.equal(classifyFailure({ message }), AMBIGUOUS, `${message} must be ambiguous`);
  }
});

test("an aborted request is ambiguous", () => {
  assert.equal(classifyFailure({ name: "AbortError", message: "The operation was aborted" }), AMBIGUOUS);
  assert.equal(classifyFailure(Object.assign(new TypeError("Failed to fetch"), {})), AMBIGUOUS);
});

test("a gateway or throttling response is ambiguous — it may never have reached the database", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(classifyFailure({ status, message: "Bad Gateway" }), AMBIGUOUS, `${status} must be ambiguous`);
  }
});

// The dangerous mistake is calling a command failed when it actually committed, so anything
// unrecognised errs towards "we do not know".
test("an unrecognised error is ambiguous rather than assumed failed", () => {
  assert.equal(classifyFailure({ message: "something strange" }), AMBIGUOUS);
  assert.equal(classifyFailure(null), AMBIGUOUS);
  assert.equal(classifyFailure({ code: 500 }), AMBIGUOUS, "a numeric code is not a SQLSTATE");
});

// ── retrying ─────────────────────────────────────────────────────────────────

test("a command that works is run once", async () => {
  const seen = [];
  const out = await runIdempotentCommand({
    commandKey: "k1", sleep: noSleep,
    invoke: async (key) => { seen.push(key); return { ok: true }; },
  });
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(seen, ["k1"]);
});

// The defect this replaces: a fresh key per attempt made every retry a second real command.
test("every retry carries the same key, so the server replays instead of re-running", async () => {
  const seen = [];
  await runIdempotentCommand({
    commandKey: "k-same", sleep: noSleep, attempts: 3,
    invoke: async (key) => {
      seen.push(key);
      if (seen.length < 3) throw { message: "Failed to fetch" };
      return { replayed: true };
    },
  });
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen).size, 1, "a retry must not mint a new command key");
});

test("a server refusal is raised at once, not retried", async () => {
  let calls = 0;
  await assert.rejects(
    () => runIdempotentCommand({
      commandKey: "k2", sleep: noSleep, attempts: 5,
      invoke: async () => { calls++; throw { code: "22023", message: "an 8-character reason is required" }; },
    }),
    (e) => e.code === "22023",
  );
  assert.equal(calls, 1, "a refusal the server stated must not be retried");
});

test("the server's own message reaches the operator unchanged", async () => {
  await assert.rejects(
    () => runIdempotentCommand({
      commandKey: "k3", sleep: noSleep,
      invoke: async () => { throw { code: "42501", message: "only an administrator may forward receipts" }; },
    }),
    (e) => e.message === "only an administrator may forward receipts",
  );
});

// A command that may have committed must never be reported as failed.
test("an unreachable server ends as an unknown outcome, never as a failure", async () => {
  await assert.rejects(
    () => runIdempotentCommand({
      commandKey: "k4", sleep: noSleep, attempts: 3,
      invoke: async () => { throw { message: "Failed to fetch" }; },
    }),
    (e) => {
      assert.ok(e instanceof OutcomeUnknownError);
      assert.equal(e.outcomeUnknown, true);
      assert.equal(e.attempts, 3);
      assert.ok(!/سەرکەوتوو نەبوو|شکست/.test(e.message), "must not claim the command failed");
      return true;
    },
  );
});

test("the unknown-outcome message tells the operator not to simply redo it", async () => {
  const e = await runIdempotentCommand({
    commandKey: "k5", sleep: noSleep, attempts: 1,
    invoke: async () => { throw { message: "Load failed" }; },
  }).catch((err) => err);
  assert.match(e.message, /بیپشکنە|مەکەرەوە/);
});

test("retries are announced so the interface can say what is happening", async () => {
  const notes = [];
  await runIdempotentCommand({
    commandKey: "k6", sleep: noSleep, attempts: 3,
    onRetry: (info) => notes.push(info.attempt),
    invoke: async () => { if (notes.length < 2) throw { message: "fetch failed" }; return true; },
  });
  assert.deepEqual(notes, [1, 2]);
});

test("backoff grows and is awaited between attempts", async () => {
  const slept = [];
  await runIdempotentCommand({
    commandKey: "k7", attempts: 3, backoffMs: 100,
    sleep: async (ms) => { slept.push(ms); },
    invoke: async () => { if (slept.length < 2) throw { message: "timeout" }; return true; },
  });
  assert.deepEqual(slept, [100, 200]);
});

test("a command with no key is refused rather than run unprotected", async () => {
  await assert.rejects(() => runIdempotentCommand({ invoke: async () => true }));
});

// ── the key book ─────────────────────────────────────────────────────────────

test("one intent keeps one key across attempts", () => {
  const book = new CommandKeyBook();
  const a = book.keyFor("save-tx-7", "tx", "u1");
  const b = book.keyFor("save-tx-7", "tx", "u1");
  assert.equal(a, b);
});

test("different intents get different keys", () => {
  const book = new CommandKeyBook();
  assert.notEqual(book.keyFor("save-tx-7", "tx"), book.keyFor("save-tx-8", "tx"));
});

test("a released intent gets a fresh key next time", () => {
  const book = new CommandKeyBook();
  const first = book.keyFor("void-9", "void");
  book.release("void-9");
  assert.notEqual(book.keyFor("void-9", "void"), first);
});

// The manual retry after "outcome unknown" is exactly where a new key would duplicate money.
test("an unresolved intent keeps its key, so a manual retry still replays", () => {
  const book = new CommandKeyBook();
  const first = book.keyFor("settle-3", "settle");
  assert.equal(book.has("settle-3"), true);
  assert.equal(book.keyFor("settle-3", "settle"), first, "a manual retry must reuse the key");
});

test("the key carries who issued it and what kind of command it is", () => {
  const book = new CommandKeyBook(() => "fixed-id");
  assert.equal(book.keyFor("i1", "day-close", "u-owner"), "day-close:u-owner:fixed-id");
});

test("releasing an intent that was never issued is harmless", () => {
  const book = new CommandKeyBook();
  book.release("never-existed");
  assert.equal(book.size, 0);
});
