import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import type { SessionState } from "../../types.js";
import { AsyncFixtureStorage } from "./async-storage.js";
import { AsyncJournalReader } from "./async-journal.js";
import {
  AsyncFixtureCustody,
  assertAsyncJournalSnapshot,
  closeAsyncFile,
  openAsyncJournal,
  snapshotAsyncJournal,
  type AsyncJournalSnapshot,
} from "./async-io.js";
import {
  canonical,
  canonicalSteps,
  decodeStateBytes,
  digest,
  encodeState,
  goalEffect,
  parseUnique,
  type DecodedState,
} from "./codec.js";
import {
  AsyncIdentityIndex,
  IdentityPool,
  INDEX_BYTES,
  INDEX_SLOTS,
  MAX_IDENTITIES,
} from "./id-index.js";
import { createFixtureRoot, FixtureCustody, JOURNAL_LIMIT, RECORD_LIMIT } from "./io.js";
import { encodeRecord, evaluateJournalStep, projection, verifyJournalSteps } from "./journal.js";
import type { FixtureIOHooks } from "./lease-fs.js";
import { FixtureStorage, type Stage } from "./storage.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const root = createFixtureRoot();
  const sessionId = "async-history";
  const directory = join(root, sessionId);
  mkdirSync(directory, { mode: 0o700 });
  const header = JSON.stringify({
    version: 1,
    storageScope: digest(root),
    sessionIncarnation: randomUUID(),
    journalId: randomUUID(),
    sessionId,
    startedAt: 123,
  });
  const state: DecodedState = {
    state: {
      sessionId,
      cwd: "/fixture",
      startedAt: 123,
      stateRevision: 1,
      outputJournalIdentity: digest(header + "\n"),
      workspaceProfile: "profile-kept",
    } as SessionState,
  };
  const statePath = join(directory, "state.json");
  const journalPath = join(directory, "output-journal.jsonl");
  writeFileSync(statePath, encodeState(state));
  writeFileSync(journalPath, header + "\n");
  const pool = new IdentityPool();
  const sync = () => new FixtureStorage(root, sessionId, pool);
  const asyncStorage = (hooks?: FixtureIOHooks) =>
    AsyncFixtureStorage.create(root, sessionId, pool, hooks);
  return {
    root,
    sessionId,
    directory,
    header,
    state,
    statePath,
    journalPath,
    pool,
    sync,
    asyncStorage,
  };
}
const notice = { kind: "host_notice", source: "automation", invocationId: "fixture-invocation" };
const control = (id: string) => ({ kind: "control", operation: "goal", operationId: id });
function prepare(f: ReturnType<typeof fixture>) {
  const sync = f.sync();
  sync.transition();
  return sync;
}
function proofAbsent(storage: AsyncFixtureStorage) {
  expect((storage as unknown as { verified?: unknown }).verified).toBeUndefined();
  expect(
    (storage as unknown as { index: { authenticatedStamp?: string } }).index.authenticatedStamp,
  ).toBeUndefined();
}

