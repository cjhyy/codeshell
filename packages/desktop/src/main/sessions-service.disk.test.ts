// packages/desktop/src/main/sessions-service.disk.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { listDiskSessions } from "./sessions-service";

function mkSession(base: string, id: string, state: Record<string, unknown>, mtime: number) {
  const dir = path.join(base, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ sessionId: id, ...state }));
  fs.writeFileSync(path.join(dir, "transcript.jsonl"), "");
  fs.utimesSync(dir, new Date(mtime), new Date(mtime));
}

describe("listDiskSessions", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns top-level sessions (parentSessionId === null), newest first", () => {
    mkSession(dir, "top-old", { cwd: "/p", summary: "老", parentSessionId: null }, 1000);
    mkSession(dir, "top-new", { cwd: "/p", summary: "新", parentSessionId: null }, 3000);
    const { sessions } = listDiskSessions({ limit: 10 }, dir);
    expect(sessions.map((s) => s.id)).toEqual(["top-new", "top-old"]);
    expect(sessions[0]).toMatchObject({ id: "top-new", engineSessionId: "top-new", cwd: "/p", title: "新" });
  });

  it("filters OUT sub-agent sessions (parentSessionId is a non-empty string)", () => {
    mkSession(dir, "top-1", { cwd: "/p", parentSessionId: null }, 2000);
    mkSession(dir, "sub-1", { cwd: "/p", parentSessionId: "top-1" }, 3000);
    const { sessions } = listDiskSessions({ limit: 10 }, dir);
    expect(sessions.map((s) => s.id)).toEqual(["top-1"]);
  });

  it("skips legacy sessions with NO parentSessionId key (存量 not auto-rebuilt)", () => {
    mkSession(dir, "legacy-1", { cwd: "/p", summary: "旧" }, 2000); // no parentSessionId key at all
    mkSession(dir, "new-top", { cwd: "/p", parentSessionId: null }, 1000);
    const { sessions } = listDiskSessions({ limit: 10 }, dir);
    expect(sessions.map((s) => s.id)).toEqual(["new-top"]);
  });

  it("falls back to id when summary missing", () => {
    mkSession(dir, "no-sum", { cwd: "/p", parentSessionId: null }, 1000);
    const { sessions } = listDiskSessions({ limit: 10 }, dir);
    expect(sessions[0].title).toBe("no-sum");
  });

  it("paginates with limit + cursor", () => {
    for (let i = 0; i < 5; i++) mkSession(dir, `s${i}`, { cwd: "/p", parentSessionId: null }, 1000 + i * 1000);
    const p1 = listDiskSessions({ limit: 2 }, dir);
    expect(p1.sessions.map((s) => s.id)).toEqual(["s4", "s3"]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = listDiskSessions({ limit: 2, cursor: p1.nextCursor! }, dir);
    expect(p2.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("returns [] for a missing sessions dir", () => {
    expect(listDiskSessions({ limit: 10 }, path.join(dir, "nope")).sessions).toEqual([]);
  });
});
