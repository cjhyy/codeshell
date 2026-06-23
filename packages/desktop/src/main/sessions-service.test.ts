import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteSessionDir, listInterruptedSubagents } from "./sessions-service";

describe("deleteSessionDir", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-ss-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("removes a session directory", async () => {
    const sdir = path.join(dir, "sess-1");
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, "transcript.jsonl"), "x");
    await deleteSessionDir("sess-1", dir);
    expect(fs.existsSync(sdir)).toBe(false);
  });

  it("removes a legacy flat file", async () => {
    fs.writeFileSync(path.join(dir, "sess-2.jsonl"), "x");
    await deleteSessionDir("sess-2", dir);
    expect(fs.existsSync(path.join(dir, "sess-2.jsonl"))).toBe(false);
  });

  it("is a no-op (no throw) when nothing exists", async () => {
    await deleteSessionDir("ghost", dir);
    expect(true).toBe(true);
  });

  it("refuses to delete for an unsafe id (path traversal)", async () => {
    // Create a sibling dir one level above baseDir's child to prove no escape.
    const victim = path.join(dir, "victim");
    fs.mkdirSync(victim, { recursive: true });
    await deleteSessionDir("..", dir);          // bare ".." must be rejected
    await deleteSessionDir("../victim", dir);    // slashes + .. rejected
    expect(fs.existsSync(victim)).toBe(true);
  });
});

describe("listInterruptedSubagents (C: reopen shows interrupted sub-agents)", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-int-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function makeSession(
    id: string,
    state: Record<string, unknown>,
    mtimeMs?: number,
  ) {
    const sdir = path.join(dir, id);
    fs.mkdirSync(sdir, { recursive: true });
    const f = path.join(sdir, "state.json");
    fs.writeFileSync(f, JSON.stringify({ sessionId: id, ...state }));
    if (mtimeMs !== undefined) {
      const t = mtimeMs / 1000;
      fs.utimesSync(f, t, t);
      fs.utimesSync(sdir, t, t);
    }
  }

  const PARENT = "s-parent";
  // staleMs threshold injected small for tests; "now" fixed.
  const opts = { staleMs: 1000, now: 100_000 };

  it("lists a stuck (status=active, stale) sub-agent of the parent", async () => {
    makeSession("childA", { parentSessionId: PARENT, status: "active", summary: "导演分析 ep01" }, 0);
    const out = await listInterruptedSubagents(PARENT, dir, opts);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("childA");
    expect(out[0]!.description).toBe("导演分析 ep01");
  });

  it("excludes completed sub-agents", async () => {
    makeSession("done1", { parentSessionId: PARENT, status: "completed", summary: "d" }, 0);
    const out = await listInterruptedSubagents(PARENT, dir, opts);
    expect(out).toHaveLength(0);
  });

  it("excludes an active sub-agent that is still FRESH (recent mtime = maybe still running)", async () => {
    makeSession("fresh1", { parentSessionId: PARENT, status: "active", summary: "d" }, 99_500); // 500ms ago < 1000ms threshold
    const out = await listInterruptedSubagents(PARENT, dir, opts);
    expect(out).toHaveLength(0);
  });

  it("excludes sub-agents of a DIFFERENT parent", async () => {
    makeSession("other", { parentSessionId: "s-other", status: "active", summary: "d" }, 0);
    const out = await listInterruptedSubagents(PARENT, dir, opts);
    expect(out).toHaveLength(0);
  });

  it("excludes the parent/top-level session itself", async () => {
    makeSession("s-parent", { parentSessionId: null, status: "active", summary: "d" }, 0);
    const out = await listInterruptedSubagents(PARENT, dir, opts);
    expect(out).toHaveLength(0);
  });

  it("excludes a user-cancelled sub-agent (deliberate stop, not a surprise)", async () => {
    makeSession("cx", { parentSessionId: PARENT, status: "cancelled", summary: "d" }, 0);
    const out = await listInterruptedSubagents(PARENT, dir, opts);
    expect(out).toHaveLength(0);
  });

  it("flags an error-ended sub-agent (model_error / aborted_streaming) when stale", async () => {
    makeSession("err1", { parentSessionId: PARENT, status: "model_error", summary: "导演" }, 0);
    makeSession("abrt", { parentSessionId: PARENT, status: "aborted_streaming", summary: "服化道" }, 0);
    const out = await listInterruptedSubagents(PARENT, dir, opts);
    expect(out.map((o) => o.id).sort()).toEqual(["abrt", "err1"]);
  });

  it("returns [] when the sessions dir does not exist", async () => {
    const out = await listInterruptedSubagents(PARENT, path.join(dir, "nope"), opts);
    expect(out).toEqual([]);
  });
});