// Private marker fixtures; no production Session or provider is opened by these tests.
describe("whole-history async fixture storage", () => {
  test("cold and cached inspection preserve exact identity, original cursors and no-run scopes", async () => {
    const f = fixture();
    const sync = prepare(f);
    const event = { type: "error", message: "notice" };
    const receipt = sync.append("notice-one", notice, event);
    const proof = sync.inspect();
    sync.dispose();
    const storage = await f.asyncStorage();
    expect(await storage.inspect()).toEqual(proof);
    expect(await storage.inspect()).toEqual(proof);
    expect(await storage.lookup("notice-one", projection(notice, event, null))).toEqual({
      cursor: receipt.cursor,
      replayed: true,
    });
    expect(await storage.lookup("absent", digest("absent"))).toBeUndefined();
    await expect(storage.lookup("notice-one", digest("different"))).rejects.toThrow(
      "different projection",
    );
    proofAbsent(storage);
    expect(await storage.inspect()).toEqual(proof);
    await storage.dispose();
  });
  test("fragment assembly and two controls cold-compare latest state only, exact old receipt remains addressable", async () => {
    const f = fixture();
    const sync = prepare(f);
    const first = sync.control("first", control("first"), { id: "first" }, null, 1);
    const event = { type: "text_delta", text: '😀\\"\n'.repeat(40000) };
    const last = sync.control("last", control("last"), { id: "last" }, event, 2);
    const proof = sync.inspect();
    sync.dispose();
    const storage = await f.asyncStorage();
    expect(await storage.inspect()).toEqual(proof);
    expect(
      await storage.lookup(
        "first",
        projection(
          control("first"),
          null,
          goalEffect({ goalLifecycle: { id: "first" } } as unknown as SessionState),
        ),
      ),
    ).toEqual({ cursor: first.cursor, replayed: true });
    expect(
      await storage.lookup(
        "last",
        projection(
          control("last"),
          event,
          goalEffect({ goalLifecycle: { id: "last" } } as unknown as SessionState),
        ),
      ),
    ).toEqual({ cursor: last.cursor, replayed: true });
    await storage.dispose();
  });
  test("legacy duplicate keys and depth beyond v2 limit preserve original native JSON.parse/hash semantics", async () => {
    const f = fixture();
    let nested: unknown = "leaf";
    for (let i = 0; i < 160; i++) nested = { nested };
    const value = {
      sequence: 1,
      previousHash: f.state.state.outputJournalIdentity,
      runId: "original",
      event: { type: "legacy", data: nested, label: "last" },
    };
    const line = JSON.stringify({ ...value, hash: digest(JSON.stringify(value)) }).replace(
      '"label":"last"',
      '"label":"first","label":"last"',
    );
    expect(JSON.parse(line).event.label).toBe("last");
    expect(() => parseUnique(line, RECORD_LIMIT)).toThrow();
    appendFileSync(f.journalPath, line + "\n");
    const sync = f.sync();
    const proof = sync.inspect();
    sync.dispose();
    const storage = await f.asyncStorage();
    expect(await storage.inspect()).toEqual(proof);
    expect(proof.head.sequence).toBe(1);
    await storage.dispose();
  });
  test("a complete legacy record at the exact 256 KiB boundary retains its LF and cursor", async () => {
    const f = fixture();
    const base = {
      sequence: 1,
      previousHash: f.state.state.outputJournalIdentity,
      runId: "legacy",
      event: { type: "text", text: "" },
    };
    const overhead = Buffer.byteLength(
      JSON.stringify({ ...base, hash: digest(JSON.stringify(base)) }),
    );
    base.event.text = "x".repeat(RECORD_LIMIT - overhead);
    const line = JSON.stringify({ ...base, hash: digest(JSON.stringify(base)) });
    expect(Buffer.byteLength(line)).toBe(RECORD_LIMIT);
    appendFileSync(f.journalPath, line + "\n");
    const sync = f.sync();
    const proof = sync.inspect();
    sync.dispose();
    const storage = await f.asyncStorage();
    expect(await storage.inspect()).toEqual(proof);
    expect(proof.head.offset).toBe(Buffer.byteLength(f.header + "\n") + RECORD_LIMIT + 1);
    await storage.dispose();
  });
  test("a second valid chained record with the same committed id is not an identity miss", async () => {
    const f = fixture();
    const sync = prepare(f);
    const event = { type: "text", text: "first" };
    sync.append("duplicate", notice, event);
    const proof = sync.inspect();
    sync.dispose();
    const record = encodeRecord(proof.head, {
      kind: "event",
      eventId: "duplicate",
      scope: notice,
      projectionDigest: projection(notice, event, null),
      event,
    });
    appendFileSync(f.journalPath, record.bytes);
    const before = readFileSync(f.journalPath);
    const storage = await f.asyncStorage();
    await expect(storage.inspect()).rejects.toThrow("Duplicate");
    proofAbsent(storage);
    expect(readFileSync(f.journalPath)).toEqual(before);
    await storage.dispose();
  });
  test("cleanup failure after a complete candidate cannot publish a proof or release the path fence", async () => {
    const f = fixture();
    let armed = true;
    const storage = await f.asyncStorage({
      async afterNative(operation) {
        if (armed && operation === "lock.rmdir") {
          armed = false;
          throw new Error("injected unlock completion failure");
        }
      },
    });
    await expect(storage.inspect()).rejects.toThrow("unlock completion");
    proofAbsent(storage);
    await expect(storage.dispose()).rejects.toThrow("unlock completion");
    expect(f.pool.bytes).toBe(0);
    expect(() => new FixtureCustody(f.root, f.sessionId).withLease(() => {})).toThrow(
      "Synchronous",
    );
  });
  test("index allocation failure settles custody and releases only its healthy temporary path claim", async () => {
    const f = fixture();
    const a = new AsyncIdentityIndex(f.pool);
    const b = new AsyncIdentityIndex(f.pool);
    await expect(f.asyncStorage()).rejects.toThrow("pool exhausted");
    expect(f.pool.bytes).toBe(2 * INDEX_BYTES);
    expect(() => new FixtureCustody(f.root, f.sessionId).withLease(() => {})).not.toThrow();
    await a.dispose();
    await b.dispose();
  });
  test("legacy cached proof cannot survive a removed or replaced current state pin with unchanged journal", async () => {
    const f = fixture();
    const storage = await f.asyncStorage();
    const proof = await storage.inspect();
    const original = readFileSync(f.statePath);
    const journal = readFileSync(f.journalPath);
    for (const pin of [undefined, digest("replaced")]) {
      const decoded = decodeStateBytes(original);
      decoded.state.outputJournalIdentity = pin;
      writeFileSync(f.statePath, encodeState(decoded));
      await expect(storage.inspect()).rejects.toThrow("pin");
      proofAbsent(storage);
      expect(readFileSync(f.journalPath)).toEqual(journal);
      writeFileSync(f.statePath, original);
      expect(await storage.inspect()).toEqual(proof);
    }
    await storage.dispose();
  });
  for (const stage of ["begin", "pending_state", "prepared", "final_state"] as Stage[]) {
    test(`unclosed ${stage} is incomplete and leaves every journal/state byte intact`, async () => {
      const f = fixture();
      const sync = prepare(f);
      expect(() =>
        sync.control(
          "interrupted",
          control("interrupted"),
          { id: "interrupted" },
          { type: "goal" },
          1,
          (current) => {
            if (current === stage) throw new Error("fixture interruption");
          },
        ),
      ).toThrow("interruption");
      sync.dispose();
      const state = readFileSync(f.statePath);
      const journal = readFileSync(f.journalPath);
      const storage = await f.asyncStorage();
      await expect(storage.inspect()).rejects.toThrow();
      proofAbsent(storage);
      expect(readFileSync(f.statePath)).toEqual(state);
      expect(readFileSync(f.journalPath)).toEqual(journal);
      await storage.dispose();
    });
  }
  test("full scan rejects an early prefix corruption even with a valid-looking final record", async () => {
    const f = fixture();
    const sync = prepare(f);
    for (let i = 0; i < 12; i++)
      sync.append(`event-${i}`, notice, { type: "text_delta", text: "x".repeat(12000) });
    sync.dispose();
    const bytes = readFileSync(f.journalPath);
    const at = bytes.indexOf(Buffer.from('"text":"'));
    expect(at).toBeGreaterThan(0);
    bytes[at + 8] = 0x79;
    writeFileSync(f.journalPath, bytes);
    const storage = await f.asyncStorage();
    await expect(storage.inspect()).rejects.toThrow();
    proofAbsent(storage);
    expect(readFileSync(f.journalPath)).toEqual(bytes);
    await storage.dispose();
  });
  test("oversized journal preflight, partial tail and invalid UTF8 never repair bytes", async () => {
    for (const mode of ["oversized", "partial", "utf8", "record"] as const) {
      const f = fixture();
      if (mode === "oversized") truncateSync(f.journalPath, JOURNAL_LIMIT + 1);
      if (mode === "partial") appendFileSync(f.journalPath, '{"recordVersion":2');
      if (mode === "utf8") appendFileSync(f.journalPath, Buffer.from([0xff, 10]));
      if (mode === "record") appendFileSync(f.journalPath, "x".repeat(RECORD_LIMIT + 1) + "\n");
      const storage = await f.asyncStorage();
      await expect(storage.inspect()).rejects.toThrow();
      proofAbsent(storage);
      // The oversized fixture is sparse; avoid materializing 128 MiB merely to assert no repair.
      if (mode !== "oversized")
        expect(readFileSync(f.journalPath).at(-1)).toBe(mode === "partial" ? 0x32 : 0x0a);
      await storage.dispose();
    }
  });
  test("macrotask CPU yield permits a scheduled observer and cancellation invalidates the candidate", async () => {
    const f = fixture();
    const sync = prepare(f);
    sync.append("large", notice, { type: "text_delta", text: "x".repeat(400000) });
    sync.dispose();
    const controller = new AbortController();
    let yields = 0;
    let scheduled = false;
    const storage = await f.asyncStorage({
      observe(event) {
        if (event.operation === "scanner.cpu_yield") {
          yields++;
          if (yields === 2) controller.abort();
        }
      },
    });
    const task = immediate().then(() => {
      scheduled = true;
    });
    await expect(storage.inspect({ signal: controller.signal })).rejects.toThrow();
    await task;
    expect(scheduled).toBe(true);
    expect(yields).toBeGreaterThanOrEqual(2);
    proofAbsent(storage);
    expect((await storage.inspect()).head.sequence).toBeGreaterThan(1);
    await storage.dispose();
  });
  test("journal stamp mutation during awaited scan is rejected, including cached reuse afterwards", async () => {
    const f = fixture();
    const sync = prepare(f);
    sync.append("event", notice, { type: "text", text: "hello" });
    sync.dispose();
    const original = readFileSync(f.journalPath);
    let armed = true;
    const storage = await f.asyncStorage({
      observe(event) {
        if (armed && event.operation === "scanner.cpu_yield") {
          armed = false;
          appendFileSync(f.journalPath, " ");
        }
      },
    });
    await expect(storage.inspect()).rejects.toThrow("changed");
    proofAbsent(storage);
    writeFileSync(f.journalPath, original);
    await expect(storage.inspect()).rejects.toThrow("changed");
    await expect(f.asyncStorage()).rejects.toThrow("changed");
    await storage.dispose();
    expect(() => new FixtureCustody(f.root, f.sessionId).withLease(() => {})).toThrow(
      "Synchronous",
    );
  });
  test("dispose closes admission but waits for an actual pending read before returning its arena and sync path", async () => {
    const f = fixture();
    const entered = deferred();
    const finish = deferred();
    let armed = true;
    const storage = await f.asyncStorage({
      async afterNative(operation) {
        if (armed && operation === "journal.read") {
          armed = false;
          entered.resolve();
          await finish.promise;
        }
      },
    });
    const work = storage.inspect();
    void work.catch(() => {});
    await entered.promise;
    const disposal = storage.dispose();
    let settled = false;
    void disposal.then(() => {
      settled = true;
    });
    await immediate();
    expect(settled).toBe(false);
    expect(f.pool.bytes).toBe(INDEX_BYTES);
    await expect(storage.inspect()).rejects.toThrow("disposed");
    expect(() => new FixtureCustody(f.root, f.sessionId).withLease(() => {})).toThrow(
      "Synchronous",
    );
    finish.resolve();
    await work;
    await disposal;
    expect(f.pool.bytes).toBe(0);
    expect(() => new FixtureCustody(f.root, f.sessionId).withLease(() => {})).not.toThrow();
  });
  test("outer close failure invalidates proof and failed cleanup keeps the sync path fenced", async () => {
    const f = fixture();
    let armed = false;
    const storage = await f.asyncStorage({
      faultBefore(operation) {
        if (armed && operation === "file.close") {
          armed = false;
          return new Error("injected close failure");
        }
      },
    });
    armed = true;
    await expect(storage.inspect()).rejects.toThrow("close failure");
    proofAbsent(storage);
    await expect(storage.dispose()).rejects.toThrow("close failure");
    expect(f.pool.bytes).toBe(0);
    expect(() => new FixtureCustody(f.root, f.sessionId).withLease(() => {})).toThrow(
      "Synchronous",
    );
  });
  test("Session deletion observed at CPU resumption cannot recreate the directory or publish proof", async () => {
    const f = fixture();
    let armed = true;
    const storage = await f.asyncStorage({
      observe(event) {
        if (armed && event.operation === "scanner.cpu_yield") {
          armed = false;
          renameSync(f.directory, f.directory + "-deleted");
        }
      },
    });
    await expect(storage.inspect()).rejects.toThrow();
    proofAbsent(storage);
    await expect(storage.dispose()).rejects.toThrow();
    expect(() => readFileSync(f.statePath)).toThrow();
    rmSync(f.directory + "-deleted", { recursive: true });
  });
});

