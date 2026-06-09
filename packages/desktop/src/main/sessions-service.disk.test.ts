// packages/desktop/src/main/sessions-service.disk.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { listDiskSessions } from "./sessions-service";

// Default origin "desktop" so existing fixtures are "should-show" sessions
// (override per-test by passing `origin` in state). A fixture wanting NO origin
// key (legacy) passes `origin: undefined` explicitly — handled below.
function mkSession(base: string, id: string, state: Record<string, unknown>, mtime: number) {
  const dir = path.join(base, id);
  fs.mkdirSync(dir, { recursive: true });
  // listDiskSessions now drops sessions whose cwd was deleted, so the fixture's
  // cwd must actually exist. Materialize a real dir under the temp base and use
  // it as the session cwd (unless the test pins its own absolute cwd).
  if (state.cwd === undefined || state.cwd === "/p") {
    const cwdDir = path.join(base, "cwd");
    fs.mkdirSync(cwdDir, { recursive: true });
    state = { ...state, cwd: cwdDir };
  }
  const full: Record<string, unknown> = { sessionId: id, origin: "desktop", ...state };
  // Drop keys explicitly set to undefined so the JSON omits them (legacy case).
  for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(full));
  fs.writeFileSync(path.join(dir, "transcript.jsonl"), "");
  fs.utimesSync(dir, new Date(mtime), new Date(mtime));
}

describe("listDiskSessions", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns top-level sessions (parentSessionId === null), newest first", async () => {
    mkSession(dir, "top-old", { cwd: "/p", summary: "老", parentSessionId: null }, 1000);
    mkSession(dir, "top-new", { cwd: "/p", summary: "新", parentSessionId: null }, 3000);
    const { sessions } = await listDiskSessions({ limit: 10 }, dir);
    expect(sessions.map((s) => s.id)).toEqual(["top-new", "top-old"]);
    expect(sessions[0]).toMatchObject({ id: "top-new", engineSessionId: "top-new", title: "新" });
  });

  it("drops sessions whose cwd was deleted (deleted-project resurrection guard)", async () => {
    mkSession(dir, "alive", { cwd: "/p", parentSessionId: null, summary: "在" }, 2000);
    // cwd points at a path that does not exist on disk → must be filtered out.
    mkSession(dir, "deleted", { cwd: path.join(dir, "gone-project"), parentSessionId: null, summary: "删" }, 3000);
    const { sessions } = await listDiskSessions({ limit: 10 }, dir);
    expect(sessions.map((s) => s.id)).toEqual(["alive"]);
  });

  it("filters OUT sub-agent sessions (parentSessionId is a non-empty string)", async () => {
    mkSession(dir, "top-1", { cwd: "/p", parentSessionId: null }, 2000);
    mkSession(dir, "sub-1", { cwd: "/p", parentSessionId: "top-1" }, 3000);
    const { sessions } = await listDiskSessions({ limit: 10 }, dir);
    expect(sessions.map((s) => s.id)).toEqual(["top-1"]);
  });

  it("skips legacy sessions with NO parentSessionId key (存量 not auto-rebuilt)", async () => {
    mkSession(dir, "legacy-1", { cwd: "/p", summary: "旧" }, 2000); // no parentSessionId key at all
    mkSession(dir, "new-top", { cwd: "/p", parentSessionId: null }, 1000);
    const { sessions } = await listDiskSessions({ limit: 10 }, dir);
    expect(sessions.map((s) => s.id)).toEqual(["new-top"]);
  });

  it("falls back to id when summary missing", async () => {
    mkSession(dir, "no-sum", { cwd: "/p", parentSessionId: null }, 1000);
    const { sessions } = await listDiskSessions({ limit: 10 }, dir);
    expect(sessions[0].title).toBe("no-sum");
  });

  it("paginates with limit + cursor", async () => {
    for (let i = 0; i < 5; i++) mkSession(dir, `s${i}`, { cwd: "/p", parentSessionId: null }, 1000 + i * 1000);
    const p1 = await listDiskSessions({ limit: 2 }, dir);
    expect(p1.sessions.map((s) => s.id)).toEqual(["s4", "s3"]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listDiskSessions({ limit: 2, cursor: p1.nextCursor! }, dir);
    expect(p2.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("shows desktop + automation origins; hides tui and origin-less", async () => {
    mkSession(dir, "d1", { cwd: "/p", parentSessionId: null, origin: "desktop" }, 4000);
    mkSession(dir, "a1", { cwd: "/p", parentSessionId: null, origin: "automation" }, 3000);
    mkSession(dir, "t1", { cwd: "/p", parentSessionId: null, origin: "tui" }, 2000);
    mkSession(dir, "n1", { cwd: "/p", parentSessionId: null, origin: undefined }, 1000); // no origin key
    const { sessions } = await listDiskSessions({ limit: 10 }, dir);
    expect(sessions.map((s) => s.id)).toEqual(["d1", "a1"]);
    expect(sessions[0].origin).toBe("desktop");
    expect(sessions[1].origin).toBe("automation");
  });

  it("returns [] for a missing sessions dir", async () => {
    expect((await listDiskSessions({ limit: 10 }, path.join(dir, "nope"))).sessions).toEqual([]);
  });
});
