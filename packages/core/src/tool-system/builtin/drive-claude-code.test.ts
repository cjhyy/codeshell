import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  driveClaudeCodeToolDef,
  makeDriveClaudeCodeTool,
  driveAgentToolDef,
  makeDriveAgentTool,
} from "./drive-claude-code.js";
import { backgroundJobRegistry } from "./background-jobs.js";
import { notificationQueue } from "./agent-notifications.js";
import { makeDriveClaudeCodeTool as mkBg } from "./drive-claude-code.js";
import { SessionManager } from "../../session/session-manager.js";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function bindingFile(home: string): string {
  return join(home, "external-agents", "bindings.json");
}

function readBindings(home: string): any {
  return JSON.parse(readFileSync(bindingFile(home), "utf-8"));
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf-8" }).trim();
}

describe("DriveAgent tool", () => {
  it("has a name and an inputSchema with prompt + background + cli", () => {
    expect(driveAgentToolDef.name).toBe("DriveAgent");
    expect((driveAgentToolDef.inputSchema as any).properties.prompt).toBeDefined();
    expect((driveAgentToolDef.inputSchema as any).properties.background).toBeDefined();
    expect((driveAgentToolDef.inputSchema as any).properties.cli.enum).toEqual(["claude", "codex"]);
  });

  it("routes cli:'codex' to the codex runner, defaults (omitted) to claude", async () => {
    const seen: string[] = [];
    const tool = makeDriveAgentTool(async (o) => {
      seen.push(o.cli);
      return { sessionId: "S", finalText: "", isError: false, exitCode: 0, lines: [] };
    });
    await tool({ prompt: "p", cwd: "/x", background: false, cli: "codex" } as any);
    await tool({ prompt: "p", cwd: "/x", background: false } as any);
    expect(seen).toEqual(["codex", "claude"]);
  });

  it("rejects an unknown cli value", async () => {
    const tool = makeDriveAgentTool(async () => ({
      sessionId: "S",
      finalText: "x",
      isError: false,
      exitCode: 0,
      lines: [],
    }));
    const out = await tool({ prompt: "p", cwd: "/x", background: false, cli: "gpt" } as any);
    expect(out.toLowerCase()).toContain("cli");
  });
});

