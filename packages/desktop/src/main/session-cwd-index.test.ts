import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  SessionCwdIndex,
  type SessionCwdIndexFs,
  type SessionCwdIndexState,
  type SessionCwdIndexSyncFs,
} from "./session-cwd-index.js";

function fakeFs(initial: Record<string, SessionCwdIndexState>): {
  fs: SessionCwdIndexFs;
  states: Map<string, SessionCwdIndexState>;
  counts: { readdir: number; readFile: number; stat: number };
} {
  const states = new Map(Object.entries(initial));
  const counts = { readdir: 0, readFile: 0, stat: 0 };
  const fs: SessionCwdIndexFs = {
    async readdir() {
      counts.readdir += 1;
      return [...states.keys()].map((name) => ({ name, isDirectory: () => true }));
    },
    async readFile(file) {
      counts.readFile += 1;
      const sessionId = file.split("/").at(-2) ?? "";
      const state = states.get(sessionId);
      if (!state) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return JSON.stringify(state);
    },
    async stat(file) {
      counts.stat += 1;
      const sessionId = file.split("/").at(-2) ?? "";
      if (!states.has(sessionId)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isFile: () => true };
    },
  };
  return { fs, states, counts };
}

describe("SessionCwdIndex", () => {
  test("scans 5,000 sessions once and serves repeated batch queries without I/O", async () => {
    const input: Record<string, SessionCwdIndexState> = {};
    for (let i = 0; i < 5_000; i += 1) {
      input[`s-${i}`] = { sessionId: `s-${i}`, cwd: `/repo/${i}` };
    }
    const fixture = fakeFs(input);
    const index = new SessionCwdIndex({ sessionsRoot: "/sessions", fs: fixture.fs });

    await index.ensureLoaded();
    expect(fixture.counts).toEqual({ readdir: 1, readFile: 5_000, stat: 0 });
    expect(index.resolveConfirmedCwds(["/repo/7", "/repo/4000", "/missing"])).toEqual([
      true,
      true,
      false,
    ]);
    expect(index.resolveConfirmedCwds(["/repo/7"])).toEqual([true]);
    expect(await index.lookup("s-7")).toMatchObject({ cwd: "/repo/7", status: "confirmed" });
    expect(fixture.counts).toEqual({ readdir: 1, readFile: 5_000, stat: 0 });
  });

  test("a miss reads only that session state and captures workspace plus project binding", async () => {
    const fixture = fakeFs({});
    const index = new SessionCwdIndex({ sessionsRoot: "/sessions", fs: fixture.fs });
    await index.ensureLoaded();
    fixture.states.set("external", {
      sessionId: "external",
      cwd: "/repo",
      workspace: { kind: "worktree", root: "/worktree" },
      project: { projectId: "p1", mainRootId: "r1" },
    });

    expect(await index.lookup("external")).toEqual({
      sessionId: "external",
      cwd: "/repo",
      workspaceRoot: "/worktree",
      projectId: "p1",
      mainRootId: "r1",
      status: "confirmed",
    });
    expect(fixture.counts).toEqual({ readdir: 1, readFile: 1, stat: 1 });
    expect(await index.lookup("external")).toMatchObject({ workspaceRoot: "/worktree" });
    expect(fixture.counts).toEqual({ readdir: 1, readFile: 1, stat: 1 });
  });

  test("a synchronous cold miss reads exactly one externally-created Session state", async () => {
    const fixture = fakeFs({});
    const syncCounts = { readFile: 0, stat: 0 };
    const state: SessionCwdIndexState = {
      sessionId: "external-sync",
      cwd: "/repo",
      workspace: { kind: "worktree", root: "/worktree" },
      project: { projectId: "p1", mainRootId: "r1" },
    };
    const syncFs: SessionCwdIndexSyncFs = {
      readFileSync() {
        syncCounts.readFile += 1;
        return JSON.stringify(state);
      },
      statSync() {
        syncCounts.stat += 1;
        return { isFile: () => true };
      },
    };
    const index = new SessionCwdIndex({
      sessionsRoot: "/sessions",
      fs: fixture.fs,
      syncFs,
    });
    await index.ensureLoaded();

    expect(index.lookupCached("external-sync")).toBeUndefined();
    expect(index.refreshSync("external-sync")).toEqual({
      sessionId: "external-sync",
      cwd: "/repo",
      workspaceRoot: "/worktree",
      projectId: "p1",
      mainRootId: "r1",
      status: "confirmed",
    });
    expect(syncCounts).toEqual({ readFile: 1, stat: 1 });
    expect(index.lookupCached("external-sync")?.workspaceRoot).toBe("/worktree");
    expect(syncCounts).toEqual({ readFile: 1, stat: 1 });
  });

  test("refresh reads one state file and workspace updates never rescan", async () => {
    const fixture = fakeFs({ s1: { sessionId: "s1", cwd: "/repo" } });
    const index = new SessionCwdIndex({ sessionsRoot: "/sessions", fs: fixture.fs });
    await index.ensureLoaded();

    index.setWorkspaceRoot("s1", "/worktree-1");
    expect((await index.lookup("s1"))?.workspaceRoot).toBe("/worktree-1");
    fixture.states.set("s1", {
      sessionId: "s1",
      cwd: "/repo",
      workspace: { kind: "worktree", root: "/worktree-2" },
    });
    await index.refresh("s1");
    expect((await index.lookup("s1"))?.workspaceRoot).toBe("/worktree-2");
    expect(fixture.counts).toEqual({ readdir: 1, readFile: 2, stat: 1 });
  });

  test("tentative entries extend, confirm, expire, and evict without authorizing cwd", async () => {
    let now = 1_000;
    const fixture = fakeFs({});
    const index = new SessionCwdIndex({
      sessionsRoot: "/sessions",
      fs: fixture.fs,
      now: () => now,
      tentativeTtlMs: 100,
    });
    await index.ensureLoaded();

    index.setTentative("new", { cwd: "/repo" });
    expect(index.resolveConfirmedCwds(["/repo"])).toEqual([false]);
    now = 1_050;
    expect(index.extendTentative("new")).toBe(true);
    now = 1_120;
    expect(index.lookupCached("new")?.status).toBe("tentative");
    index.confirm("new");
    expect(index.resolveConfirmedCwds(["/repo"])).toEqual([true]);

    index.setTentative("failed", { cwd: "/failed" });
    expect(index.evictTentative("failed")).toBe(true);
    expect(index.lookupCached("failed")).toBeUndefined();

    index.setTentative("expired", { cwd: "/expired" });
    now += 101;
    expect(index.lookupCached("expired")).toBeUndefined();
  });

  test("upsert and forget update both lookup directions without rescanning", async () => {
    const fixture = fakeFs({});
    const index = new SessionCwdIndex({ sessionsRoot: "/sessions", fs: fixture.fs });
    await index.ensureLoaded();
    index.upsert("fork", { cwd: join("/repo", "fork"), workspaceRoot: "/wt" });
    expect(index.resolveConfirmedCwds([join("/repo", "fork")])).toEqual([true]);
    index.forget("fork");
    expect(index.resolveConfirmedCwds([join("/repo", "fork")])).toEqual([false]);
    expect(fixture.counts.readdir).toBe(1);
  });
});
