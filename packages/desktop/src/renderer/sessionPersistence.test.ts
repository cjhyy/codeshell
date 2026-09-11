import { afterEach, expect, test } from "bun:test";
import type {
  SessionCatalogApi,
  SessionCatalogPatch,
  SessionCatalogSnapshot,
  SessionIndex,
  SessionSummary,
} from "../shared/session-catalog";
import { initializeSessionPersistence, SessionPersistence } from "./sessionPersistence";
import { loadSessionIndex, migrateProjectSessionBucket } from "./transcripts";

const rawSnapshot = (text: string) =>
  JSON.stringify({ messages: [{ kind: "assistant", id: "answer", done: true, text }] });

const live: SessionPersistence[] = [];
afterEach(() => {
  for (const persistence of live.splice(0)) persistence.dispose();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
  };
}

const row = (id: string, fields: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});
const index = (...sessions: SessionSummary[]): SessionIndex => ({
  sessions,
  activeSessionId: null,
});
const snapshot = (revision: number, project: SessionIndex): SessionCatalogSnapshot => ({
  revision,
  indices: { project },
});

function fixture(options: Partial<SessionCatalogApi> = {}, storage = memoryStorage()) {
  let listener: ((snapshot: SessionCatalogSnapshot) => void) | undefined;
  const errors: unknown[] = [];
  const calls: SessionCatalogPatch[] = [];
  const api: SessionCatalogApi = {
    load: async () => snapshot(0, index()),
    importLegacy: async (indices) =>
      Object.keys(indices).length ? { revision: 1, indices } : api.load(),
    apply: async (patch) => {
      calls.push(patch);
      return snapshot(1, index());
    },
    onChanged: (callback) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    writeTranscript: async () => undefined,
    readTranscript: async () => ({ value: null, hasEarlier: false }),
    deleteTranscript: async () => undefined,
    ...options,
  };
  const persistence = new SessionPersistence(api, storage, (error) => errors.push(error));
  live.push(persistence);
  return {
    api,
    persistence,
    calls,
    errors,
    changed: (next: SessionCatalogSnapshot) => listener?.(next),
  };
}

test("imports all legacy indices before removing them and transfers each exact transcript key after ACK", async () => {
  const first = index(row("session.with.dots", { engineSessionId: "engine" }));
  const removed = { ...index(row("archived", { archived: true })), deletedProjectLabel: "Removed" };
  const storage = memoryStorage({
    "codeshell.sessionIndex.project.with.dots": JSON.stringify(first),
    "codeshell.sessionIndex.removed": JSON.stringify(removed),
    "codeshell.transcript.project.with.dots.session.with.dots": rawSnapshot("first snapshot"),
    "codeshell.transcript.removed.archived": rawSnapshot("archived snapshot"),
    "codeshell.transcript.orphan": "keep unresolved cache",
    "codeshell.preference": "keep preference",
  });
  const imported = deferred<SessionCatalogSnapshot>();
  const firstWrite = deferred<void>();
  const writes: Array<{ projectKey: string; sessionId: string; value: string; legacy?: boolean }> =
    [];
  let sentIndices: Record<string, SessionIndex> | undefined;
  const { persistence } = fixture(
    {
      importLegacy: (indices) => {
        sentIndices = indices;
        return imported.promise;
      },
      writeTranscript: async (input) => {
        writes.push(input);
        if (writes.length === 1) await firstWrite.promise;
      },
    },
    storage,
  );
  const initialization = persistence.initialize();
  expect(sentIndices).toEqual({ "project.with.dots": first, removed });
  expect(storage.getItem("codeshell.sessionIndex.project.with.dots")).not.toBeNull();
  expect(writes).toHaveLength(0);
  imported.resolve({ revision: 3, indices: sentIndices! });
  await Promise.resolve();
  await Promise.resolve();
  expect(storage.getItem("codeshell.sessionIndex.project.with.dots")).toBeNull();
  expect(
    storage.getItem("codeshell.transcript.project.with.dots.session.with.dots"),
  ).not.toBeNull();
  expect(writes).toEqual([
    {
      projectKey: "project.with.dots",
      sessionId: "session.with.dots",
      value: rawSnapshot("first snapshot"),
      legacy: true,
    },
  ]);
  firstWrite.resolve();
  await initialization;
  expect(writes).toHaveLength(2);
  expect(storage.getItem("codeshell.transcript.project.with.dots.session.with.dots")).toBeNull();
  expect(storage.getItem("codeshell.transcript.removed.archived")).toBeNull();
  expect(storage.getItem("codeshell.transcript.orphan")).toBe("keep unresolved cache");
  expect(storage.getItem("codeshell.preference")).toBe("keep preference");
});

