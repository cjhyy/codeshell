import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { SessionState } from "../../types.js";
import { decodeState, digest, encodeState, type DecodedState } from "./codec.js";
import { IdentityPool } from "./id-index.js";
import {
  appendUnderLease,
  createFixtureRoot,
  FixtureCustody,
  openJournal,
  readStateUnderLease,
  writeStateUnderLease,
  type Lease,
} from "./io.js";
import { FixtureStorage, type Stage } from "./storage.js";

function fixture() {
  const root = createFixtureRoot();
  const sessionId = "fixture-session";
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
      runId: "real-original-run",
      outputJournalIdentity: digest(header + "\n"),
      workspaceProfile: "profile-kept",
    } as SessionState,
  };
  writeFileSync(join(directory, "state.json"), encodeState(state));
  writeFileSync(join(directory, "output-journal.jsonl"), header + "\n");
  const pool = new IdentityPool();
  const storage = new FixtureStorage(root, sessionId, pool);
  return {
    root,
    sessionId,
    directory,
    state,
    pool,
    storage,
    cold: () => new FixtureStorage(root, sessionId, pool),
  };
}
const scope = (id: string) => ({ kind: "control", operation: "goal", operationId: id });
const event = (id: string) => ({ type: "goal", data: { title: id } });

// These are real private filesystem source tests. Platform parameter tests are not native Windows evidence.
describe("fixture custody and original synchronous lock", () => {
  test("rejects forged/outlived/nested/async leases and retains original metadata", () => {
    const f = fixture();
    const custody = new FixtureCustody(f.root, f.sessionId);
    let token: Lease | undefined;
    expect(() =>
      readStateUnderLease({ root: f.root, sessionId: f.sessionId, directory: f.directory }),
    ).toThrow("Native fixture lease");
    custody.withLease((lease) => {
      token = lease;
      expect(readStateUnderLease(lease).state.workspaceProfile).toBe("profile-kept");
      expect(() => custody.withLease(() => {})).toThrow("Nested");
    });
    expect(() => readStateUnderLease(token!)).toThrow("Native fixture lease");
    expect(() => custody.withLease(() => Promise.resolve())).toThrow("Async");
    expect(() => custody.withLease(() => {})).not.toThrow();
    f.storage.dispose();
  });
  test("constructor rejects oversized, symlink and malformed UTF8 state before decoding", () => {
    const f = fixture();
    const path = join(f.directory, "state.json");
    truncateSync(path, 1024 * 1024 + 1);
    expect(() => new FixtureCustody(f.root, f.sessionId)).toThrow("State byte bound");
    rmSync(path);
    writeFileSync(join(f.directory, "link-target"), encodeState(f.state));
    symlinkSync("link-target", path);
    expect(() => new FixtureCustody(f.root, f.sessionId)).toThrow();
    rmSync(path);
    writeFileSync(path, Buffer.concat([Buffer.from([0xff]), Buffer.from(encodeState(f.state))]));
    expect(() => new FixtureCustody(f.root, f.sessionId)).toThrow();
    f.storage.dispose();
  });
  test("unsupported platform preflight leaves state and directory byte-identical", () => {
    const f = fixture();
    const custody = new FixtureCustody(f.root, f.sessionId);
    const before = readFileSync(join(f.directory, "state.json"));
    const names = readdirSync(f.directory);
    custody.withLease((lease) =>
      expect(() => writeStateUnderLease(lease, f.state, "win32")).toThrow("directory fsync"),
    );
    expect(readFileSync(join(f.directory, "state.json"))).toEqual(before);
    expect(readdirSync(f.directory)).toEqual(names);
    f.storage.dispose();
  });
  test("journal descriptor replacement and Session deletion cannot write or recreate", () => {
    const f = fixture();
    const custody = new FixtureCustody(f.root, f.sessionId);
    custody.withLease((lease) => {
      const fd = openJournal(lease, true);
      try {
        const offset = fstatSync(fd).size;
        renameSync(join(f.directory, "output-journal.jsonl"), join(f.directory, "old-journal"));
        writeFileSync(join(f.directory, "output-journal.jsonl"), "replacement");
        expect(() => appendUnderLease(lease, fd, Buffer.from("bad"), offset)).toThrow(
          "incarnation",
        );
        expect(readFileSync(join(f.directory, "old-journal")).length).toBe(offset);
      } finally {
        closeSync(fd);
      }
    });
    f.storage.dispose();
    rmSync(f.directory, { recursive: true });
    expect(() => custody.withLease(() => {})).toThrow();
    expect(() => lstatSync(f.directory)).toThrow();
  });
  test("existing lock exhausts unchanged 75ms retry budget without stale stealing", () => {
    const f = fixture();
    const path = join(f.directory, "state.json.lock");
    mkdirSync(path);
    const before = performance.now();
    expect(() => f.storage.inspect()).toThrow("75ms");
    expect(performance.now() - before).toBeGreaterThanOrEqual(70);
    expect(lstatSync(path).isDirectory()).toBe(true);
    f.storage.dispose();
  });
});

