import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SessionManager } from "../packages/core/src/session/session-manager.js";
import { FileHistory } from "../packages/core/src/session/file-history.js";
import { MemoryManager } from "../packages/core/src/session/memory.js";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("SessionManager", () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-test-"));
    sm = new SessionManager(tmpDir);
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("creates a new session", () => {
    const bundle = sm.create("/tmp", "test-model", "test-provider");
    expect(bundle.state.sessionId).toBeTruthy();
    expect(bundle.state.status).toBe("active");
    expect(bundle.state.model).toBe("test-model");
  });

  it("resumes an existing session", () => {
    const bundle = sm.create("/tmp", "test-model", "test-provider");
    bundle.transcript.appendMessage("user", "hello");
    sm.saveState(bundle.state);

    const resumed = sm.resume(bundle.state.sessionId);
    expect(resumed.state.sessionId).toBe(bundle.state.sessionId);
    expect(resumed.transcript.eventCount).toBeGreaterThan(0);
  });

  it("lists sessions sorted by date", () => {
    sm.create("/tmp", "model-a", "prov");
    sm.create("/tmp", "model-b", "prov");
    const list = sm.list();
    expect(list).toHaveLength(2);
    expect(list[0].startedAt).toBeGreaterThanOrEqual(list[1].startedAt);
  });

  it("forks the frozen event tail into an independent top-level session", () => {
    const original = sm.create("/tmp", "model", "prov", "source", null, "desktop");
    original.transcript.appendMessage("user", "task1");
    original.transcript.append("file_history", { file: "owned-by-source" });
    original.transcript.append("plan_operation", { op: "owned-by-source" });
    const tail = original.transcript.appendMessage("assistant", "natural tail without boundary");
    original.state.workspace = {
      root: "/tmp/worktree",
      kind: "worktree",
      worktree: {
        path: "/tmp/worktree",
        branch: "feature/fork",
        baseRef: "main",
        createdBy: "codeshell",
      },
    };
    original.state.tokenUsage = { promptTokens: 10, completionTokens: 2, totalTokens: 12 };
    original.state.cumulativePromptTokens = 99;
    original.state.turnCount = 4;
    original.state.turnSeq = 2;
    original.state.invokedSkills = ["skill"];
    original.state.activeGoal = { objective: "do not copy" } as never;
    sm.saveState(original.state);
    const sourceStatePath = join(tmpDir, "source", "state.json");
    const sourceTranscriptPath = join(tmpDir, "source", "transcript.jsonl");
    const beforeState = readFileSync(sourceStatePath, "utf-8");
    const beforeTranscript = readFileSync(sourceTranscriptPath, "utf-8");

    const result = sm.fork("source", { targetSessionId: "target" });
    const forked = result.bundle;
    expect(forked.state.parentSessionId).toBeNull();
    expect(forked.state.forkedFrom).toEqual({
      sessionId: "source",
      mode: "full",
      fromEventId: original.transcript.getEvents("message")[0].id,
      throughEventId: tail.id,
      sourceEventCount: 2,
      createdAt: expect.any(Number),
    });
    expect(forked.state.workspace).toEqual(original.state.workspace);
    expect(forked.state.workspace).not.toBe(original.state.workspace);
    expect(forked.state.tokenUsage.totalTokens).toBe(0);
    expect(forked.state.cumulativePromptTokens).toBe(0);
    expect(forked.state.turnCount).toBe(0);
    expect(forked.state.turnSeq).toBe(0);
    expect(forked.state.invokedSkills).toEqual([]);
    expect(forked.state.activeGoal).toBeUndefined();

    const targetEvents = forked.transcript.getEvents();
    expect(targetEvents.filter((event) => event.type === "session_meta")).toHaveLength(1);
    expect(targetEvents.filter((event) => event.type === "file_history")).toHaveLength(0);
    expect(targetEvents.filter((event) => event.type === "plan_operation")).toHaveLength(0);
    expect(targetEvents.at(-1)?.data.content).toBe("natural tail without boundary");
    const sourceCopied = original.transcript
      .getEvents()
      .filter((event) => event.type === "message");
    expect(targetEvents.slice(1).map((event) => event.id)).not.toEqual(
      sourceCopied.map((event) => event.id),
    );
    expect(targetEvents.slice(1).map((event) => event.timestamp)).toEqual(
      sourceCopied.map((event) => event.timestamp),
    );
    expect(readFileSync(sourceStatePath, "utf-8")).toBe(beforeState);
    expect(readFileSync(sourceTranscriptPath, "utf-8")).toBe(beforeTranscript);

    forked.transcript.appendMessage("user", "target only");
    expect(
      original.transcript.toMessages().some((message) => message.content === "target only"),
    ).toBe(false);
  });

  it("uses an inclusive event cursor and rejects an unfinished tool round", () => {
    const source = sm.create("/tmp", "model", "provider", "source");
    source.transcript.appendMessage("user", "before tool");
    const use = source.transcript.appendToolUse("Read", "call-1", { path: "a" });
    const result = source.transcript.appendToolResult("call-1", "Read", "ok");
    source.transcript.appendMessage("assistant", "after tool");

    expect(() => sm.fork("source", { targetSessionId: "split", throughEventId: use.id })).toThrow(
      /unfinished tool round/,
    );
    const forked = sm.fork("source", {
      targetSessionId: "through-result",
      throughEventId: result.id,
    });
    expect(forked.copiedEventCount).toBe(3);
    expect(forked.bundle.transcript.getEvents().at(-1)?.type).toBe("tool_result");
  });

  it("rejects malformed/unknown transcripts and never leaves a published target", () => {
    sm.create("/tmp", "model", "provider", "source");
    const transcript = join(tmpDir, "source", "transcript.jsonl");
    appendFileSync(transcript, "not-json\n");
    expect(() => sm.fork("source", { targetSessionId: "target" })).toThrow(/malformed/);
    expect(existsSync(join(tmpDir, "target"))).toBe(false);
    expect(readdirSync(tmpDir).some((entry) => entry.startsWith(".pending-fork"))).toBe(false);
  });

  it("does not overwrite an existing target", () => {
    sm.create("/tmp", "model", "provider", "source");
    const existing = sm.create("/tmp", "other", "provider", "target");
    expect(() => sm.fork("source", { targetSessionId: "target" })).toThrow(/already exists/);
    expect(sm.resume("target").state.model).toBe(existing.state.model);
  });

  it("throws on resume of nonexistent session", () => {
    expect(() => sm.resume("nonexistent")).toThrow();
  });
});