test("failed migration preserves source data and retries remaining transcripts after index ACK", async () => {
  const legacy = { project: index(row("one"), row("two")) };
  const storage = memoryStorage({
    "codeshell.sessionIndex.project": JSON.stringify(legacy.project),
    "codeshell.transcript.project.one": rawSnapshot("one"),
    "codeshell.transcript.project.two": rawSnapshot("two"),
  });
  let failed = true;
  const writes: string[] = [];
  const { persistence } = fixture(
    {
      load: async () => ({ revision: 1, indices: legacy }),
      writeTranscript: async ({ sessionId }) => {
        writes.push(sessionId);
        if (sessionId === "two" && failed) throw new Error("disk unavailable");
      },
    },
    storage,
  );
  await expect(persistence.initialize()).rejects.toThrow("disk unavailable");
  expect(storage.getItem("codeshell.sessionIndex.project")).toBeNull();
  expect(storage.getItem("codeshell.transcript.project.one")).toBeNull();
  expect(storage.getItem("codeshell.transcript.project.two")).toBe(rawSnapshot("two"));
  failed = false;
  await persistence.initialize();
  expect(writes).toEqual(["one", "two", "two"]);
  expect(storage.getItem("codeshell.transcript.project.two")).toBeNull();
});

test("emits only changed row fields and retains local edits while another window adds and pins rows", async () => {
  const firstApply = deferred<SessionCatalogSnapshot>();
  const calls: SessionCatalogPatch[] = [];
  const old = row("one", { workspaceProfile: "profile" });
  const { persistence, changed } = fixture({
    load: async () => snapshot(1, index(old)),
    apply: async (patch) => {
      calls.push(patch);
      if (calls.length === 1) return firstApply.promise;
      return snapshot(4, index(row("one", { title: "Local", pinned: true }), row("remote")));
    },
  });
  await persistence.initialize();
  persistence.saveIndex("project", index({ ...old, title: "Local" }));
  expect(calls).toEqual([
    { projectKey: "project", upserts: [{ id: "one", values: { title: "Local" } }] },
  ]);
  changed(snapshot(2, index({ ...old, pinned: true }, row("remote"))));
  expect(persistence.getIndex("project").sessions).toContainEqual({
    ...old,
    title: "Local",
    pinned: true,
  });
  expect(persistence.getIndex("project").sessions).toContainEqual(row("remote"));
  const next = persistence.getIndex("project");
  persistence.saveIndex("project", {
    ...next,
    sessions: next.sessions.map(({ workspaceProfile: _profile, ...session }) => session),
  });
  expect(calls).toHaveLength(1);
  firstApply.resolve(snapshot(3, index({ ...old, title: "Local", pinned: true }, row("remote"))));
  await persistence.flush();
  expect(calls[1]).toEqual({
    projectKey: "project",
    upserts: [{ id: "one", values: {}, removeFields: ["workspaceProfile"] }],
  });
  expect(persistence.getIndex("project").sessions).toContainEqual(
    row("one", { title: "Local", pinned: true }),
  );
});

