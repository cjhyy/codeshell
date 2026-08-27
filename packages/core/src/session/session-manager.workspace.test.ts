import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

describe("SessionManager SessionWorkspace", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sm-ws-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("create persists a main workspace pointer in state.json", () => {
    const sm = new SessionManager(dir);
    const b = sm.create("/repo/main", "m", "p", "s-main");

    expect(b.state.workspace).toEqual({ root: "/repo/main", kind: "main" });
    expect(sm.getSessionWorkspace("s-main")).toEqual({ root: "/repo/main", kind: "main" });

    const onDisk = JSON.parse(readFileSync(join(dir, "s-main", "state.json"), "utf-8"));
    expect(onDisk.workspace).toEqual({ root: "/repo/main", kind: "main" });
  });

  test("setSessionWorkspace updates only the workspace pointer", () => {
    const sm = new SessionManager(dir);
    sm.create("/repo/main", "m", "p", "s-wt");

    const workspace = {
      root: "/repo/.worktrees/feature",
      kind: "worktree" as const,
      worktree: {
        path: "/repo/.worktrees/feature",
        branch: "worktree/feature-s-wt",
        baseRef: "main",
        createdBy: "codeshell" as const,
      },
    };

    sm.setSessionWorkspace("s-wt", workspace);

    expect(sm.getSessionWorkspace("s-wt")).toEqual(workspace);
    expect(sm.readSessionMainRoot("s-wt")).toBe("/repo/main");

    const onDisk = JSON.parse(readFileSync(join(dir, "s-wt", "state.json"), "utf-8"));
    expect(onDisk.workspace).toEqual(workspace);
    expect(onDisk.cwd).toBe("/repo/main");
  });

  test("legacy sessions without workspace still resume and get a main fallback", () => {
    const sm = new SessionManager(dir);
    sm.create("/legacy/repo", "m", "p", "legacy");

    const stateFile = join(dir, "legacy", "state.json");
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    delete state.workspace;
    writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");

    expect(sm.resume("legacy").state.workspace).toBeUndefined();
    expect(sm.getSessionWorkspace("legacy")).toEqual({ root: "/legacy/repo", kind: "main" });
  });

  test("atomically migrates the project binding, cwd, and worktree pointer without persisting derived status", () => {
    const sm = new SessionManager(dir);
    sm.create("/repo/old", "m", "p", "s-migrate");
    sm.updateSessionState("s-migrate", {
      project: { projectId: "project-1", mainRootId: "root-old" },
      workspace: {
        root: "/repo/.worktrees/feature",
        kind: "worktree",
        worktree: {
          path: "/repo/.worktrees/feature",
          branch: "worktree/feature",
          baseRef: "main",
          createdBy: "codeshell",
        },
      },
    });

    sm.migrateSessionMainRoot(
      "s-migrate",
      { projectId: "project-1", mainRootId: "root-new" },
      "/repo/new",
    );

    const state = JSON.parse(readFileSync(join(dir, "s-migrate", "state.json"), "utf8"));
    expect(state).toMatchObject({
      cwd: "/repo/new",
      project: { projectId: "project-1", mainRootId: "root-new" },
      workspace: { root: "/repo/new", kind: "main" },
    });
    expect(state.workspaceMissing).toBeUndefined();
    expect(state.rootStatus).toBeUndefined();
  });

  test("keeps the complete previous root state when the atomic migration write fails", () => {
    if (process.platform === "win32") return;
    const sm = new SessionManager(dir);
    sm.create("/repo/old", "m", "p", "s-rollback");
    sm.updateSessionState("s-rollback", {
      project: { projectId: "project-1", mainRootId: "root-old" },
    });
    const stateFile = join(dir, "s-rollback", "state.json");
    const before = readFileSync(stateFile, "utf8");
    chmodSync(join(dir, "s-rollback"), 0o500);
    try {
      expect(() =>
        sm.migrateSessionMainRoot(
          "s-rollback",
          { projectId: "project-1", mainRootId: "root-new" },
          "/repo/new",
        ),
      ).toThrow();
      expect(readFileSync(stateFile, "utf8")).toBe(before);
    } finally {
      chmodSync(join(dir, "s-rollback"), 0o700);
    }
  });
});
