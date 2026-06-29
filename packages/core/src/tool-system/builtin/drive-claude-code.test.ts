import { describe, it, expect } from "bun:test";
import { driveClaudeCodeToolDef, makeDriveClaudeCodeTool, driveAgentToolDef, makeDriveAgentTool } from "./drive-claude-code.js";
import { backgroundJobRegistry } from "./background-jobs.js";
import { notificationQueue } from "./agent-notifications.js";
import { makeDriveClaudeCodeTool as mkBg } from "./drive-claude-code.js";

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
    const tool = makeDriveAgentTool(async () => ({ sessionId: "S", finalText: "x", isError: false, exitCode: 0, lines: [] }));
    const out = await tool({ prompt: "p", cwd: "/x", background: false, cli: "gpt" } as any);
    expect(out.toLowerCase()).toContain("cli");
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
    const runner = () => new Promise<any>((res) => { resolveRun = res; });
    const tool = mkBg(runner as any);
    const out = await tool({ prompt: "long research", cwd: "/x" }, { cwd: "/x", sessionId: "S-DEF" } as any);
    expect(out).toContain("后台");
    expect(backgroundJobRegistry.hasRunningForSession("S-DEF")).toBe(true);
    resolveRun({ sessionId: "CC1", finalText: "done", isError: false, exitCode: 0, lines: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(backgroundJobRegistry.hasRunningForSession("S-DEF")).toBe(false);
  });

  it("background:false runs in the foreground and returns the result inline", async () => {
    const tool = makeDriveClaudeCodeTool(async () => ({ sessionId: "S7", finalText: "did it", isError: false, exitCode: 0, lines: [] }));
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
    await tool({ prompt: "edit code", cwd: "/x", background: false, permissionMode: "default" } as any);
    expect(seen).toBe("default");
  });
});

describe("DriveClaudeCode background completion delivery", () => {
  it("enqueues a completion notification carrying cc's finalText so the woken agent sees the answer", async () => {
    backgroundJobRegistry.reset?.();
    notificationQueue.drainAll("S-NOTIFY"); // clear bucket
    let resolveRun!: (r: any) => void;
    const runner = () => new Promise<any>((res) => { resolveRun = res; });
    const tool = mkBg(runner as any);
    await tool({ prompt: "check markets", cwd: "/x" }, { cwd: "/x", sessionId: "S-NOTIFY" } as any);
    resolveRun({ sessionId: "CC9", finalText: "S&P up 1.2%", isError: false, exitCode: 0, lines: [] });
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
    const runner = () => new Promise<any>((res) => { resolveRun = res; });
    const tool = mkBg(runner as any);
    await tool({ prompt: "do x", cwd: "/x" }, { cwd: "/x", sessionId: "S-ERR" } as any);
    resolveRun({ sessionId: "CCE", finalText: "boom", isError: true, exitCode: 1, lines: [] });
    await new Promise((r) => setTimeout(r, 20));
    const items = notificationQueue.drainAll("S-ERR");
    expect(items.length).toBe(1);
    expect(items[0].status).toBe("failed");
  });
});