test("failed writes remain visible, notify errors, reject flush and retry without losing queued edits", async () => {
  let failed = true;
  const calls: SessionCatalogPatch[] = [];
  const { persistence } = fixture({
    apply: async (patch) => {
      calls.push(patch);
      if (failed) throw new Error("read-only disk");
      return snapshot(calls.length, {
        ...index(row("new", { title: calls.length > 1 ? "Renamed" : "new" })),
        activeSessionId: "new",
      });
    },
  });
  const notices: unknown[] = [];
  persistence.subscribeErrors((error) => notices.push(error));
  await persistence.initialize();
  persistence.saveIndex("project", { ...index(row("new")), activeSessionId: "new" });
  persistence.saveIndex("project", {
    ...index(row("new", { title: "Renamed" })),
    activeSessionId: "new",
  });
  await expect(persistence.flush()).rejects.toThrow("read-only disk");
  expect(notices.length).toBeGreaterThan(0);
  expect(persistence.getIndex("project")).toEqual({
    ...index(row("new", { title: "Renamed" })),
    activeSessionId: "new",
  });
  failed = false;
  await persistence.flush();
  expect(calls.at(-1)).toEqual({
    projectKey: "project",
    upserts: [{ id: "new", values: { title: "Renamed" } }],
  });
});

test("ignores stale catalog snapshots and explicitly deletes rows without replacing another row", async () => {
  const calls: SessionCatalogPatch[] = [];
  const { persistence, changed } = fixture({
    load: async () => snapshot(4, index(row("remove"), row("keep"))),
    apply: async (patch) => {
      calls.push(patch);
      return snapshot(5, index(row("keep")));
    },
  });
  await persistence.initialize();
  changed(snapshot(2, index(row("stale"))));
  persistence.saveIndex("project", index(row("keep")));
  await persistence.flush();
  expect(calls).toEqual([{ projectKey: "project", deletedSessionIds: ["remove"] }]);
  expect(persistence.getIndex("project")).toEqual(index(row("keep")));
});

test("keeps new transcript content when an older background snapshot read resolves", async () => {
  const read = deferred<{ value: string | null; hasEarlier: boolean }>();
  const write = deferred<void>();
  const writes: string[] = [];
  const { persistence } = fixture({
    readTranscript: () => read.promise,
    writeTranscript: async ({ value }) => {
      writes.push(value);
      await write.promise;
    },
  });
  await persistence.initialize();
  const loading = persistence.readTranscript("project", "session", 512);
  await Promise.resolve();
  persistence.saveTranscript("project", "session", "new user tail");
  read.resolve({ value: "old disk tail", hasEarlier: true });
  expect(await loading).toEqual({ value: "new user tail", hasEarlier: false });
  expect(persistence.getTranscript("project", "session")).toBe("new user tail");
  write.resolve();
  await persistence.flush();
  expect(writes).toEqual(["new user tail"]);
});

test("a fresh narrow read refreshes a previously expanded snapshot", async () => {
  let reads = 0;
  const { persistence } = fixture({
    readTranscript: async () => ({
      value: rawSnapshot(++reads === 1 ? "Old expanded history" : "New cross-window input"),
      hasEarlier: reads > 1,
    }),
  });
  await persistence.readTranscript("project", "session", 1024);
  expect(await persistence.readTranscript("project", "session", 512)).toEqual({
    value: rawSnapshot("New cross-window input"),
    hasEarlier: true,
  });
});

test("an older read cannot overwrite a newer read that completed first", async () => {
  const old = deferred<{ value: string | null; hasEarlier: boolean }>();
  const recent = deferred<{ value: string | null; hasEarlier: boolean }>();
  let reads = 0;
  const { persistence } = fixture({
    readTranscript: () => (++reads === 1 ? old.promise : recent.promise),
  });
  const first = persistence.readTranscript("project", "session", 512);
  const second = persistence.readTranscript("project", "session", 512);
  recent.resolve({ value: rawSnapshot("Recent state"), hasEarlier: false });
  await second;
  old.resolve({ value: rawSnapshot("Old state"), hasEarlier: true });
  expect(await first).toEqual({ value: rawSnapshot("Recent state"), hasEarlier: false });
  expect(persistence.getTranscript("project", "session")).toBe(rawSnapshot("Recent state"));
});