describe("fixture WAL and immutable whole-history receipts", () => {
  test("transition keeps v1 prefix/cursor and no-run event never invents run id", () => {
    const f = fixture();
    const v1 = readFileSync(join(f.directory, "output-journal.jsonl"));
    const before = f.storage.inspect();
    f.storage.transition();
    const receipt = f.storage.append(
      "notice-one",
      { kind: "host_notice", source: "automation", invocationId: "invocation" },
      { type: "error", message: "fixture notice" },
    );
    const stored = readFileSync(join(f.directory, "output-journal.jsonl"));
    expect(stored.subarray(0, v1.length)).toEqual(v1);
    const lines = stored
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.slice(1).every((line) => !Object.hasOwn(line, "runId"))).toBe(true);
    expect(JSON.parse(Buffer.from(receipt.cursor, "base64url").toString()).identity).toBe(
      before.identity,
    );
    expect(decodeState(readFileSync(join(f.directory, "state.json"), "utf8")).state.runId).toBe(
      "real-original-run",
    );
    f.storage.dispose();
    const cold = f.cold();
    expect(cold.inspect().head.sequence).toBe(2);
    cold.dispose();
  });
  test("two legal Goal changes cold-compare latest control only, retry retains original cursor", () => {
    const f = fixture();
    f.storage.transition();
    const first = f.storage.control("goal-one", scope("one"), { id: "one" }, event("one"), 1);
    const second = f.storage.control("goal-two", scope("two"), { id: "two" }, event("two"), 2);
    expect(first.cursor).not.toBe(second.cursor);
    f.storage.dispose();
    const cold = f.cold();
    expect(cold.inspect().latestControl?.eventId).toBe("goal-two");
    expect(cold.control("goal-one", scope("one"), { id: "one" }, event("one"), 1)).toEqual({
      cursor: first.cursor,
      replayed: true,
    });
    expect(() =>
      cold.control("goal-one", scope("one"), { id: "DIFFERENT" }, event("one"), 1),
    ).toThrow("different projection");
    expect(() => cold.control("new-goal", scope("new"), { id: "new" }, null, 1)).toThrow(
      "revision conflict",
    );
    cold.dispose();
  });
  test("state-only Goal and fragmented event bind receipt to commit, not prepared output", () => {
    const f = fixture();
    f.storage.transition();
    const stateOnly = f.storage.control("state-only", scope("state-only"), { id: "zero" }, null, 1);
    const large = { type: "text_delta", text: "a".repeat(150000) };
    const fragmented = f.storage.control(
      "large-goal",
      scope("large-goal"),
      { id: "large" },
      large,
      2,
    );
    expect(JSON.parse(Buffer.from(stateOnly.cursor, "base64url").toString()).sequence).toBe(3);
    expect(JSON.parse(Buffer.from(fragmented.cursor, "base64url").toString()).sequence).toBe(8);
    f.storage.dispose();
    const cold = f.cold();
    expect(cold.inspect().head.sequence).toBe(8);
    cold.dispose();
  });
  for (const crash of ["begin", "pending_state", "prepared", "final_state"] as Stage[]) {
    test(`unclosed WAL at ${crash} remains incomplete without read truncation or same-id reissue`, () => {
      const f = fixture();
      f.storage.transition();
      expect(() =>
        f.storage.control("fault", scope("fault"), { id: "fault" }, event("fault"), 1, (stage) => {
          if (stage === crash) throw new Error("simulated interruption");
        }),
      ).toThrow("simulated");
      f.storage.dispose();
      const beforeState = readFileSync(join(f.directory, "state.json"));
      const before = readFileSync(join(f.directory, "output-journal.jsonl"));
      const cold = f.cold();
      expect(() => cold.inspect()).toThrow();
      expect(() =>
        cold.control("fault", scope("fault"), { id: "fault" }, event("fault"), 1),
      ).toThrow();
      expect(readFileSync(join(f.directory, "state.json"))).toEqual(beforeState);
      expect(readFileSync(join(f.directory, "output-journal.jsonl"))).toEqual(before);
      cold.dispose();
    });
  }
  test("invalid display event and oversized state fail before any WAL record", () => {
    const f = fixture();
    f.storage.transition();
    const before = readFileSync(join(f.directory, "output-journal.jsonl"));
    expect(() =>
      f.storage.append(
        "bad-event",
        { kind: "run", runId: "fixture-actual-run" },
        { missingType: true },
      ),
    ).toThrow("display event");
    expect(() =>
      f.storage.control("too-big-state", scope("big"), { title: "x".repeat(1024 * 1024) }, null, 1),
    ).toThrow("byte bound");
    expect(readFileSync(join(f.directory, "output-journal.jsonl"))).toEqual(before);
    f.storage.dispose();
  });
  test("sparse event array is rejected before journal append", () => {
    const f = fixture();
    f.storage.transition();
    try {
      const before = readFileSync(join(f.directory, "output-journal.jsonl"));
      expect(() =>
        f.storage.append(
          "sparse",
          { kind: "run", runId: "actual-run" },
          { type: "fixture", data: new Array(1) },
        ),
      ).toThrow("Sparse");
      expect(readFileSync(join(f.directory, "output-journal.jsonl"))).toEqual(before);
    } finally {
      f.storage.dispose();
    }
  });

  test("accessor event cannot create a divergent projection/hash before append", () => {
    const f = fixture();
    f.storage.transition();
    try {
      let n = 0;
      const event = {
        type: "fixture",
        get data() {
          return ++n;
        },
      };
      const before = readFileSync(join(f.directory, "output-journal.jsonl"));
      expect(() =>
        f.storage.append("accessor", { kind: "run", runId: "actual-run" }, event),
      ).toThrow("Accessor");
      expect(n).toBe(0);
      expect(readFileSync(join(f.directory, "output-journal.jsonl"))).toEqual(before);
    } finally {
      f.storage.dispose();
    }
  });

  test("postcommit interruption has durable same-id success on retry without new record", () => {
    const f = fixture();
    f.storage.transition();
    expect(() =>
      f.storage.control(
        "committed",
        scope("commit"),
        { id: "committed" },
        event("commit"),
        1,
        (stage) => {
          if (stage === "commit") throw new Error("lost result");
        },
      ),
    ).toThrow("lost result");
    const before = readFileSync(join(f.directory, "output-journal.jsonl"));
    f.storage.dispose();
    const cold = f.cold();
    expect(
      cold.control("committed", scope("commit"), { id: "committed" }, event("commit"), 1).replayed,
    ).toBe(true);
    expect(readFileSync(join(f.directory, "output-journal.jsonl"))).toEqual(before);
    cold.dispose();
  });
  test("format marker without raw v2 state and partial v2 record fail without repair", () => {
    const f = fixture();
    expect(() =>
      f.storage.transition((stage) => {
        if (stage === "transition_appended") throw new Error("interrupted transition");
      }),
    ).toThrow();
    f.storage.dispose();
    const before = readFileSync(join(f.directory, "output-journal.jsonl"));
    const cold = f.cold();
    expect(() => cold.inspect()).toThrow("transition/state incomplete");
    cold.dispose();
    expect(readFileSync(join(f.directory, "output-journal.jsonl"))).toEqual(before);
    const p = fixture();
    p.storage.transition();
    p.storage.dispose();
    const fd = openSync(
      join(p.directory, "output-journal.jsonl"),
      constants.O_WRONLY | constants.O_APPEND,
    );
    try {
      writeSync(fd, '{"partial":');
    } finally {
      closeSync(fd);
    }
    const partial = readFileSync(join(p.directory, "output-journal.jsonl"));
    const pcold = p.cold();
    expect(() => pcold.inspect()).toThrow("never truncate");
    pcold.dispose();
    expect(readFileSync(join(p.directory, "output-journal.jsonl"))).toEqual(partial);
  });
});
