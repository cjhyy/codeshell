import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";
import { readOutputJournal, SessionOutputJournal } from "./output-journal.js";
import { SessionOutputCoverageStore, outputCoverageIncarnation } from "./output-coverage-state.js";
import * as fileIdentity from "./persistent-file-identity.js";
import { buildWrappedOnStream } from "../engine/run-stream.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "output-persistent-identity-"));
  roots.push(root);
  const id = "restart-session";
  const manager = new SessionManager(root);
  const session = manager.create(root, "fixture", "fixture", id);
  const run = session.transcript.appendMessage("user", "keep this chat").id;
  manager.startSessionRun(session.state, run);
  const writer = new SessionOutputJournal(root, id, run, session.transcript.getEvents()[0].id);
  const cursor = writer.append({ type: "text_delta", text: "before restart" });
  return { root, id, manager, session, run, cursor, directory: join(root, id) };
}
/** A cold runtime sees renumbered stat.dev AND block-node rdev, with identical disk UUIDs. */
function renumberDevices() {
  const originalLstat = fs.lstatSync;
  const originalFstat = fs.fstatSync;
  const moved = (stat: any) =>
    new Proxy(stat, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "dev" || (key === "rdev" && target.isBlockDevice()))
          return typeof value === "bigint" ? value + 1000n : value + 1000;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const lstat = spyOn(fs, "lstatSync").mockImplementation(((...args: any[]) =>
    moved((originalLstat as any)(...args))) as any);
  const fstat = spyOn(fs, "fstatSync").mockImplementation(((...args: any[]) =>
    moved((originalFstat as any)(...args))) as any);
  return () => {
    lstat.mockRestore();
    fstat.mockRestore();
  };
}

describe("durable output identity across macOS reboot", () => {
  test.skipIf(process.platform !== "darwin")(
    "cold readers, writers, coverage and old cursors survive device renumbering",
    () => {
      const f = fixture();
      const transcript = readFileSync(join(f.directory, "transcript.jsonl"));
      const original = readOutputJournal(f.root, f.id);
      const coverage = new SessionOutputCoverageStore(() => f.root);
      const proof = coverage.record(f.id, { unpaired: false, inputIds: [] });
      const restore = renumberDevices();
      try {
        const reader = readOutputJournal(f.root, f.id, { through: f.cursor });
        expect(reader.status).toBe("ok");
        expect(reader.through).toBe(f.cursor);
        expect(reader.coverageIdentity).toBe(original.coverageIdentity);
        const coldCoverage = new SessionOutputCoverageStore(() => f.root).read(f.id);
        expect(coldCoverage.status).toBe("ok");
        expect(coldCoverage.incarnation).toBe(proof.incarnation);
        const coldWriter = new SessionOutputJournal(f.root, f.id, f.run);
        coldWriter.append({ type: "text_delta", text: "after restart" });
        const next = readOutputJournal(f.root, f.id, { after: f.cursor });
        expect(next.status).toBe("ok");
        expect(next.frames.map((frame) => frame.event)).toEqual([
          { type: "text_delta", text: "after restart" },
        ]);
        expect(readFileSync(join(f.directory, "transcript.jsonl"))).toEqual(transcript);
      } finally {
        restore();
      }
    },
  );

  test("whole-state saves preserve durable binding and incident evidence", () => {
    const f = fixture();
    const stateFile = join(f.directory, "state.json");
    const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
    persisted.outputIdentityRecovery = { version: 1, evidence: "preserve this recovery receipt" };
    writeFileSync(stateFile, JSON.stringify(persisted));
    expect(f.manager.saveState(f.session.state)).toBe(true);
    const saved = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(saved.outputJournalBinding).toEqual(persisted.outputJournalBinding);
    expect(saved.outputIdentityRecovery).toEqual(persisted.outputIdentityRecovery);
  });

  for (const child of [false, true])
    test(`legacy device drift at ${child ? "child" : "parent"} admission does not poison storage`, () => {
      const f = fixture();
      const stateFile = join(f.directory, "state.json");
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      delete state.outputJournalBinding;
      state.outputJournalHead.version = 2;
      delete state.outputJournalHead.file.stable;
      state.outputJournalHead.file.dev += 1000;
      writeFileSync(stateFile, JSON.stringify(state));
      let failures = 0;
      const wrapped = buildWrappedOnStream({
        getSession: () => f.session,
        setLatestTodos() {},
        outputJournal: {
          root: f.root,
          getRunId: () => f.run,
          onFailure: () => {
            failures++;
          },
          onIndependentFailure: () => {
            failures++;
          },
        },
        userOnStream() {},
      });
      expect(() =>
        wrapped(
          child
            ? { type: "agent_start", agentId: "before-child", description: "not started" }
            : { type: "session_started", sessionId: f.id, promptTokens: 0 },
        ),
      ).toThrow("identity migration is required");
      wrapped.finish();
      expect(failures).toBe(0);
      expect(JSON.parse(readFileSync(stateFile, "utf8")).outputRecoveryIncomplete).not.toBe(true);
    });
});

