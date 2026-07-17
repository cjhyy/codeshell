// packages/server/src/sessions-service.disk.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { archiveDiskSession, listDiskSessions } from "./sessions-service";

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
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

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
    mkSession(
      dir,
      "deleted",
      { cwd: path.join(dir, "gone-project"), parentSessionId: null, summary: "删" },
      3000,
    );
    const { sessions } = await listDiskSessions({ limit: 10 }, dir);
    expect(sessions.map((s) => s.id)).toEqual(["alive"]);
  });

  it("filters OUT sub-agent sessions (parentSessionId is a non-empty string)", async () => {
    mkSession(dir, "top-1", { cwd: "/p", parentSessionId: null }, 2000);
    mkSession(dir, "sub-1", { cwd: "/p", parentSessionId: "top-1" }, 3000);
    const { sessions } = await listDiskSessions({ limit: 10 }, dir);
    expect(sessions.map((s) => s.id)).toEqual(["top-1"]);
  });

  it("filters ephemeral and legacy qchat sessions out of the ordinary picker", async () => {
    mkSession(dir, "normal", { cwd: "/p", parentSessionId: null }, 1000);
    mkSession(dir, "side-with-marker", { cwd: "/p", parentSessionId: null, ephemeral: true }, 2000);
    mkSession(dir, "qchat-legacy", { cwd: "/p", parentSessionId: null }, 3000);

    const { sessions } = await listDiskSessions({ limit: 10 }, dir);

    expect(sessions.map((s) => s.id)).toEqual(["normal"]);
  });

  it("filters durable pet sessions out of the ordinary work catalog", async () => {
    mkSession(dir, "normal", { cwd: "/p", parentSessionId: null, kind: "work" }, 1000);
    mkSession(dir, "local-pet", { cwd: "/p", parentSessionId: null, kind: "pet" }, 2000);

    const { sessions } = await listDiskSessions({ limit: 10 }, dir);

    expect(sessions.map((session) => session.id)).toEqual(["normal"]);
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
    for (let i = 0; i < 5; i++)
      mkSession(dir, `s${i}`, { cwd: "/p", parentSessionId: null }, 1000 + i * 1000);
    const p1 = await listDiskSessions({ limit: 2 }, dir);
    expect(p1.sessions.map((s) => s.id)).toEqual(["s4", "s3"]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listDiskSessions({ limit: 2, cursor: p1.nextCursor! }, dir);
    expect(p2.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("keeps the next page stable when an earlier session is deleted", async () => {
    for (let i = 0; i < 5; i++)
      mkSession(dir, `s${i}`, { cwd: "/p", parentSessionId: null }, 1000 + i * 1000);
    const p1 = await listDiskSessions({ limit: 2 }, dir);
    fs.rmSync(path.join(dir, "s4"), { recursive: true, force: true });

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

  it("filters archived sessions by default and includes them on demand", async () => {
    mkSession(dir, "live", { cwd: "/p", parentSessionId: null, status: "completed" }, 2000);
    mkSession(
      dir,
      "gone",
      { cwd: "/p", parentSessionId: null, status: "completed", archivedAt: 123 },
      3000,
    );

    const dflt = await listDiskSessions({ limit: 50 }, dir);
    expect(dflt.sessions.map((s) => s.id)).toEqual(["live"]);
    expect(dflt.sessions[0]!.archivedAt).toBeUndefined();

    const all = await listDiskSessions({ limit: 50, includeArchived: true }, dir);
    expect(all.sessions.map((s) => s.id).sort()).toEqual(["gone", "live"]);
    expect(all.sessions.find((s) => s.id === "gone")?.archivedAt).toBe(123);
  });

  it("paginates correctly while filtering archived sessions out by default", async () => {
    // Interleave archived and live sessions across page boundaries. Default
    // filtering must never skip a live session nor stall the cursor: walking
    // all pages must surface exactly the live ones, newest first.
    for (let i = 0; i < 6; i++) {
      const archived = i % 2 === 0; // s0,s2,s4 archived; s1,s3,s5 live
      mkSession(
        dir,
        `s${i}`,
        {
          cwd: "/p",
          parentSessionId: null,
          status: "completed",
          ...(archived ? { archivedAt: 1 } : {}),
        },
        1000 + i * 1000,
      );
    }

    const collected: string[] = [];
    let cursor: string | null | undefined;
    // Bound the loop so a pagination bug surfaces as a wrong result, not a hang.
    for (let page = 0; page < 20; page++) {
      const res = await listDiskSessions({ limit: 2, cursor: cursor ?? undefined }, dir);
      collected.push(...res.sessions.map((s) => s.id));
      cursor = res.nextCursor;
      if (cursor === null) break;
    }
    expect(collected).toEqual(["s5", "s3", "s1"]);
  });
});

describe("archiveDiskSession", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-archive-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes archivedAt so the session drops out of the default catalog, then unarchives", async () => {
    mkSession(dir, "work", { cwd: "/p", parentSessionId: null, status: "completed" }, 3000);

    await archiveDiskSession("work", 456, dir);
    // Preserved the rest of state.json.
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, "work", "state.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(raw.archivedAt).toBe(456);
    expect(raw.status).toBe("completed");
    expect(raw.parentSessionId).toBe(null);

    const dflt = await listDiskSessions({ limit: 50 }, dir);
    expect(dflt.sessions.map((s) => s.id)).toEqual([]);
    const all = await listDiskSessions({ limit: 50, includeArchived: true }, dir);
    expect(all.sessions.find((s) => s.id === "work")?.archivedAt).toBe(456);

    // Clearing the marker restores the session to the default catalog.
    await archiveDiskSession("work", undefined, dir);
    const reopened = JSON.parse(
      fs.readFileSync(path.join(dir, "work", "state.json"), "utf8"),
    ) as Record<string, unknown>;
    expect("archivedAt" in reopened).toBe(false);
    const afterUnarchive = await listDiskSessions({ limit: 50 }, dir);
    expect(afterUnarchive.sessions.map((s) => s.id)).toEqual(["work"]);
  });

  it("rejects unsafe ids without touching the filesystem", async () => {
    await expect(archiveDiskSession("../escape", 1, dir)).rejects.toThrow();
    await expect(archiveDiskSession("missing", 1, dir)).rejects.toThrow();
  });
});