test("serializes transcript updates and deletion, preserving the failed head until retry", async () => {
  const writes: string[] = [];
  let fail = true;
  const { persistence } = fixture({
    writeTranscript: async ({ value }) => {
      writes.push(value);
      if (fail) throw new Error("disk full");
    },
    deleteTranscript: async () => {
      writes.push("deleted");
    },
  });
  await persistence.initialize();
  persistence.saveTranscript("project", "session", "first");
  persistence.saveTranscript("project", "session", "second");
  await expect(persistence.flush()).rejects.toThrow("disk full");
  expect(persistence.getTranscript("project", "session")).toBe("second");
  fail = false;
  await persistence.flush();
  persistence.saveTranscript("project", "session", null);
  await persistence.flush();
  expect(writes).toEqual(["first", "first", "second", "deleted"]);
});

test("project migration copies a complete snapshot while retaining source data until catalog ACK", async () => {
  const calls: unknown[] = [];
  const { persistence } = fixture({
    readTranscript: async (input) => {
      calls.push(input);
      return { value: "complete history", hasEarlier: false };
    },
    writeTranscript: async (input) => {
      calls.push(input);
    },
    deleteTranscript: async (input) => {
      calls.push({ deleted: input });
    },
  });
  await persistence.initialize();
  persistence.copyTranscript("old.project", "new.project", "session.with.dots");
  await persistence.flush();
  expect(calls).toEqual([
    {
      projectKey: "old.project",
      sessionId: "session.with.dots",
      maxBytes: Number.MAX_SAFE_INTEGER,
    },
    { projectKey: "new.project", sessionId: "session.with.dots", value: "complete history" },
  ]);
});

test("isolates a malformed legacy snapshot while migrating valid records and preserving the bad key", async () => {
  const storage = memoryStorage({
    "codeshell.sessionIndex.project": JSON.stringify(index(row("bad"), row("good"))),
    "codeshell.transcript.project.bad": "{corrupt",
    "codeshell.transcript.project.good": rawSnapshot("recoverable"),
  });
  const writes: string[] = [];
  const { persistence, errors } = fixture(
    {
      writeTranscript: async ({ sessionId }) => {
        writes.push(sessionId);
      },
    },
    storage,
  );
  await persistence.initialize();
  expect(writes).toEqual(["good"]);
  expect(storage.getItem("codeshell.transcript.project.bad")).toBe("{corrupt");
  expect(storage.getItem("codeshell.transcript.project.good")).toBeNull();
  expect(errors).toHaveLength(1);
  await persistence.flush();
});

test("an empty installation acknowledges legacy migration once instead of leaving stale import open", async () => {
  const imports: unknown[] = [];
  const { persistence } = fixture({
    importLegacy: async (indices) => {
      imports.push(indices);
      return snapshot(1, index());
    },
    load: async () => {
      throw new Error("empty migration was skipped");
    },
  });
  await persistence.initialize();
  await persistence.initialize();
  expect(imports).toEqual([{}]);
});

test("a remote deletion does not resurrect an incomplete row from a pending local field edit", async () => {
  const pending = deferred<SessionCatalogSnapshot>();
  const { persistence, changed } = fixture({
    load: async () => snapshot(1, index(row("gone"))),
    apply: () => pending.promise,
  });
  await persistence.initialize();
  persistence.saveIndex("project", index(row("gone", { pinned: true })));
  changed(snapshot(2, index()));
  expect(persistence.getIndex("project").sessions).toEqual([]);
  pending.resolve(snapshot(2, index()));
  await persistence.flush();
  expect(persistence.getIndex("project").sessions).toEqual([]);
});

test("bounds acknowledged snapshot memory while protecting pending and streaming conversations", async () => {
  const write = deferred<void>();
  const { persistence } = fixture({
    writeTranscript: () => write.promise,
    readTranscript: async ({ sessionId }) => ({ value: rawSnapshot(sessionId), hasEarlier: false }),
  });
  await persistence.initialize();
  const streaming = JSON.stringify({
    messages: [{ kind: "assistant", id: "live", done: false }],
    streamingAssistantId: "live",
  });
  persistence.saveTranscript("project", "pending", streaming);
  for (let id = 0; id < 25; id += 1) await persistence.readTranscript("project", `saved-${id}`);
  expect(persistence.getTranscript("project", "saved-0")).toBeNull();
  expect(persistence.getTranscript("project", "saved-24")).toBe(rawSnapshot("saved-24"));
  expect(persistence.getTranscript("project", "pending")).toBe(streaming);
  write.resolve();
  await persistence.flush();
  expect(persistence.getTranscript("project", "pending")).toBe(streaming);
});