test("first v3 watermark and cursor binding are published in one state transaction", () => {
  const root = mkdtempSync(join(tmpdir(), "output-first-admission-"));
  roots.push(root);
  const manager = new SessionManager(root);
  const session = manager.create(root, "fixture", "fixture", "atomic-first");
  manager.startSessionRun(session.state, "first-run");
  const rename = fs.renameSync;
  let publications = 0;
  const seen = spyOn(fs, "renameSync").mockImplementation(((source: string, target: string) => {
    if (String(target).endsWith("/state.json")) {
      const state = JSON.parse(readFileSync(source, "utf8"));
      if (state.outputJournalHead?.version === 3) {
        publications++;
        expect(state.outputJournalBinding?.journalIdentity).toBe(state.outputJournalHead.identity);
        expect(state.outputJournalBinding?.anchor).toBeDefined();
      }
    }
    return rename(source, target);
  }) as any);
  try {
    new SessionOutputJournal(root, session.state.sessionId, "first-run");
  } finally {
    seen.mockRestore();
  }
  expect(publications).toBe(1);
});

test("actual output arriving before legacy identity admission still records a storage failure", () => {
  const f = fixture();
  const path = join(f.directory, "state.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  delete state.outputJournalBinding;
  state.outputJournalHead.version = 2;
  delete state.outputJournalHead.file.stable;
  state.outputJournalHead.file.dev += 1000;
  writeFileSync(path, JSON.stringify(state));
  let failures = 0;
  const wrapped = buildWrappedOnStream({
    getSession: () => f.session,
    setLatestTodos() {},
    outputJournal: {
      root: f.root,
      getRunId: () => f.run,
      onFailure: () => {
        failures++;
      },
      onIndependentFailure: () => {
        failures++;
      },
    },
    userOnStream() {},
  });
  expect(() =>
    wrapped({ type: "text_delta", text: "already produced", agentId: "late-child" }),
  ).toThrow();
  wrapped.finish();
  expect(failures).toBe(1);
});

test("platform identity lookup failure precedes journal materialization and can be retried", () => {
  const root = mkdtempSync(join(tmpdir(), "output-identity-lookup-"));
  roots.push(root);
  const manager = new SessionManager(root);
  const session = manager.create(root, "fixture", "fixture", "lookup-retry");
  manager.startSessionRun(session.state, "first-run");
  const directory = join(root, session.state.sessionId);
  const before = fs.readdirSync(directory).sort();
  const lookup = spyOn(fileIdentity, "capturePersistentFileIdentity").mockImplementation(() => {
    throw new Error("platform UUID lookup unavailable");
  });
  try {
    expect(() => new SessionOutputJournal(root, session.state.sessionId, "first-run")).toThrow(
      "platform UUID lookup unavailable",
    );
  } finally {
    lookup.mockRestore();
  }
  expect(fs.readdirSync(directory).sort()).toEqual(before);
  const writer = new SessionOutputJournal(root, session.state.sessionId, "first-run");
  writer.append({ type: "text_delta", text: "lookup recovered" });
  expect(readOutputJournal(root, session.state.sessionId).status).toBe("ok");
});

test.skipIf(process.platform === "win32")(
  "coverage preflight rejects a FIFO state without waiting for a writer",
  () => {
    const f = fixture();
    const state = f.manager.readSessionState(f.id)!;
    const path = join(f.directory, "state.json");
    rmSync(path);
    execFileSync("/usr/bin/mkfifo", [path]);
    expect(() => outputCoverageIncarnation(f.root, f.id, state.startedAt)).toThrow();
  },
);