describe("FileHistory", () => {
  let tmpDir: string;
  let testFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "filehistory-test-"));
    testFile = join(tmpDir, "test.txt");
    writeFileSync(testFile, "original content");
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("saves and retrieves file snapshots", () => {
    const fh = new FileHistory(tmpDir);
    const snapshot = fh.saveSnapshot(testFile);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.filePath).toContain("test.txt");

    const snapshots = fh.getSnapshots(testFile);
    expect(snapshots).toHaveLength(1);
  });

  it("does not duplicate identical snapshots", () => {
    const fh = new FileHistory(tmpDir);
    fh.saveSnapshot(testFile);
    fh.saveSnapshot(testFile);
    expect(fh.getSnapshots(testFile)).toHaveLength(1);
  });

  it("restores file from snapshot", () => {
    const fh = new FileHistory(tmpDir);
    fh.saveSnapshot(testFile);

    // Modify the file
    writeFileSync(testFile, "modified content");
    expect(readFileSync(testFile, "utf-8")).toBe("modified content");

    // Restore
    const ok = fh.restoreLatest(testFile);
    expect(ok).toBe(true);
    expect(readFileSync(testFile, "utf-8")).toBe("original content");
  });

  it("returns null for nonexistent file", () => {
    const fh = new FileHistory(tmpDir);
    expect(fh.saveSnapshot("/nonexistent/path")).toBeNull();
  });
});

describe("MemoryManager", () => {
  let tmpDir: string;
  let mm: MemoryManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memory-test-"));
    mm = new MemoryManager({ baseDir: tmpDir });
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("saves and loads a memory entry", () => {
    mm.save({
      name: "test memory",
      description: "a test",
      type: "user",
      content: "User prefers TypeScript",
    });

    const entries = mm.loadAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("test memory");
    expect(entries[0].content).toContain("TypeScript");
  });

  it("deletes a memory", () => {
    mm.save({ name: "to-delete", description: "temp", type: "project", content: "x" });
    expect(mm.loadAll()).toHaveLength(1);
    mm.delete("to-delete");
    expect(mm.loadAll()).toHaveLength(0);
  });

  it("builds memory context for prompt", () => {
    mm.save({
      name: "pref",
      description: "coding style",
      type: "feedback",
      content: "use snake_case",
    });
    const ctx = mm.buildMemoryContext();
    expect(ctx).toContain("Persistent Memory");
    expect(ctx).toContain("pref");
    expect(ctx).toContain("coding style");
  });

  it("returns empty string when no memories", () => {
    expect(mm.buildMemoryContext()).toBe("");
  });

  it("updates MEMORY.md index", () => {
    mm.save({ name: "entry1", description: "first", type: "user", content: "a" });
    mm.save({ name: "entry2", description: "second", type: "project", content: "b" });
    const index = mm.getIndex();
    expect(index).toContain("entry1");
    expect(index).toContain("entry2");
  });

  it("writes under baseDir, not home", () => {
    mm.save({ name: "scoped", description: "x", type: "user", content: "y" });
    const dir = mm.getMemoryDir();
    expect(dir.startsWith(tmpDir)).toBe(true);
    expect(dir).toContain("memory");
  });

  it("scopes by projectDir under baseDir", () => {
    const scoped = new MemoryManager({ baseDir: tmpDir, projectDir: "/some/project" });
    expect(scoped.getMemoryDir().startsWith(tmpDir)).toBe(true);
    expect(scoped.getMemoryDir()).toContain("projects");
  });

  it("falls back to CODE_SHELL_HOME env when no baseDir given", () => {
    const prev = process.env.CODE_SHELL_HOME;
    const envDir = mkdtempSync(join(tmpdir(), "memory-env-"));
    process.env.CODE_SHELL_HOME = envDir;
    try {
      const envMm = new MemoryManager();
      expect(envMm.getMemoryDir().startsWith(envDir)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CODE_SHELL_HOME;
      else process.env.CODE_SHELL_HOME = prev;
      rmSync(envDir, { recursive: true, force: true });
    }
  });

  it("baseDir option overrides env", () => {
    const prev = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = "/tmp/should-not-be-used-xyz";
    try {
      const overrideMm = new MemoryManager({ baseDir: tmpDir });
      expect(overrideMm.getMemoryDir().startsWith(tmpDir)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CODE_SHELL_HOME;
      else process.env.CODE_SHELL_HOME = prev;
    }
  });
});
