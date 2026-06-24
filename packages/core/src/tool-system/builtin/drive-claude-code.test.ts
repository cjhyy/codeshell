import { describe, it, expect } from "bun:test";
import { driveClaudeCodeToolDef, makeDriveClaudeCodeTool } from "./drive-claude-code.js";
import { backgroundJobRegistry } from "./background-jobs.js";
import { makeDriveClaudeCodeTool as mkBg } from "./drive-claude-code.js";

describe("DriveClaudeCode tool", () => {
  it("has a name and an inputSchema with prompt", () => {
    expect(driveClaudeCodeToolDef.name).toBe("DriveClaudeCode");
    expect((driveClaudeCodeToolDef.inputSchema as any).properties.prompt).toBeDefined();
  });
  it("runs one turn and reports sessionId + finalText", async () => {
    const tool = makeDriveClaudeCodeTool(async (o) => ({ sessionId: "S7", finalText: "did it", isError: false, exitCode: 0, lines: [] }));
    const out = await tool({ prompt: "go", cwd: "/x" });
    expect(out).toContain("S7");
    expect(out).toContain("did it");
  });

  it("defaults to bypassPermissions so headless tools (WebSearch/WebFetch/Write) aren't blocked", async () => {
    // headless `claude -p` has no interactive approval loop here (no
    // --permission-prompt-tool), so under "default" a tool needing approval
    // (e.g. WebSearch) silently can't run — the agent "loses網". DriveClaudeCode
    // is a fire-one-turn delegation with nobody watching, so it auto-runs.
    let seen: string | undefined;
    const tool = makeDriveClaudeCodeTool(async (o) => {
      seen = o.permissionMode;
      return { sessionId: "S", finalText: "", isError: false, exitCode: 0, lines: [] };
    });
    await tool({ prompt: "search the web", cwd: "/x" });
    expect(seen).toBe("bypassPermissions");
  });

  it("still honors an explicit permissionMode from the caller", async () => {
    let seen: string | undefined;
    const tool = makeDriveClaudeCodeTool(async (o) => {
      seen = o.permissionMode;
      return { sessionId: "S", finalText: "", isError: false, exitCode: 0, lines: [] };
    });
    await tool({ prompt: "edit code", cwd: "/x", permissionMode: "default" });
    expect(seen).toBe("default");
  });
});

describe("DriveClaudeCode background mode", () => {
  it("registers a background job and finishes it on completion", async () => {
    backgroundJobRegistry.reset?.();
    let resolveRun!: (r: any) => void;
    const runner = () => new Promise<any>((res) => { resolveRun = res; });
    const tool = mkBg(runner as any);
    const out = await tool({ prompt: "long job", cwd: "/x", background: true }, { cwd: "/x", sessionId: "SESS" } as any);
    expect(out).toContain("后台");
    expect(backgroundJobRegistry.hasRunningForSession("SESS")).toBe(true);
    resolveRun({ sessionId: "S8", finalText: "done", isError: false, exitCode: 0, lines: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(backgroundJobRegistry.hasRunningForSession("SESS")).toBe(false);
  });
});