describe("DriveAgent external session bindings", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cs-drive-home-"));
    prevHome = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("persists a binding after a foreground run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cs-drive-cwd-"));
    try {
      const tool = makeDriveAgentTool(async () => ({
        sessionId: "EXT-1",
        finalText: "done",
        isError: false,
        exitCode: 0,
        lines: [],
      }));

      await tool(
        { prompt: "p", cwd, background: false, cli: "codex" } as any,
        { cwd, sessionId: "CS-1" } as any,
      );

      expect(existsSync(bindingFile(home))).toBe(true);
      const bindings = readBindings(home);
      expect(bindings.bindings["EXT-1"]).toMatchObject({
        cli: "codex",
        externalSessionId: "EXT-1",
        codeShellSessionId: "CS-1",
        cwd,
      });
      expect(typeof bindings.bindings["EXT-1"].createdAt).toBe("number");
      expect(typeof bindings.bindings["EXT-1"].lastUsedAt).toBe("number");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses the binding cwd when resuming without an explicit cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cs-drive-bound-"));
    const seen: string[] = [];
    try {
      const tool = makeDriveAgentTool(async (o) => {
        seen.push(o.cwd);
        return { sessionId: "EXT-2", finalText: "ok", isError: false, exitCode: 0, lines: [] };
      });

      await tool(
        { prompt: "start", cwd, background: false, cli: "claude" } as any,
        {
          cwd,
          sessionId: "CS-2",
        } as any,
      );
      await tool(
        { prompt: "resume", resumeSessionId: "EXT-2", background: false, cli: "claude" } as any,
        {
          cwd: "/not-the-bound-cwd",
          sessionId: "CS-2",
        } as any,
      );

      expect(seen).toEqual([cwd, cwd]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects resume when the caller passes a different cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cs-drive-bound-"));
    const other = mkdtempSync(join(tmpdir(), "cs-drive-other-"));
    let calls = 0;
    try {
      const tool = makeDriveAgentTool(async () => {
        calls++;
        return { sessionId: "EXT-3", finalText: "ok", isError: false, exitCode: 0, lines: [] };
      });

      await tool(
        { prompt: "start", cwd, background: false, cli: "claude" } as any,
        {
          cwd,
          sessionId: "CS-3",
        } as any,
      );
      const out = await tool(
        {
          prompt: "resume",
          resumeSessionId: "EXT-3",
          cwd: other,
          background: false,
          cli: "claude",
        } as any,
        { cwd: other, sessionId: "CS-3" } as any,
      );

      expect(out.toLowerCase()).toContain("error");
      expect(out).toContain("bound to");
      expect(calls).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("rejects resume when the external session id has no binding", async () => {
    let ran = false;
    const tool = makeDriveAgentTool(async () => {
      ran = true;
      return { sessionId: "UNKNOWN", finalText: "ok", isError: false, exitCode: 0, lines: [] };
    });

    const out = await tool(
      {
        prompt: "resume",
        resumeSessionId: "UNKNOWN",
        background: false,
        cli: "claude",
      } as any,
      { cwd: "/fallback-cwd", sessionId: "CS-UNKNOWN" } as any,
    );

    expect(out.toLowerCase()).toContain("error");
    expect(out.toLowerCase()).toContain("no binding");
    expect(ran).toBe(false);
  });

  it("blocks resume when bindings.json is corrupt instead of treating it as empty", async () => {
    mkdirSync(join(home, "external-agents"), { recursive: true });
    writeFileSync(bindingFile(home), "{not json", "utf-8");
    let ran = false;
    const tool = makeDriveAgentTool(async () => {
      ran = true;
      return { sessionId: "EXT-CORRUPT", finalText: "ok", isError: false, exitCode: 0, lines: [] };
    });

    const out = await tool(
      {
        prompt: "resume",
        resumeSessionId: "EXT-CORRUPT",
        background: false,
        cli: "claude",
      } as any,
      { cwd: "/fallback-cwd", sessionId: "CS-CORRUPT" } as any,
    );

    expect(out.toLowerCase()).toContain("error");
    expect(out.toLowerCase()).toContain("bindings");
    expect(out.toLowerCase()).toContain("corrupt");
    expect(ran).toBe(false);
  });

  it("blocks resume when the bound worktree directory is gone but the branch still exists", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cs-drive-repo-"));
    try {
      git(repo, ["init", "-q"]);
      git(repo, ["config", "user.email", "t@t.t"]);
      git(repo, ["config", "user.name", "t"]);
      writeFileSync(join(repo, "f.txt"), "x\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "init"]);
      git(repo, ["branch", "worktree/recreate"]);
      new SessionManager().create(repo, "m", "p", "CS-4");

      mkdirSync(join(home, "external-agents"), { recursive: true });
      writeFileSync(
        bindingFile(home),
        JSON.stringify(
          {
            bindings: {
              "EXT-4": {
                cli: "claude",
                externalSessionId: "EXT-4",
                codeShellSessionId: "CS-4",
                cwd: join(repo, "..", ".worktrees", "missing"),
                worktreePath: join(repo, "..", ".worktrees", "missing"),
                worktreeBranch: "worktree/recreate",
                createdAt: 1,
                lastUsedAt: 1,
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      let ran = false;
      const tool = makeDriveAgentTool(async () => {
        ran = true;
        return { sessionId: "EXT-4", finalText: "ok", isError: false, exitCode: 0, lines: [] };
      });

      const out = await tool(
        { prompt: "resume", resumeSessionId: "EXT-4", background: false, cli: "claude" } as any,
        { sessionId: "CS-4" } as any,
      );

      expect(out.toLowerCase()).toContain("error");
      expect(out).toContain("no longer exists");
      expect(out).toContain("worktree/recreate");
      expect(out.toLowerCase()).toContain("recreate");
      expect(ran).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("blocks resume as deleted when the bound cwd and worktree branch are gone", async () => {
    mkdirSync(join(home, "external-agents"), { recursive: true });
    writeFileSync(
      bindingFile(home),
      JSON.stringify(
        {
          bindings: {
            "EXT-5": {
              cli: "codex",
              externalSessionId: "EXT-5",
              codeShellSessionId: "CS-5",
              cwd: join(home, "missing-workspace"),
              worktreePath: join(home, "missing-workspace"),
              worktreeBranch: "worktree/deleted",
              createdAt: 1,
              lastUsedAt: 1,
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    let ran = false;
    const tool = makeDriveAgentTool(async () => {
      ran = true;
      return { sessionId: "EXT-5", finalText: "ok", isError: false, exitCode: 0, lines: [] };
    });

    const out = await tool(
      { prompt: "resume", resumeSessionId: "EXT-5", background: false, cli: "codex" } as any,
      { sessionId: "CS-5" } as any,
    );

    expect(out.toLowerCase()).toContain("error");
    expect(out.toLowerCase()).toContain("workspace deleted");
    expect(ran).toBe(false);
  });
});

describe("DriveClaudeCode alias (back-compat)", () => {
  it("has a name and an inputSchema with prompt + background", () => {
    expect(driveClaudeCodeToolDef.name).toBe("DriveClaudeCode");
    expect((driveClaudeCodeToolDef.inputSchema as any).properties.prompt).toBeDefined();
    expect((driveClaudeCodeToolDef.inputSchema as any).properties.background).toBeDefined();
  });

  // CC tasks are typically long (minutes → hours), so the tool runs in the
  // BACKGROUND by default: it returns immediately and the result is delivered
  // on completion via a wakeup notification. A caller wanting the answer inline
  // for a quick task passes background:false.
  it("defaults to background: returns immediately, registers a job, does NOT block", async () => {
    backgroundJobRegistry.reset?.();
    let resolveRun!: (r: any) => void;
    const runner = () =>
      new Promise<any>((res) => {
        resolveRun = res;
      });
    const tool = mkBg(runner as any);
    const out = await tool({ prompt: "long research", cwd: "/x" }, {
      cwd: "/x",
      sessionId: "S-DEF",
    } as any);
    expect(out).toContain("后台");
    expect(backgroundJobRegistry.hasRunningForSession("S-DEF")).toBe(true);
    resolveRun({ sessionId: "CC1", finalText: "done", isError: false, exitCode: 0, lines: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(backgroundJobRegistry.hasRunningForSession("S-DEF")).toBe(false);
  });

  it("fails loud (no job started) when background but ctx has no sessionId — result would be dropped", async () => {
    backgroundJobRegistry.reset?.();
    let ran = false;
    const runner = async () => {
      ran = true;
      return { sessionId: "X", finalText: "", isError: false, exitCode: 0, lines: [] };
    };
    const tool = mkBg(runner as any);
    // background (default) + ctx without sessionId
    const out = await tool({ prompt: "p", cwd: "/x" }, { cwd: "/x" } as any);
    expect(out.toLowerCase()).toContain("error");
    expect(out).toContain("session");
    expect(ran).toBe(false); // runner never launched
    // No orphaned running job left behind.
    expect(backgroundJobRegistry.hasRunningForSession("")).toBe(false);
  });

  it("background:false runs in the foreground and returns the result inline", async () => {
    const tool = makeDriveClaudeCodeTool(async () => ({
      sessionId: "S7",
      finalText: "did it",
      isError: false,
      exitCode: 0,
      lines: [],
    }));
    const out = await tool({ prompt: "go", cwd: "/x", background: false } as any);
    expect(out).toContain("S7");
    expect(out).toContain("did it");
  });

  it("defaults to bypassPermissions so headless tools (WebSearch/WebFetch/Write) aren't blocked", async () => {
    let seen: string | undefined;
    const tool = makeDriveClaudeCodeTool(async (o) => {
      seen = o.permissionMode;
      return { sessionId: "S", finalText: "", isError: false, exitCode: 0, lines: [] };
    });
    await tool({ prompt: "search the web", cwd: "/x", background: false } as any);
    expect(seen).toBe("bypassPermissions");
  });

  it("still honors an explicit permissionMode from the caller", async () => {
    let seen: string | undefined;
    const tool = makeDriveClaudeCodeTool(async (o) => {
      seen = o.permissionMode;
      return { sessionId: "S", finalText: "", isError: false, exitCode: 0, lines: [] };
    });
    await tool({
      prompt: "edit code",
      cwd: "/x",
      background: false,
      permissionMode: "default",
    } as any);
    expect(seen).toBe("default");
  });
});

describe("DriveClaudeCode background completion delivery", () => {
  it("enqueues a completion notification carrying cc's finalText so the woken agent sees the answer", async () => {
    backgroundJobRegistry.reset?.();
    notificationQueue.drainAll("S-NOTIFY"); // clear bucket
    let resolveRun!: (r: any) => void;
    const runner = () =>
      new Promise<any>((res) => {
        resolveRun = res;
      });
    const tool = mkBg(runner as any);
    await tool({ prompt: "check markets", cwd: "/x" }, { cwd: "/x", sessionId: "S-NOTIFY" } as any);
    resolveRun({
      sessionId: "CC9",
      finalText: "S&P up 1.2%",
      isError: false,
      exitCode: 0,
      lines: [],
    });
    await new Promise((r) => setTimeout(r, 20));
    const items = notificationQueue.drainAll("S-NOTIFY");
    expect(items.length).toBe(1);
    expect(items[0].status).toBe("completed");
    expect(items[0].finalText).toContain("S&P up 1.2%");
    // The cc session id is recorded so the result is recoverable from disk
    // (~/.claude/projects/.../<ccSessionId>.jsonl) even if the notification is
    // lost — and so the user gets a real session id, not just an opaque jobId.
    expect(items[0].ccSessionId).toBe("CC9");
  });

  it("enqueues a failed notification with the error when the cc run errors", async () => {
    backgroundJobRegistry.reset?.();
    notificationQueue.drainAll("S-ERR");
    let resolveRun!: (r: any) => void;
    const runner = () =>
      new Promise<any>((res) => {
        resolveRun = res;
      });
    const tool = mkBg(runner as any);
    await tool({ prompt: "do x", cwd: "/x" }, { cwd: "/x", sessionId: "S-ERR" } as any);
    resolveRun({ sessionId: "CCE", finalText: "boom", isError: true, exitCode: 1, lines: [] });
    await new Promise((r) => setTimeout(r, 20));
    const items = notificationQueue.drainAll("S-ERR");
    expect(items.length).toBe(1);
    expect(items[0].status).toBe("failed");
  });
});
