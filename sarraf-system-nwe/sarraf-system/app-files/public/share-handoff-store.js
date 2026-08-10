/* Shared-receipt staging contract used by the service worker. No receipt is persisted here. */
(function (scope) {
  const DB_NAME = "zeman-receipt-share-v1";
  const STORE = "handoffs";
  const EXPIRY_MS = 15 * 60 * 1000;
  const MAX_FILES = 10;
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const ALLOWED = Object.freeze({
    "image/jpeg": [[0xff, 0xd8, 0xff]],
    "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    "image/webp": [[0x52, 0x49, 0x46, 0x46]],
  });

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function transaction(db, mode, action) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Share handoff transaction aborted"));
      result = action(store, tx);
    });
  }
  async function cleanup(now = Date.now()) {
    const db = await openDb();
    await transaction(db, "readwrite", (store) => {
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        if (current.value.expiresAt <= now) current.delete();
        current.continue();
      };
    });
    db.close();
  }
  function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  function safeName(name, index) {
    const cleaned = String(name || "").normalize("NFKC").replace(/[\\/\0-\x1f\x7f]+/g, "_").slice(0, 120);
    return cleaned || `shared-receipt-${index + 1}`;
  }
  async function signatureMatches(file) {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (file.type === "image/webp") {
      return ALLOWED[file.type][0].every((b, i) => bytes[i] === b) &&
        [0x57, 0x45, 0x42, 0x50].every((b, i) => bytes[i + 8] === b);
    }
    return (ALLOWED[file.type] || []).some((sig) => sig.every((b, i) => bytes[i] === b));
  }
  async function validate(files) {
    const accepted = [], rejected = [], seen = new Set();
    const incoming = Array.from(files || []);
    if (!incoming.length) return { accepted, rejected: [{ code: "missing", name: "" }] };
    for (let i = 0; i < incoming.length; i += 1) {
      const file = incoming[i];
      const name = safeName(file && file.name, i);
      let code = null;
      if (i >= MAX_FILES) code = "count";
      else if (!file || !ALLOWED[file.type]) code = "type";
      else if (!(file.size > 0)) code = "empty";
      else if (file.size > MAX_FILE_BYTES) code = "oversize";
      else if (!(await signatureMatches(file))) code = "signature";
      if (code) { rejected.push({ code, name }); continue; }
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (b) => b.toString(16).padStart(2, "0")).join("");
      if (seen.has(digest)) { rejected.push({ code: "duplicate", name }); continue; }
      seen.add(digest);
      accepted.push({ blob: file, name, type: file.type, size: file.size, digest });
    }
    return { accepted, rejected };
  }
  async function stage(files, now = Date.now()) {
    await cleanup(now);
    const checked = await validate(files);
    if (!checked.accepted.length) return { id: null, ...checked };
    const id = randomId();
    const db = await openDb();
    await transaction(db, "readwrite", (store) => store.add({ id, createdAt: now, expiresAt: now + EXPIRY_MS, owner: null, lease: null, files: checked.accepted, rejected: checked.rejected }));
    db.close();
    return { id, accepted: checked.accepted.length, rejected: checked.rejected };
  }
  scope.ZemanShareStore = { DB_NAME, STORE, EXPIRY_MS, MAX_FILES, MAX_FILE_BYTES, ALLOWED, cleanup, stage, validate };
})(self);