test("a failed project snapshot copy leaves the source available and rejects flush", async () => {
  const { persistence } = fixture({
    readTranscript: async () => ({ value: rawSnapshot("source"), hasEarlier: false }),
    writeTranscript: async () => {
      throw new Error("target unavailable");
    },
    deleteTranscript: async () => {
      throw new Error("source must not be deleted");
    },
  });
  await persistence.initialize();
  await persistence.readTranscript("old", "session");
  persistence.copyTranscript("old", "new", "session");
  await expect(persistence.flush()).rejects.toThrow("target unavailable");
  expect(persistence.getTranscript("old", "session")).toBe(rawSnapshot("source"));
});

test("flush drains events before snapshot readers and waits for their durable writes", async () => {
  const written = deferred<void>();
  const writes: string[] = [];
  const { persistence } = fixture({
    writeTranscript: async ({ value }) => {
      writes.push(value);
      await written.promise;
    },
  });
  const order: string[] = [];
  let text = "before event drain";
  const unsubscribe = persistence.subscribeBeforeFlush(() => {
    order.push("snapshot");
    persistence.saveTranscript("project", "session", rawSnapshot(text));
  });
  persistence.subscribeBeforeFlush(() => {
    order.push("events");
    text = "final coalesced text";
  }, "events");
  let settled = false;
  const flushing = persistence.flush().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(order).toEqual(["events", "snapshot"]);
  expect(writes).toEqual([rawSnapshot("final coalesced text")]);
  expect(settled).toBe(false);
  written.resolve();
  await flushing;
  unsubscribe();
  await persistence.flush();
  expect(order).toEqual(["events", "snapshot", "events"]);
});

test.each([
  ["commits catalog only after snapshot copy and deletes source last", false],
  ["keeps the old catalog when snapshot copying fails", true],
] as const)("project migration %s", async (_label, failCopy) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const source = row("session", { engineSessionId: "engine" });
  const copyRead = deferred<{ value: string | null; hasEarlier: boolean }>();
  const operations: string[] = [];
  let canonical: SessionCatalogSnapshot = { revision: 1, indices: { old: index(source) } };
  const storage = memoryStorage();
  const { api } = fixture(
    {
      load: async () => canonical,
      readTranscript: async () => {
        operations.push("read");
        return copyRead.promise;
      },
      writeTranscript: async () => {
        operations.push("copy");
        if (failCopy) throw new Error("copy failed");
      },
      deleteTranscript: async () => {
        operations.push("delete");
      },
      apply: async (patch) => {
        operations.push(`catalog:${patch.projectKey}`);
        canonical = {
          revision: canonical.revision + 1,
          indices: {
            ...canonical.indices,
            [patch.projectKey]: patch.projectKey === "new" ? index(source) : index(),
          },
        };
        return canonical;
      },
    },
    storage,
  );
  Object.defineProperty(globalThis, "window", {
    value: { codeshell: { sessionCatalog: api, log: () => undefined } },
    configurable: true,
  });
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  try {
    await initializeSessionPersistence();
    const migration = migrateProjectSessionBucket("old", "new");
    expect(operations).toEqual(["read"]);
    expect(loadSessionIndex("old")).toEqual(index(source));
    expect(loadSessionIndex("new")).toEqual(index());
    copyRead.resolve({ value: rawSnapshot("all source history"), hasEarlier: false });
    if (failCopy) {
      await expect(migration).rejects.toThrow("copy failed");
      expect(operations).toEqual(["read", "copy"]);
      expect(loadSessionIndex("old")).toEqual(index(source));
      expect(loadSessionIndex("new")).toEqual(index());
    } else {
      await migration;
      expect(operations).toEqual(["read", "copy", "catalog:new", "catalog:old", "delete"]);
      expect(loadSessionIndex("old")).toEqual(index());
      expect(loadSessionIndex("new")).toEqual(index(source));
    }
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as Record<string, unknown>).window;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as Record<string, unknown>).localStorage;
  }
});