describe("opaque async snapshot and shared CPU codec", () => {
  test("snapshot is bound to the current native lease and file and rejects clones and changed stamp", async () => {
    const f = fixture();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    let saved: AsyncJournalSnapshot | undefined;
    await expect(
      custody.withLease(async (lease) => {
        const file = await openAsyncJournal(lease);
        const other = await openAsyncJournal(lease);
        saved = await snapshotAsyncJournal(lease, file);
        expect(() => assertAsyncJournalSnapshot(lease, file, { ...saved! })).toThrow();
        expect(() => assertAsyncJournalSnapshot(lease, other, saved!)).toThrow();
        await assertAsyncJournalSnapshot(lease, file, saved);
        appendFileSync(f.journalPath, " ");
        await expect(assertAsyncJournalSnapshot(lease, file, saved)).rejects.toThrow("changed");
        // The retained submitted-I/O failure prevents any further lease primitive from succeeding.
      }),
    ).rejects.toThrow("changed");
    await custody.dispose();
    expect(Object.isFrozen(saved)).toBe(true);
  });
  test("synthetic large inode identity preserves the old Number projection without changing exact custody stamps", () => {
    const f = fixture();
    const huge = "9007199254740993";
    const steps = verifyJournalSteps(
      f.root,
      { dev: "1", ino: huge },
      { dev: "2", ino: huge },
      Buffer.byteLength(f.header + "\n"),
      "exact-bigint-stamp",
      f.state,
    );
    let first = true;
    let next = steps.next();
    while (!next.done) {
      const step = next.value;
      if (step.kind === "line") {
        next = steps.next(
          first ? { text: f.header, start: 0, end: Buffer.byteLength(f.header + "\n") } : undefined,
        );
        first = false;
      } else if (step.kind === "add") throw new Error("Unexpected identity add");
      else next = steps.next(evaluateJournalStep(step));
    }
    const legacy = digest(`${digest(f.root)}\n${f.header}\n1:${Number(huge)}\n2:${Number(huge)}`);
    expect(next.value.identity).toBe(legacy);
    expect(next.value.fileStamp).toBe("exact-bigint-stamp");
  });
  test("chunked strings exactly match native JSON.stringify across escape and surrogate boundaries", () => {
    const strings = [
      "",
      "\ud800",
      "\udc00",
      "\ud800\udc00",
      "x".repeat(8191) + "😀",
      "x".repeat(16382) + '\\"\u0000😀\n' + "z".repeat(17000),
    ];
    for (const value of strings) {
      const expected = JSON.stringify(value);
      expect([...canonicalSteps(value)].join("")).toBe(expected);
      expect(parseUnique(expected)).toBe(value);
    }
    expect(canonical(JSON.parse('{"z":1,"a":2,"__proto__":3}'))).toBe(
      '{"__proto__":3,"a":2,"z":1}',
    );
  });
  test("async parsing/canonical hashing preserve native JSON escaping, unicode and prototype-key bytes", async () => {
    const f = fixture();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    const values = [
      JSON.parse('{"__proto__":{"safe":true},"constructor":1,"n":-0}'),
      {
        text: "a".repeat(8191) + '😀\u0000\n\\"' + "z".repeat(9000),
        array: [true, false, null, -0, 0.001],
      },
    ];
    await custody.withLease(async (lease) => {
      const file = await openAsyncJournal(lease);
      const reader = new AsyncJournalReader(lease, file, await snapshotAsyncJournal(lease, file));
      for (const value of values) {
        const expected = canonical(value);
        expect([...canonicalSteps(value)].join("")).toBe(expected);
        expect(await reader.parse(expected, 100000)).toEqual(JSON.parse(expected));
        expect(await reader.cpu({ kind: "canonical", value })).toBe(expected);
        expect(await reader.cpu({ kind: "digestCanonical", value })).toBe(digest(expected));
      }
      for (const invalid of ['{"a":1,"a":2}', "[1,]", '{"a":1}x', '"\\uD800"x', "1e999", '"bad\n"'])
        await expect(reader.parse(invalid, 100000)).rejects.toThrow();
      await closeAsyncFile(lease, file);
    });
    await custody.dispose();
  });
});

