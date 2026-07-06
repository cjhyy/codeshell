import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { enterWorktreeTool, exitWorktreeTool } from "./worktree.js";
import { removeWorktree } from "../../git/worktree.js";
import { SessionManager } from "../../session/session-manager.js";
import type { ToolContext } from "../context.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
}

describe("ExitWorktree cleanup actions", () => {
  let repo: string;
  let sessions: string;
  let sm: SessionManager;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cs-wt-tool-"));
    sessions = mkdtempSync(join(tmpdir(), "cs-wt-sessions-"));
    sm = new SessionManager(sessions);
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
  });
  afterEach(async () => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(join(repo, "..", ".worktrees"), { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  });

  function ctx(sessionId: string, cwd = repo): ToolContext {
    if (!sm.exists(sessionId)) sm.create(repo, "m", "p", sessionId);
    const toolCtx = {
      cwd,
      sessionId,
      engine: {
        getSessionManager: () => sm,
        readWorktreeSetupScripts: () => undefined,
      },
      setCwd(next: string) {
        this.cwd = next;
      },
    } as unknown as ToolContext;
    return toolCtx;
  }

  test("keep preserves the directory and branch", async () => {
    const toolCtx = ctx("keep123456");
    await enterWorktreeTool({ target: "keep" }, toolCtx);
    const active = sm.getSessionWorkspace("keep123456")!.worktree!;

    const out = await exitWorktreeTool({ action: "keep" }, toolCtx);

    expect(out).toContain("preserved");
    expect(existsSync(active.path)).toBe(true);
    expect(git(repo, ["branch", "--list", active.branch])).toContain(active.branch);
    expect(sm.getSessionWorkspace("keep123456")).toEqual({ root: repo, kind: "main" });
    removeWorktree(active.path, true);
  });

  test("detach removes the directory and keeps the branch", async () => {
    const toolCtx = ctx("detach123456");
    await enterWorktreeTool({ target: "detach" }, toolCtx);
    const active = sm.getSessionWorkspace("detach123456")!.worktree!;

    const out = await exitWorktreeTool({ action: "detach" }, toolCtx);

    expect(out).toContain("Branch");
    expect(existsSync(active.path)).toBe(false);
    expect(git(repo, ["branch", "--list", active.branch])).toContain(active.branch);
    expect(sm.getSessionWorkspace("detach123456")).toEqual({ root: repo, kind: "main" });
  });

  test("discard removes the directory and deletes the branch", async () => {
    const toolCtx = ctx("discard123456");
    await enterWorktreeTool({ target: "discard" }, toolCtx);
    const active = sm.getSessionWorkspace("discard123456")!.worktree!;

    const out = await exitWorktreeTool({ action: "discard" }, toolCtx);

    expect(out).toContain("deleted");
    expect(existsSync(active.path)).toBe(false);
    expect(git(repo, ["branch", "--list", active.branch])).toBe("");
    expect(sm.getSessionWorkspace("discard123456")).toEqual({ root: repo, kind: "main" });
  });

  test("omitted action auto-detaches a clean worktree", async () => {
    const toolCtx = ctx("auto123456");
    await enterWorktreeTool({ target: "auto" }, toolCtx);
    const active = sm.getSessionWorkspace("auto123456")!.worktree!;

    const out = await exitWorktreeTool({}, toolCtx);

    expect(out).toContain("auto");
    expect(existsSync(active.path)).toBe(false);
    expect(git(repo, ["branch", "--list", active.branch])).toContain(active.branch);
    expect(sm.getSessionWorkspace("auto123456")).toEqual({ root: repo, kind: "main" });
  });

  test("omitted action refuses to clean a worktree with uncommitted changes", async () => {
    const toolCtx = ctx("dirty123456");
    await enterWorktreeTool({ target: "dirty" }, toolCtx);
    const before = sm.getSessionWorkspace("dirty123456")!;
    const active = before.worktree!;
    writeFileSync(join(active.path, "dirty.txt"), "dirty\n");

    const out = await exitWorktreeTool({}, toolCtx);

    expect(out.toLowerCase()).toContain("error");
    expect(out).toContain("keep");
    expect(out).toContain("discard");
    expect(existsSync(active.path)).toBe(true);
    expect(sm.getSessionWorkspace("dirty123456")).toEqual(before);
    removeWorktree(active.path, true);
  });

  test("detach refuses to drop uncommitted changes", async () => {
    const toolCtx = ctx("dirtydt123456");
    await enterWorktreeTool({ target: "dirty-detach" }, toolCtx);
    const before = sm.getSessionWorkspace("dirtydt123456")!;
    const active = before.worktree!;
    writeFileSync(join(active.path, "dirty.txt"), "dirty\n");

    const out = await exitWorktreeTool({ action: "detach" }, toolCtx);

    expect(out.toLowerCase()).toContain("error");
    expect(out).toContain("keep");
    expect(out).toContain("discard");
    expect(existsSync(active.path)).toBe(true);
    expect(sm.getSessionWorkspace("dirtydt123456")).toEqual(before);
    removeWorktree(active.path, true);
  });

  test("enter A then exit keep then enter B succeeds with A still on disk", async () => {
    const toolCtx = ctx("switch123456");
    await enterWorktreeTool({ target: "a" }, toolCtx);
    const a = sm.getSessionWorkspace("switch123456")!.worktree!;

    await exitWorktreeTool({ action: "keep" }, toolCtx);
    const out = await enterWorktreeTool({ target: "b" }, toolCtx);
    const b = sm.getSessionWorkspace("switch123456")!.worktree!;

    expect(out).not.toContain("Already in a worktree");
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);
    expect(a.path).not.toBe(b.path);
    removeWorktree(a.path, true);
    removeWorktree(b.path, true);
  });

  test("two sessions can switch to the same existing worktree directory", async () => {
    const first = ctx("shared111111");
    const second = ctx("shared222222");
    await enterWorktreeTool({ target: "shared" }, first);
    const shared = sm.getSessionWorkspace("shared111111")!.worktree!;

    const out = await enterWorktreeTool({ target: shared.path }, second);

    expect(out).toContain("Switched");
    expect(sm.getSessionWorkspace("shared111111")!.root).toBe(shared.path);
    expect(sm.getSessionWorkspace("shared222222")!.root).toBe(shared.path);
    expect(sm.getSessionWorkspace("shared222222")!.worktree!.branch).toBe(shared.branch);
    removeWorktree(shared.path, true);
  });

  test("enter updates the live ToolContext cwd to the target root", async () => {
    const toolCtx = ctx("ctxcwd123456");

    await enterWorktreeTool({ target: "ctxcwd" }, toolCtx);
    const ws = sm.getSessionWorkspace("ctxcwd123456")!;
    const transcript = readFileSync(join(sessions, "ctxcwd123456", "transcript.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const lastMeta = transcript.filter((event) => event.type === "session_meta").at(-1);

    expect(toolCtx.cwd).toBe(ws.root);
    expect(lastMeta.data.workspace.root).toBe(ws.root);
    expect(lastMeta.data.handoffFrom).toBe(repo);
    removeWorktree(ws.worktree!.path, true);
  });
});
