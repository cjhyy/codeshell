import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import type { SessionState } from "../../types.js";
import { AsyncFixtureStorage } from "./async-storage.js";
import {
  AsyncFixtureCustody,
  appendPreparedRecordGroup,
  createWriterFacts,
  openAsyncJournal,
  prepareAsyncRecordGroup,
  prepareAsyncState,
  preparedGroupHead,
  captureOwnedJSON,
  readAsyncStateUnderLease,
  readWriterFacts,
  writePreparedAsyncStateUnderLease,
} from "./async-io.js";
import { onlyCancellation, WriterCancellation, WriterFailure } from "./async-writer.js";
import { canonical, decodeStateBytes, digest, encodeState, type DecodedState } from "./codec.js";
import {
  AsyncIdentityIndex,
  CompleteIdentityIndex,
  IdentityPool,
  MAX_IDENTITIES,
} from "./id-index.js";
import { createFixtureRoot, EVENT_LIMIT, JOURNAL_LIMIT, RECORD_LIMIT } from "./io.js";
import { encodeRecord, projection, token, verifyJournal } from "./journal.js";
import type { FixtureIOHooks } from "./lease-fs.js";
import * as fixtureReservations from "./lease-fs.js";
import { FixtureStorage } from "./storage.js";
import type { Receipt } from "./storage.js";

const storages = new Set<AsyncFixtureStorage>();
const expectedCleanupFailures = new Set<AsyncFixtureStorage>();
afterEach(async () => {
  const list = [...storages];
  storages.clear();
  const results = await Promise.allSettled(list.map((storage) => storage.dispose()));
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "rejected" && !expectedCleanupFailures.has(list[i]))
      throw (results[i] as PromiseRejectedResult).reason;
  }
  expectedCleanupFailures.clear();
});

const notice = { kind: "host_notice", source: "automation", invocationId: "writer-fixture" };
const goalScope = { kind: "control", operation: "goal", operationId: "goal-fixture" };

test("readonly reservation observation survives sticky writer failure and disposal", async () => {
  expect(typeof fixtureReservations.isPathReserved).toBe("function");
  const f = fixture(),
    primary = new Error("reservation-stage-fault"),
    entered = deferred(),
    gate = deferred();
  let active = false;
  const s = await f.writer({
    afterNative: async (name) => {
      if (active && name === "writer.stage.append") {
        entered.resolve();
        await gate.promise;
        throw primary;
      }
    },
  });
  await s.transition();
  active = true;
  const work = rejection(s.append("reservation-sticky", notice, { type: "notice" }));
  try {
    await entered.promise;
    expect(fixtureReservations.isPathReserved(f.statePath)).toBe(true);
    let disposed = false;
    const disposal = s.dispose().then(() => {
      disposed = true;
    });
    await immediate();
    expect(disposed).toBe(false);
    expect(fixtureReservations.isPathReserved(f.statePath)).toBe(true);
    gate.resolve();
    const cause = await work;
    expect(cause).toBeInstanceOf(WriterFailure);
    expect(leaves(cause)).toContain(primary);
    await disposal;
    expect(fixtureReservations.isPathReserved(f.statePath)).toBe(false);
    let refused: unknown;
    try {
      fixtureReservations.reservePath(f.statePath);
    } catch (cause) {
      refused = cause;
    }
    expect(refused).toBe(primary);
    expect(fixtureReservations.isPathReserved(f.statePath)).toBe(false);
  } finally {
    gate.resolve();
  }
});

test("readonly reservation observation keeps DOM cause classification separate from admission", async () => {
  expect(typeof fixtureReservations.isPathReserved).toBe("function");
  const f = fixture(),
    primary = new Error("healthy-admission-non-abort-cause"),
    abort = Object.assign(new DOMException("fixture", "AbortError"), { cause: primary });
  let active = false;
  const s = await f.writer({
    afterNative: (name) => {
      if (active && name === "writer.stage.append") throw abort;
    },
  });
  await s.transition();
  active = true;
  const cause = await rejection(s.append("reservation-dom-cause", notice, { type: "notice" }));
  expect(cause).toBeInstanceOf(WriterFailure);
  expect(leaves(cause)).toContain(abort);
  await s.dispose();
  expect(fixtureReservations.isPathReserved(f.statePath)).toBe(false);
  expect(fixtureReservations.reservePath(f.statePath)).toBe(true);
  expect(fixtureReservations.isPathReserved(f.statePath)).toBe(true);
  fixtureReservations.releasePath(f.statePath);
  expect(fixtureReservations.isPathReserved(f.statePath)).toBe(false);
});