class CollisionIndex extends AsyncIdentityIndex {
  seed(eventId: string, count: number, equal: boolean) {
    const hash = createHash("sha256").update(eventId).digest();
    const start = hash.readUInt32LE(0) & (INDEX_SLOTS - 1);
    for (let i = 0; i < count; i++) {
      const slot = (start + i) & (INDEX_SLOTS - 1);
      this.occupied[slot] = 1;
      this.keys.set(equal ? hash : Buffer.alloc(32, 0xff), slot * 32);
      this.bindingOffsets[slot] = i;
    }
  }
  capacity() {
    this.size = MAX_IDENTITIES;
  }
}
const receipt = { sequence: 1, offset: 100, bindingOffset: 20 };
describe("complete async identity proof lifetime", () => {
  test("exact awaited id returns the original receipt, duplicates/conflicts never become misses", async () => {
    const index = new AsyncIdentityIndex(new IdentityPool());
    await index.addVerified("event", digest("projection"), receipt, async () => "event");
    index.authenticate("stamp");
    expect(
      await index.lookup("event", digest("projection"), "stamp", async () => {
        await immediate();
        return "event";
      }),
    ).toEqual(receipt);
    await expect(
      index.lookup("event", digest("other"), "stamp", async () => "event"),
    ).rejects.toThrow("different projection");
    expect(index.isAuthenticated("stamp")).toBe(false);
    index.authenticate("stamp");
    await expect(
      index.addVerified("event", digest("projection"), receipt, async () => "event"),
    ).rejects.toThrow("Duplicate");
    await index.dispose();
  });
  test("synchronous reader reentry is busy and disposal cannot return the arena before its read settles", async () => {
    const pool = new IdentityPool();
    const index = new AsyncIdentityIndex(pool);
    await index.addVerified("event", digest("projection"), receipt, async () => "event");
    index.authenticate("stamp");
    const gate = deferred();
    const started = deferred();
    let reentry: Promise<unknown> | undefined;
    let disposal: Promise<void> | undefined;
    const work = index.lookup("event", digest("projection"), "stamp", () => {
      reentry = index.lookup("event", digest("projection"), "stamp", async () => "event");
      void reentry.catch(() => {});
      disposal = index.dispose();
      started.resolve();
      return gate.promise.then(() => "event");
    });
    void work.catch(() => {});
    await started.promise;
    await expect(reentry!).rejects.toThrow("progress");
    expect(pool.bytes).toBe(INDEX_BYTES);
    let settled = false;
    void disposal!.then(() => {
      settled = true;
    });
    await immediate();
    expect(settled).toBe(false);
    gate.resolve();
    await expect(work).rejects.toThrow("lifetime");
    await disposal;
    expect(pool.bytes).toBe(0);
  });
  test("invalidation during a binding await discards the result and requires rebuild", async () => {
    const index = new AsyncIdentityIndex(new IdentityPool());
    await index.addVerified("event", digest("projection"), receipt, async () => "event");
    index.authenticate("stamp");
    await expect(
      index.lookup("event", digest("projection"), "stamp", async () => {
        index.invalidate();
        await immediate();
        return "event";
      }),
    ).rejects.toThrow("lifetime");
    await expect(
      index.lookup("event", digest("projection"), "stamp", async () => "event"),
    ).rejects.toThrow("rebuild");
    await index.dispose();
  });
  test("64 probes, four exact binding reads and total identity capacity remain fixed bounds", async () => {
    for (const mode of ["probe", "hash", "capacity"] as const) {
      const index = new CollisionIndex(new IdentityPool());
      let reads = 0;
      if (mode === "probe") index.seed("target", 64, false);
      if (mode === "hash") index.seed("target", 5, true);
      if (mode === "capacity") index.capacity();
      index.authenticate("stamp");
      if (mode === "capacity")
        await expect(
          index.addVerified("target", digest("p"), receipt, async () => "elsewhere"),
        ).rejects.toThrow("capacity");
      else
        await expect(
          index.lookup("target", digest("p"), "stamp", async () => {
            reads++;
            await immediate();
            return "elsewhere";
          }),
        ).rejects.toThrow(mode === "probe" ? "probe bound" : "collision bound");
      expect(reads).toBe(mode === "hash" ? 4 : 0);
      expect(index.isAuthenticated("stamp")).toBe(false);
      await index.dispose();
    }
  });
  test("receipt accessors and proxies are rejected before reading caller fields", async () => {
    const index = new AsyncIdentityIndex(new IdentityPool());
    let reads = 0;
    const bad = {
      get sequence() {
        reads++;
        return 1;
      },
      offset: 100,
      bindingOffset: 20,
    };
    await expect(index.addVerified("event", digest("p"), bad, async () => "event")).rejects.toThrow(
      "Owned",
    );
    await expect(
      index.addVerified(
        "event",
        digest("p"),
        new Proxy(receipt, {
          get() {
            reads++;
            return 1;
          },
        }),
        async () => "event",
      ),
    ).rejects.toThrow("Owned");
    expect(reads).toBe(0);
    await index.dispose();
  });
});
