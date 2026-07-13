import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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
});