function fixture() {
  const root = createFixtureRoot(),
    sessionId = "async-writer",
    directory = join(root, sessionId);
  mkdirSync(directory);
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
      workspaceProfile: "kept",
      outputJournalIdentity: digest(header + "\n"),
    } as SessionState,
  };
  const statePath = join(directory, "state.json"),
    journalPath = join(directory, "output-journal.jsonl");
  writeFileSync(statePath, encodeState(state));
  writeFileSync(journalPath, header + "\n");
  const pool = new IdentityPool();
  return {
    root,
    sessionId,
    directory,
    statePath,
    journalPath,
    pool,
    writer: async (hooks: FixtureIOHooks = {}) => {
      const s = await AsyncFixtureStorage.create(root, sessionId, pool, hooks);
      storages.add(s);
      return s;
    },
    state: () => decodeStateBytes(readFileSync(statePath)),
    bytes: () => readFileSync(journalPath),
    cold: () => {
      const index = new CompleteIdentityIndex(pool),
        fd = openSync(journalPath, "r");
      try {
        return verifyJournal(
          fd,
          root,
          lstatSync(directory),
          decodeStateBytes(readFileSync(statePath)),
          index,
        );
      } finally {
        closeSync(fd);
        index.dispose();
      }
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function leaves(cause: unknown, seen = new Set<unknown>()): unknown[] {
  if (seen.has(cause)) return [];
  seen.add(cause);
  if (cause instanceof AggregateError)
    return [
      cause,
      ...cause.errors.flatMap((item) => leaves(item, seen)),
      ...(Object.hasOwn(cause, "cause") ? leaves(cause.cause, seen) : []),
    ];
  return [cause];
}
async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    throw new Error("Expected rejection");
  } catch (cause) {
    return cause;
  }
}

