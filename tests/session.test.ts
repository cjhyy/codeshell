import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SessionManager } from "../src/session/session-manager.js";
import { FileHistory } from "../src/session/file-history.js";
import { MemoryManager } from "../src/session/memory.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

  it("forks a session", () => {
    const original = sm.create("/tmp", "model", "prov");
    original.transcript.appendMessage("user", "task1");
    original.transcript.appendTurnBoundary();
    original.transcript.appendMessage("user", "task2");
    sm.saveState(original.state);

    const forked = sm.fork(original.state.sessionId, 1);
    expect(forked.state.parentSessionId).toBe(original.state.sessionId);
    expect(forked.state.sessionId).not.toBe(original.state.sessionId);
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
    mm.save({ name: "pref", description: "coding style", type: "feedback", content: "use snake_case" });
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
