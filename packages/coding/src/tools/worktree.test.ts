import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createOffBackend, validateToolArgs } from "@cjhyy/code-shell-core/internal";
import {
  enterWorktreeTool,
  enterWorktreeToolDef,
  exitWorktreeTool,
  switchSessionWorkspaceTool,
  switchSessionWorkspaceToolDef,
} from "./worktree.js";
import { removeWorktree } from "../git/worktree.js";
import { SessionManager, type ToolContext } from "@cjhyy/code-shell-core";
import { codingToolService, type CodingToolService } from "../capability-runtime.js";

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
    type MockToolContext = {
      cwd: string;
      sessionId: string;
      engine: {
        getSessionManager: () => SessionManager;
      };
      capabilityServices: { coding: CodingToolService };
      setCwd(this: MockToolContext, next: string): void;
    };
    const toolCtx: MockToolContext = {
      cwd,
      sessionId,
      engine: {
        getSessionManager: () => sm,
      },
      capabilityServices: {
        coding: {
          getSessionManager: () => sm,
          readWorktreeSetupScripts: () => undefined,
          readWorktreeBranchPrefix: () => undefined,
          resolveWorktreeSetupSandbox: async () => createOffBackend(),
          readWorktreeSetupShellEnv: () => undefined,
        },
      },
      setCwd(next: string) {
        this.cwd = next;
      },
    };
    return toolCtx as unknown as ToolContext;
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

  test("omitted action refuses to auto-detach a clean tree with new commits", async () => {
    const toolCtx = ctx("ahead123456");
    await enterWorktreeTool({ target: "ahead" }, toolCtx);
    const before = sm.getSessionWorkspace("ahead123456")!;
    const active = before.worktree!;
    writeFileSync(join(active.path, "committed.txt"), "committed\n");
    git(active.path, ["add", "-A"]);
    git(active.path, ["commit", "-q", "-m", "worktree commit"]);

    const out = await exitWorktreeTool({}, toolCtx);

    expect(out.toLowerCase()).toContain("error");
    expect(out).toContain("keep");
    expect(out).toContain("discard");
    expect(existsSync(active.path)).toBe(true);
    expect(sm.getSessionWorkspace("ahead123456")).toEqual(before);
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

  test("model-supplied __sessionId cannot retarget another session's workspace", async () => {
    const trusted = ctx("trusted123456");
    const other = ctx("other123456");
    await enterWorktreeTool({ target: "trusted" }, trusted);
    await enterWorktreeTool({ target: "other" }, other);
    const trustedWorktree = sm.getSessionWorkspace("trusted123456")!.worktree!;
    const otherBefore = sm.getSessionWorkspace("other123456")!;

    const out = await exitWorktreeTool({ action: "detach", __sessionId: "other123456" }, trusted);

    expect(out).toContain("trusted");
    expect(existsSync(trustedWorktree.path)).toBe(false);
    expect(sm.getSessionWorkspace("trusted123456")).toEqual({ root: repo, kind: "main" });
    expect(sm.getSessionWorkspace("other123456")).toEqual(otherBefore);
    expect(existsSync(otherBefore.worktree!.path)).toBe(true);
    removeWorktree(otherBefore.worktree!.path, true);
  });

  test("deprecated slug alias passes schema validation and enters a worktree", async () => {
    const validation = validateToolArgs(
      "EnterWorktree",
      { slug: "legacy" },
      enterWorktreeToolDef.inputSchema,
    );
    expect(validation).toBeNull();

    const toolCtx = ctx("slug123456");
    const out = await enterWorktreeTool({ slug: "legacy" }, toolCtx);
    const active = sm.getSessionWorkspace("slug123456")!.worktree!;

    expect(out).toContain("Worktree created and switched");
    expect(active.branch).toContain("legacy");
    removeWorktree(active.path, true);
  });

  test("abort after worktree creation compensates without switching the session binding", async () => {
    const controller = new AbortController();
    const toolCtx = ctx("abort123456");
    toolCtx.signal = controller.signal;
    codingToolService(toolCtx)!.readWorktreeSetupScripts = () => ({ default: "sleep 5" });

    const pending = enterWorktreeTool({ target: "abort-cleanup" }, toolCtx);
    const worktreesRoot = join(repo, "..", ".worktrees");
    for (let i = 0; i < 200; i++) {
      if (existsSync(worktreesRoot) && readdirSync(worktreesRoot).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    const out = await pending;

    expect(out).toContain("Error");
    expect(sm.getSessionWorkspace("abort123456")).toEqual({ root: repo, kind: "main" });
    expect(existsSync(worktreesRoot) ? readdirSync(worktreesRoot) : []).toHaveLength(0);
    expect(git(repo, ["branch", "--list", "worktree/abort-cleanup-*"])).toBe("");
  });

  test("detach refuses to remove a worktree still attached to another session", async () => {
    const first = ctx("guard111111");
    const second = ctx("guard222222");
    await enterWorktreeTool({ target: "guard" }, first);
    const shared = sm.getSessionWorkspace("guard111111")!.worktree!;
    await enterWorktreeTool({ target: shared.path }, second);

    const out = await exitWorktreeTool({ action: "detach" }, first);

    expect(out.toLowerCase()).toContain("also in use");
    expect(out).toContain("guard222222");
    expect(out).toContain("removal has been skipped");
    expect(existsSync(shared.path)).toBe(true);
    expect(sm.getSessionWorkspace("guard111111")).toEqual({ root: repo, kind: "main" });
    expect(sm.getSessionWorkspace("guard222222")!.root).toBe(shared.path);
    removeWorktree(shared.path, true);
  });

  test("enter persists a breadcrumb but keeps the current turn cwd on the old root", async () => {
    const toolCtx = ctx("ctxcwd123456");

    const out = await enterWorktreeTool({ target: "ctxcwd" }, toolCtx);
    const ws = sm.getSessionWorkspace("ctxcwd123456")!;
    const transcript = readFileSync(join(sessions, "ctxcwd123456", "transcript.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const lastMeta = transcript.filter((event) => event.type === "session_meta").at(-1);

    expect(out).toContain("next turn");
    expect(out).toContain("CURRENT turn");
    expect(toolCtx.cwd).toBe(repo);
    expect(lastMeta.data.workspace.root).toBe(ws.root);
    expect(lastMeta.data.handoffFrom).toBe(repo);
    removeWorktree(ws.worktree!.path, true);
  });

  test("remove failure returns an error and leaves the session pointed at the worktree", async () => {
    const toolCtx = ctx("rmfail123456");
    await enterWorktreeTool({ target: "rmfail" }, toolCtx);
    const before = sm.getSessionWorkspace("rmfail123456")!;
    const active = before.worktree!;
    unlinkSync(join(active.path, ".git"));

    const out = await exitWorktreeTool({ action: "detach" }, toolCtx);

    expect(out.toLowerCase()).toContain("error");
    expect(existsSync(active.path)).toBe(true);
    expect(sm.getSessionWorkspace("rmfail123456")).toEqual(before);
  });

  test("discard branch-delete failure after directory removal switches to main with a warning", async () => {
    const toolCtx = ctx("branchfail123456");
    await enterWorktreeTool({ target: "branchfail" }, toolCtx);
    const active = sm.getSessionWorkspace("branchfail123456")!.worktree!;
    const lockPath = join(repo, ".git", "refs", "heads", `${active.branch}.lock`);
    mkdirSync(join(repo, ".git", "refs", "heads", "worktree"), { recursive: true });
    writeFileSync(lockPath, "locked\n");

    const out = await exitWorktreeTool({ action: "discard" }, toolCtx);

    expect(out.toLowerCase()).toContain("warning");
    expect(out).toContain("could not be deleted");
    expect(out).toContain(active.branch);
    expect(out).toContain(`git branch -D ${active.branch}`);
    expect(existsSync(active.path)).toBe(false);
    expect(git(repo, ["branch", "--list", active.branch])).toContain(active.branch);
    expect(sm.getSessionWorkspace("branchfail123456")).toEqual({ root: repo, kind: "main" });
    rmSync(lockPath, { force: true });
    execFileSync("git", ["branch", "-D", active.branch], { cwd: repo, env: ENV });
  });

  test("directory removal failure returns an error and keeps the worktree workspace", async () => {
    const toolCtx = ctx("dirfail123456");
    await enterWorktreeTool({ target: "dirfail" }, toolCtx);
    const before = sm.getSessionWorkspace("dirfail123456")!;
    const active = before.worktree!;
    git(repo, ["worktree", "lock", "--reason", "test", active.path]);

    const out = await exitWorktreeTool({ action: "detach" }, toolCtx);

    expect(out.toLowerCase()).toContain("error");
    expect(existsSync(active.path)).toBe(true);
    expect(sm.getSessionWorkspace("dirfail123456")).toEqual(before);
    git(repo, ["worktree", "unlock", active.path]);
    removeWorktree(active.path, true);
  });

  test("newly-created worktree setup resolves sandbox and shell env for the new worktree", async () => {
    const setupSandboxCwds: string[] = [];
    const setupEnvCwds: string[] = [];
    const oldSandbox = {
      name: "seatbelt" as const,
      wrap() {
        throw new Error("old workspace sandbox should not run setup");
      },
    };
    const toolCtx = ctx("setupscope123456");
    toolCtx.sandbox = oldSandbox;
    toolCtx.shellEnv = { SETUP_SCOPED_CWD: repo };
    const services = codingToolService(toolCtx)!;
    services.readWorktreeSetupScripts = () => ({
      default: "printf '%s' \"$SETUP_SCOPED_CWD\" > setup-cwd.txt",
    });
    services.resolveWorktreeSetupSandbox = async (cwd: string) => {
      setupSandboxCwds.push(cwd);
      return createOffBackend();
    };
    services.readWorktreeSetupShellEnv = (cwd: string) => {
      setupEnvCwds.push(cwd);
      return { SETUP_SCOPED_CWD: cwd };
    };

    const out = await enterWorktreeTool({ target: "setupscope" }, toolCtx);
    const workspace = sm.getSessionWorkspace("setupscope123456")!;

    expect(out).toContain("Ran setup script");
    expect(setupSandboxCwds).toEqual([workspace.root]);
    expect(setupEnvCwds).toEqual([workspace.root]);
    expect(readFileSync(join(workspace.root, "setup-cwd.txt"), "utf-8")).toBe(workspace.root);
    removeWorktree(workspace.root, true);
  });
});

describe("SwitchSessionWorkspace bridge tool", () => {
  test("requires a target", async () => {
    const out = await switchSessionWorkspaceTool({}, {} as ToolContext);
    expect(out).toContain("target is required");
  });

  test("degrades clearly when no workspace bridge is wired", async () => {
    const out = await switchSessionWorkspaceTool({ target: "main" }, {} as ToolContext);
    expect(out).toContain("not available");
  });

  test("switches through the workspace bridge and updates live session state", async () => {
    const switched = {
      root: "/repo/.worktrees/feature",
      kind: "worktree" as const,
      worktree: {
        path: "/repo/.worktrees/feature",
        branch: "worktree/feature",
        baseRef: "main",
        createdBy: "codeshell" as const,
      },
    };
    let bridgeTarget = "";
    let liveWorkspace: typeof switched | undefined;
    const out = await switchSessionWorkspaceTool({ target: "feature" }, {
      cwd: "/repo",
      workspace: {
        switch: async (target: string) => {
          bridgeTarget = target;
          return switched;
        },
      },
      setSessionWorkspace: (workspace: typeof switched) => {
        liveWorkspace = workspace;
      },
    } as unknown as ToolContext);

    expect(bridgeTarget).toBe("feature");
    expect(liveWorkspace).toEqual(switched);
    expect(out).toContain("Switched session workspace");
    expect(out).toContain("worktree/feature");
    expect(out).toContain("next turn");
  });

  test("tool description tells the model when to use it", () => {
    expect(switchSessionWorkspaceToolDef.description).toContain("isolated");
    expect(switchSessionWorkspaceToolDef.description).toContain("parallel");
    expect(switchSessionWorkspaceToolDef.description).toContain("current conversation");
    expect(switchSessionWorkspaceToolDef.description).toContain("worktree");
  });
});