describe("marker-only complete async writer", () => {
  test("nonenumerable array decoration is refused before capture or writer mutation", async () => {
    const f = fixture(),
      s = await f.writer();
    await s.transition();
    const before = f.bytes();
    const decorated = Object.defineProperty([1], "extra", { value: 2 });
    await expect(
      s.append("decorated", notice, { type: "notice", data: decorated }),
    ).rejects.toThrow("decorated");
    expect(() => captureOwnedJSON({ scope: decorated })).toThrow("decorated");
    expect(f.bytes()).toEqual(before);
    await s.dispose();
  });
  test("transition, whole event replay, two Goal controls and no-display commit cold-roundtrip", async () => {
    const f = fixture(),
      s = await f.writer();
    const transition = await s.transition();
    expect(await s.transition()).toBe(transition);
    const e = { type: "error", message: "notice" },
      first = await s.append("first", notice, e);
    expect(await s.append("first", notice, e)).toEqual({ ...first, replayed: true });
    await expect(s.append("first", notice, { ...e, message: "other" })).rejects.toThrow(
      "different projection",
    );
    const a = await s.control("goal-a", goalScope, { id: "a" }, null, 1);
    const b = await s.control(
      "goal-b",
      goalScope,
      { id: "b" },
      { type: "text_delta", text: "x".repeat(100000) },
      2,
    );
    const proof = await s.inspect();
    expect(proof.head.sequence).toBeGreaterThan(5);
    expect(await s.control("goal-a", goalScope, { id: "a" }, null, 1)).toEqual({
      ...a,
      replayed: true,
    });
    expect(f.state().state.workspaceProfile).toBe("kept");
    expect(f.state().control?.lastCommitted?.eventId).toBe("goal-b");
    await s.dispose();
    expect(f.cold()).toEqual(proof);
    const sync = new FixtureStorage(f.root, f.sessionId, f.pool);
    expect(
      sync.control(
        "goal-b",
        goalScope,
        { id: "b" },
        { type: "text_delta", text: "x".repeat(100000) },
        2,
      ),
    ).toEqual({ ...b, replayed: true });
    sync.dispose();
  });
  for (const field of ["scope", "event", "goal"] as const)
    test(`${field} accessors/Proxy reject before field reads or protected mutation`, async () => {
      const f = fixture(),
        s = await f.writer();
      await s.transition();
      const before = f.bytes();
      let reads = 0;
      const bad =
        field === "scope"
          ? {
              get kind() {
                reads++;
                return "control";
              },
            }
          : {
              get type() {
                reads++;
                return "notice";
              },
            };
      const args = [
        field === "scope" ? bad : goalScope,
        field === "goal" ? bad : {},
        field === "event" ? bad : null,
      ] as const;
      await expect(
        s.control("bad", args[0] as typeof goalScope, args[1], args[2], 1),
      ).rejects.toThrow("Accessor");
      const proxy = new Proxy(
        {},
        {
          get() {
            reads++;
            return "bad";
          },
          ownKeys() {
            reads++;
            return [];
          },
        },
      );
      await expect(
        s.control(
          "proxy",
          field === "scope" ? (proxy as typeof goalScope) : goalScope,
          field === "goal" ? proxy : {},
          field === "event" ? proxy : null,
          1,
        ),
      ).rejects.toThrow("Proxy");
      expect(reads).toBe(0);
      expect(f.bytes()).toEqual(before);
      await s.dispose();
    });
  test("caller scope/event/Goal are owned before acquisition awaits, optional undefined clears Goal", async () => {
    const f = fixture(),
      gate = deferred(),
      entered = deferred();
    let active = false;
    const s = await f.writer({
      afterNative: async (name) => {
        if (active && name === "lock.mkdir") {
          entered.resolve();
          await gate.promise;
        }
      },
    });
    await s.transition();
    active = true;
    const scope = { ...goalScope },
      event = { type: "error", message: "before" },
      goal = { id: "before", optional: undefined };
    const work = s.control("owned", scope, goal, event, 1);
    await entered.promise;
    scope.operationId = "changed";
    event.message = "changed";
    goal.id = "changed";
    active = false;
    gate.resolve();
    await work;
    expect(f.state().state.goalLifecycle as unknown).toEqual({ id: "before" });
    expect(f.bytes().toString()).toContain('"message":"before"');
    expect(f.bytes().toString()).not.toContain('"message":"changed"');
    await s.control("clear", goalScope, undefined, null, 2);
    expect(f.state().state.goalLifecycle).toBeUndefined();
    await s.dispose();
  });
  test("exact 16MiB event uses 256 fragments, one group sync and original whole-event receipt", async () => {
    const f = fixture();
    let syncs = 0,
      writes = 0,
      active = false;
    const s = await f.writer({
      observe: (e) => {
        if (active && e.stage === "submit") {
          if (e.operation === "file.sync") syncs++;
          if (e.operation === "file.write") writes++;
        }
      },
    });
    await s.transition();
    active = true;
    const event = { type: "text_delta", text: "" };
    event.text = "x".repeat(EVENT_LIMIT - Buffer.byteLength(canonical(event)));
    const receipt = await s.append("max", notice, event);
    expect(syncs).toBe(1);
    expect(writes).toBe(512);
    expect(
      f
        .bytes()
        .toString()
        .split("\n")
        .filter((line) => line.includes('"kind":"fragment"')).length,
    ).toBe(256);
    expect(await s.append("max", notice, event)).toEqual({ ...receipt, replayed: true });
    const proof = await s.inspect();
    await s.dispose();
    expect(f.cold()).toEqual(proof);
  }, 30000);
  test("first real write cancellation has no protected effects", async () => {
    const f = fixture(),
      controller = new AbortController();
    let active = false;
    const s = await f.writer({
      observe: (e) => {
        if (active && e.operation === "file.write" && e.stage === "submit") controller.abort();
      },
    });
    await s.transition();
    active = true;
    const before = f.bytes();
    const failure = await rejection(
      s.append("zero", notice, { type: "error" }, { signal: controller.signal }),
    );
    expect(failure).toBeInstanceOf(WriterCancellation);
    expect((failure as WriterCancellation).durableOutcome).toBe("zero_effects");
    expect(f.bytes()).toEqual(before);
    await s.dispose();
  });
  test("cancel inside a fragmented group finishes all records and sync before typed committed rejection", async () => {
    const f = fixture(),
      controller = new AbortController();
    let active = false,
      writes = 0,
      syncs = 0;
    const s = await f.writer({
      afterNative: (name) => {
        if (active && name === "file.write" && ++writes === 1) controller.abort();
      },
      observe: (e) => {
        if (active && e.operation === "file.sync" && e.stage === "submit") syncs++;
      },
    });
    await s.transition();
    active = true;
    const event = { type: "text_delta", text: "x".repeat(180000) };
    const failure = await rejection(
      s.append("cancel", notice, event, { signal: controller.signal }),
    );
    expect((failure as WriterCancellation).durableOutcome).toBe("committed");
    expect(syncs).toBe(1);
    expect(writes).toBeGreaterThan(2);
    const receipt = (failure as WriterCancellation).durableReceipt;
    expect(receipt).toBeDefined();
    active = false;
    expect(await s.append("cancel", notice, event)).toEqual({
      ...(receipt as Receipt),
      replayed: true,
    });
    await s.dispose();
    f.cold();
  });
  for (const stage of ["begin", "pending_state", "prepared", "final_state", "commit"])
    test(`cancel after ${stage} preserves exact WAL stage and stops new stages`, async () => {
      const f = fixture(),
        controller = new AbortController();
      let active = false;
      const seen: string[] = [];
      const s = await f.writer({
        afterNative: (name) => {
          if (active && name.startsWith("writer.stage.")) {
            seen.push(name.slice(13));
            if (name === "writer.stage." + stage) controller.abort();
          }
        },
      });
      await s.transition();
      active = true;
      const failure = await rejection(
        s.control("cancel-goal", goalScope, { id: "next" }, { type: "error", message: "goal" }, 1, {
          signal: controller.signal,
        }),
      );
      expect(failure).toBeInstanceOf(WriterCancellation);
      expect((failure as WriterCancellation).durableOutcome).toBe(
        stage === "commit" ? "committed" : "incomplete_or_unknown",
      );
      expect(seen.at(-1)).toBe(stage);
      const before = f.bytes();
      await s.dispose();
      if (stage === "commit") f.cold();
      else expect(() => f.cold()).toThrow();
      expect(f.bytes()).toEqual(before);
    });
  test("temp creation begins the whole state group; cancellation still finishes rename+dirsync", async () => {
    const f = fixture(),
      controller = new AbortController();
    let active = false;
    const seen: string[] = [];
    const s = await f.writer({
      afterNative: (name) => {
        if (active) {
          seen.push(name);
          if (name === "writer.temp.open") controller.abort();
        }
      },
    });
    await s.transition();
    active = true;
    const failure = await rejection(
      s.control("temp", goalScope, { id: "next" }, null, 1, { signal: controller.signal }),
    );
    expect((failure as WriterCancellation).durableOutcome).toBe("incomplete_or_unknown");
    expect(seen).toContain("state.rename");
    expect(seen).toContain("directory.sync");
    expect(seen).toContain("writer.stage.pending_state");
    expect(f.state().control?.pending?.eventId).toBe("temp");
    expect(readdirSync(f.directory).some((n) => n.endsWith(".tmp"))).toBe(false);
    await s.dispose();
    expect(() => f.cold()).toThrow();
  });
  test("transition state completion can report committed after cancellation", async () => {
    const f = fixture(),
      c = new AbortController(),
      s = await f.writer({
        afterNative: (name) => {
          if (name === "writer.stage.transition_state") c.abort();
        },
      });
    const error = await rejection(s.transition({ signal: c.signal }));
    expect((error as WriterCancellation).durableOutcome).toBe("committed");
    expect(typeof (error as WriterCancellation).durableReceipt).toBe("string");
    await s.dispose();
    f.cold();
  });
  test("no-display control has exactly begin/commit journal syncs and both state durability groups", async () => {
    const f = fixture();
    let syncs = 0,
      dirs = 0,
      active = false;
    const s = await f.writer({
      observe: (e) => {
        if (active && e.stage === "submit") {
          if (e.operation === "file.sync") syncs++;
          if (e.operation === "directory.sync") dirs++;
        }
      },
    });
    await s.transition();
    active = true;
    await s.control("no-display", goalScope, {}, null, 1);
    expect(syncs).toBe(4);
    expect(dirs).toBe(2);
    await s.dispose();
    const fresh = await f.writer();
    const coldAsync = await fresh.inspect();
    await fresh.dispose();
    expect(f.cold()).toEqual(coldAsync);
  });
  test("oversized Goal/state and full index reject before any protected record", async () => {
    const f = fixture(),
      s = await f.writer();
    await s.transition();
    const before = f.bytes();
    await expect(
      s.control("oversized", goalScope, { text: "x".repeat(1024 * 1024) }, null, 1),
    ).rejects.toThrow("bound");
    const index = (s as unknown as { index: { size: number } }).index;
    index.size = MAX_IDENTITIES;
    await expect(s.append("capacity", notice, { type: "error" })).rejects.toThrow("capacity");
    expect(f.bytes()).toEqual(before);
    await s.dispose();
  });
  test("delta publishes only after release; cleanup failure retains causes and bars receipt", async () => {
    const f = fixture();
    let active = false,
      releaseCount = -1;
    const s = await f.writer({
      afterNative: (name) => {
        if (active && name === "lock.rmdir")
          releaseCount = (s as unknown as { index: { count: number } }).index.count;
      },
    });
    await s.transition();
    active = true;
    await s.append("published", notice, { type: "error" });
    expect(releaseCount).toBe(0);
    expect((s as unknown as { index: { count: number } }).index.count).toBe(1);
    await s.dispose();
    const bad = fixture();
    let fail = false;
    const releaseCause = new Error("release-injected-after-actual-rmdir");
    const t = await bad.writer({
      afterNative: (name) => {
        if (fail && name === "lock.rmdir") throw releaseCause;
      },
    });
    await t.transition();
    fail = true;
    const cause = await rejection(t.append("cleanup", notice, { type: "error" }));
    expect(cause).toBeInstanceOf(WriterFailure);
    expect(leaves(cause)).toContain(releaseCause);
    expect((cause as { durableReceipt?: unknown }).durableReceipt).toBeUndefined();
    expectedCleanupFailures.add(t);
    await expect(t.dispose()).rejects.toThrow("release-injected");
  });
  test("dispose waits for actual sync completion and complete cancellation/publication chain", async () => {
    const f = fixture(),
      gate = deferred(),
      entered = deferred(),
      c = new AbortController();
    let active = false;
    const s = await f.writer({
      afterNative: async (name) => {
        if (active && name === "file.sync") {
          entered.resolve();
          await gate.promise;
        }
      },
    });
    await s.transition();
    active = true;
    const work = rejection(s.append("settled", notice, { type: "error" }, { signal: c.signal }));
    await entered.promise;
    c.abort();
    let disposed = false;
    const disposal = s.dispose().then(() => {
      disposed = true;
    });
    await immediate();
    expect(disposed).toBe(false);
    expect(f.pool.bytes).toBeGreaterThan(0);
    gate.resolve();
    const error = await work;
    expect((error as WriterCancellation).durableOutcome).toBe("committed");
    await disposal;
    expect(f.pool.bytes).toBe(0);
    f.cold();
  });
});

describe("writer foundations preserve custody and limits", () => {
  test("cancellation classification includes every own cause, including unknown and cycles", () => {
    const abort = () => new DOMException("fixture", "AbortError");
    expect(onlyCancellation([abort()])).toBe(true);
    for (const cause of [new Error("primary"), 0, undefined])
      expect(onlyCancellation([Object.assign(abort(), { cause })])).toBe(false);
    const cycle = abort();
    Object.assign(cycle, { cause: cycle });
    expect(onlyCancellation([cycle])).toBe(false);
    expect(onlyCancellation([Object.assign(abort(), { cause: abort() })])).toBe(true);
  });
  test("a final-stage DOM Abort with a non-cancellation own cause cannot claim committed receipt", async () => {
    const f = fixture(),
      primary = new Error("non-cancellation-primary"),
      abort = Object.assign(new DOMException("fixture abort", "AbortError"), { cause: primary });
    let active = false;
    const s = await f.writer({
      afterNative: (name) => {
        if (active && name === "writer.stage.append") throw abort;
      },
    });
    await s.transition();
    active = true;
    const cause = await rejection(s.append("abort-with-primary", notice, { type: "notice" }));
    expect(cause).toBeInstanceOf(WriterFailure);
    expect((cause as WriterCancellation).durableReceipt).toBeUndefined();
    expect(leaves(cause)).toContain(abort);
    expect((abort as { cause: unknown }).cause).toBe(primary);
    await s.dispose();
  });
  test("empty prepared head preserves exact cursor bytes for differently ordered input keys", async () => {
    const f = fixture();
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    const head = { sequence: 3, offset: 1234, hash: digest("head") };
    await custody.withLease(async (lease) => {
      const a = await prepareAsyncRecordGroup(lease, head);
      const b = await prepareAsyncRecordGroup(lease, {
        hash: head.hash,
        offset: head.offset,
        sequence: head.sequence,
      });
      expect(Object.keys(preparedGroupHead(a))).toEqual(["sequence", "offset", "hash"]);
      expect(token("fixture", preparedGroupHead(a))).toBe(token("fixture", head));
      expect(token("fixture", preparedGroupHead(b))).toBe(token("fixture", head));
    });
    await custody.dispose();
  });
  for (const stage of ["begin", "pending_state", "prepared", "final_state", "commit"])
    test(`non-cancellation fault after ${stage} retains primary and WAL without automatic repair`, async () => {
      const f = fixture(),
        primary = new Error("stage-fault-" + stage);
      let active = false;
      const s = await f.writer({
        afterNative: (name) => {
          if (active && name === "writer.stage." + stage) throw primary;
        },
      });
      await s.transition();
      active = true;
      const error = await rejection(s.control("fault", goalScope, {}, { type: "error" }, 1));
      expect(error).toBeInstanceOf(WriterFailure);
      expect(leaves(error)).toContain(primary);
      expect((error as WriterCancellation).durableReceipt).toBeUndefined();
      const before = f.bytes();
      await s.dispose();
      if (stage === "commit") f.cold();
      else expect(() => f.cold()).toThrow();
      expect(f.bytes()).toEqual(before);
    });
  for (const group of [1, 2])
    test(`cancel inside state group ${group} settles rename and directory sync`, async () => {
      const f = fixture(),
        controller = new AbortController();
      let active = false,
        opens = 0;
      const seen: string[] = [];
      const s = await f.writer({
        afterNative: (name) => {
          if (active) {
            seen.push(name);
            if (name === "writer.temp.open" && ++opens === group) controller.abort();
          }
        },
      });
      await s.transition();
      active = true;
      const error = await rejection(
        s.control("inside-state", goalScope, {}, { type: "error" }, 1, {
          signal: controller.signal,
        }),
      );
      expect((error as WriterCancellation).durableOutcome).toBe("incomplete_or_unknown");
      expect(seen.filter((name) => name === "directory.sync").length).toBe(group);
      expect(seen).not.toContain("writer.stage.commit");
      expect(f.state().control?.pending !== undefined).toBe(group === 1);
      expect(readdirSync(f.directory).some((name) => name.endsWith(".tmp"))).toBe(false);
      await s.dispose();
      expect(() => f.cold()).toThrow();
    });
  test("actual bounded short writes complete one group; zero progress rejects without receipt", async () => {
    const f = fixture(),
      s = await f.writer();
    await s.transition();
    const realOpen = fsp.open;
    const lengths: number[] = [];
    let zero = false;
    const mock = spyOn(fsp, "open").mockImplementation((async (
      ...args: Parameters<typeof fsp.open>
    ) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === f.journalPath) {
        const write = handle.write.bind(handle);
        handle.write = (async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          lengths.push(length);
          if (zero) return { bytesWritten: 0, buffer };
          return write(buffer, offset, Math.min(997, length), position);
        }) as typeof handle.write;
      }
      return handle;
    }) as typeof fsp.open);
    try {
      await s.append("short", notice, { type: "text_delta", text: "x".repeat(100000) });
      expect(lengths.length).toBeGreaterThan(100);
      expect(Math.max(...lengths)).toBeLessThanOrEqual(65536);
      zero = true;
      const error = await rejection(s.append("zero-progress", notice, { type: "error" }));
      expect(error).toBeInstanceOf(WriterFailure);
      expect((error as WriterCancellation).durableReceipt).toBeUndefined();
      expect(
        leaves(error).some((item) => item instanceof Error && item.message.includes("short write")),
      ).toBe(true);
    } finally {
      mock.mockRestore();
      await s.dispose();
    }
  });
  test("primary plus close error and falsy errors retain actual original causes", async () => {
    const f = fixture(),
      primary = new Error("primary-injected"),
      close = new Error("close-injected");
    let active = false;
    const s = await f.writer({
      afterNative: (name) => {
        if (active && name === "writer.stage.append") throw primary;
      },
      faultBefore: (name) => (active && name === "file.close" ? close : undefined),
    });
    await s.transition();
    // Arm only when the actual append has completed, not during preparation state reads.
    active = false;
    (s as unknown as { custody: { hooks: FixtureIOHooks } }).custody.hooks.afterNative = (name) => {
      if (name === "writer.stage.append") {
        active = true;
        throw primary;
      }
    };
    const error = await rejection(s.append("both", notice, { type: "error" }));
    expect(leaves(error)).toContain(primary);
    expect(leaves(error)).toContain(close);
    expectedCleanupFailures.add(s);
    await expect(s.dispose()).rejects.toThrow("close-injected");
    const g = fixture();
    let fault = false;
    const t = await g.writer({
      afterNative: (name) => {
        if (fault && name === "writer.stage.append") throw 0;
      },
    });
    await t.transition();
    fault = true;
    const falsy = await rejection(t.append("falsy", notice, { type: "error" }));
    expect(falsy).toBeInstanceOf(WriterFailure);
    expect(leaves(falsy)).toContain(0);
    await t.dispose();
  });
  test("tail binding failure after a bound final commit cannot return a committed cancellation receipt", async () => {
    const f = fixture(),
      controller = new AbortController();
    let active = false,
      bound = false,
      changed = false;
    const s = await f.writer({
      afterNative: (name) => {
        if (active && name === "writer.final_binding") {
          bound = true;
          controller.abort();
        }
      },
      faultBefore: (name) => {
        if (bound && !changed && name === "file.close") {
          const state = f.state();
          state.state.startedAt++;
          writeFileSync(f.statePath, encodeState(state));
          changed = true;
        }
        return undefined;
      },
    });
    await s.transition();
    active = true;
    const error = await rejection(
      s.append("bound-but-revoked", notice, { type: "error" }, { signal: controller.signal }),
    );
    expect(bound && changed).toBe(true);
    expect(error).toBeInstanceOf(WriterFailure);
    expect((error as WriterCancellation).durableReceipt).toBeUndefined();
    await s.dispose();
  });
  for (const cancel of [false, true])
    for (const target of ["state", "journal"] as const)
      test(`post-bind ${target} change at descriptor close bars ${cancel ? "cancelled" : "ordinary"} receipt`, async () => {
        const f = fixture(),
          controller = new AbortController();
        let active = false,
          bound = false,
          changed = false;
        const s = await f.writer({
          afterNative: (name) => {
            if (active && name === "writer.final_binding") {
              bound = true;
              if (cancel) controller.abort();
            }
          },
          faultBefore: (name) => {
            if (bound && !changed && name === "file.close") {
              if (target === "state") {
                const state = f.state();
                state.state.goalLifecycle = {
                  id: "changed-after-bind",
                } as unknown as SessionState["goalLifecycle"];
                writeFileSync(f.statePath, encodeState(state));
              } else writeFileSync(f.journalPath, f.bytes().subarray(0, f.bytes().length - 1));
              changed = true;
            }
            return undefined;
          },
        });
        await s.transition();
        active = true;
        const cause = await rejection(
          s.append("post-bind-change", notice, { type: "notice" }, { signal: controller.signal }),
        );
        expect(bound && changed).toBe(true);
        expect(cause).toBeInstanceOf(WriterFailure);
        expect((cause as WriterCancellation).durableReceipt).toBeUndefined();
        await s.dispose();
      });
  for (const value of [undefined, null, false, 0, ""])
    test(`settled falsy throw ${String(value)} keeps primary and healthy cleanup`, async () => {
      const f = fixture(),
        custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
      const result = await custody.withLeaseSettled(() => {
        throw value;
      });
      expect(result.failures).toEqual([value]);
      expect(result.cleanupOk).toBe(true);
      await custody.dispose();
    });
  test("tail binding failure makes cleanupOk false", async () => {
    const f = fixture(),
      custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    const result = await custody.withLeaseSettled(() => {
      const state = f.state();
      state.state.startedAt++;
      writeFileSync(f.statePath, encodeState(state));
    });
    expect(result.cleanupOk).toBe(false);
    expect(result.cleanupFailures.length).toBeGreaterThan(0);
    await custody.dispose();
  });
  test("prepared state/group tokens reject clones and another lease; journal capacity preflights", async () => {
    const f = fixture(),
      custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    let oldState!: ReturnType<typeof prepareAsyncState>;
    await custody.withLease(async (lease) => {
      oldState = prepareAsyncState(lease, await readAsyncStateUnderLease(lease));
      expect(() => writePreparedAsyncStateUnderLease(lease, { ...oldState })).toThrow();
      await expect(
        prepareAsyncRecordGroup(
          lease,
          { sequence: 1, offset: JOURNAL_LIMIT, hash: digest("head") },
          { kind: "event" },
        ),
      ).rejects.toThrow("bound");
    });
    const failed = await custody.withLeaseSettled((lease) =>
      writePreparedAsyncStateUnderLease(lease, oldState),
    );
    expect(failed.failures.length).toBe(1);
    await custody.dispose();
  });
  test("exact record limit excluding LF allows 262145 physical bytes and one group sync", async () => {
    const f = fixture(),
      sync = new FixtureStorage(f.root, f.sessionId, f.pool);
    sync.transition();
    const proof = sync.inspect();
    sync.dispose();
    const scope = { ...notice },
      event = { type: "error" };
    let projected = projection(scope, event, null);
    let payload = {
      kind: "event",
      eventId: "record-max",
      scope,
      event,
      projectionDigest: projected,
    };
    scope.invocationId += "x".repeat(
      RECORD_LIMIT - (encodeRecord(proof.head, payload).bytes.length - 1),
    );
    projected = projection(scope, event, null);
    payload = { ...payload, projectionDigest: projected };
    const custody = await AsyncFixtureCustody.create(f.root, f.sessionId);
    const facts = createWriterFacts();
    await custody.withLease(async (lease) => {
      const file = await openAsyncJournal(lease, true),
        group = await prepareAsyncRecordGroup(lease, proof.head, payload);
      await appendPreparedRecordGroup(lease, file, group, facts, "append");
    });
    expect(f.bytes().length - proof.head.offset).toBe(RECORD_LIMIT + 1);
    expect(readWriterFacts(facts).native).toEqual(["journal.sync:append"]);
    await custody.dispose();
    f.cold();
  });
  test("prepared delta is bounded before mutation and stale lifetime cannot publish", async () => {
    const pool = new IdentityPool(),
      index = new AsyncIdentityIndex(pool);
    const delta = await index.prepareInsert(
      "prepared",
      digest("p"),
      { sequence: 1, offset: 10, bindingOffset: 0 },
      async () => "prepared",
    );
    expect(index.count).toBe(0);
    index.invalidate();
    expect(() => index.publishPrepared(delta, "new")).toThrow("lifetime");
    expect(index.count).toBe(0);
    await index.dispose();
  });
});
