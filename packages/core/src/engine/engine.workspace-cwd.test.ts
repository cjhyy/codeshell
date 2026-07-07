import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Engine } from "./engine.js";
import { EngineRuntime, type EngineRuntimeOptions } from "./runtime.js";
import { LLMClientBase } from "../llm/client-base.js";
import { ModelPool } from "../llm/model-pool.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse } from "../types.js";
import { createWorktree, removeWorktree } from "../git/worktree.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { createOffBackend } from "../tool-system/sandbox/off.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const provider = "fake-workspace-cwd";

const scenarios = new Map<string, { calls: number; responses: LLMResponse[] }>();

class FakeWorkspaceCwdClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`missing scenario ${this.model}`);
    this.recordUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }, options);
    if ((options.tools ?? []).length === 0) {
      return {
        text: "summary",
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    }
    const response = scenario.responses[scenario.calls++] ?? {
      text: "",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    return response;
  }
}

registerProvider(provider, FakeWorkspaceCwdClient);

class CapturingRuntime extends EngineRuntime {
  readonly sandboxCwds: string[] = [];

  constructor() {
    super({
      modelPool: new ModelPool(),
      toolRegistry: new ToolRegistry(),
      settings: {} as EngineRuntimeOptions["settings"],
      mcpPool: { disconnectAll: async () => {} } as EngineRuntimeOptions["mcpPool"],
      costTracker: {} as EngineRuntimeOptions["costTracker"],
    });
  }

  override async resolveSandbox(
    config: Parameters<EngineRuntime["resolveSandbox"]>[0],
    cwd: string,
  ): ReturnType<EngineRuntime["resolveSandbox"]> {
    void config;
    this.sandboxCwds.push(cwd);
    return createOffBackend();
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
}

function uniqueModel(name: string): string {
  return `${provider}-${name}-${Date.now()}-${Math.random()}`;
}

function toolUse(
  toolCalls: Array<{ id: string; toolName: string; args: Record<string, unknown> }>,
): LLMResponse {
  return {
    text: "",
    toolCalls,
    stopReason: "tool_use",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

function stop(): LLMResponse {
  return {
    text: "",
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

describe("Engine workspace cwd resolution", () => {
  let repo: string;
  let sessions: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cs-engine-ws-repo-"));
    sessions = mkdtempSync(join(tmpdir(), "cs-engine-ws-sessions-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(join(repo, "..", ".worktrees"), { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  });

  test("resumed tools run from the persisted SessionWorkspace root", async () => {
    const model = uniqueModel("resume");
    scenarios.set(model, {
      calls: 0,
      responses: [toolUse([{ id: "pwd-1", toolName: "Bash", args: { command: "pwd" } }]), stop()],
    });
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd: repo,
      sessionStorageDir: sessions,
      headless: true,
      permissionMode: "bypassPermissions",
      preset: "terminal-coding",
    });
    (engine as any).hooks.clear();
    const session = engine.getSessionManager().create(repo, model, provider, "resume-ws");
    const wt = createWorktree(repo, "resume-ws", "resume-ws");
    session.state.workspace = {
      root: wt.worktreePath,
      kind: "worktree",
      worktree: {
        path: wt.worktreePath,
        branch: wt.worktreeBranch,
        baseRef: wt.originalBranch ?? "HEAD",
        createdBy: "codeshell",
      },
    };
    engine.getSessionManager().saveState(session.state);
    const toolResults: string[] = [];

    await engine.run("where am I?", {
      sessionId: "resume-ws",
      onStream: (event) => {
        if (event.type === "tool_result" && event.result.result) {
          toolResults.push(event.result.result);
        }
      },
    });

    expect(toolResults.join("\n")).toContain(wt.worktreePath);
    removeWorktree(wt.worktreePath, true);
    scenarios.delete(model);
  });

  test("EnterWorktree updates live session state so end-of-turn save keeps the switched workspace", async () => {
    const model = uniqueModel("enter-persist");
    scenarios.set(model, {
      calls: 0,
      responses: [
        toolUse([{ id: "enter-1", toolName: "EnterWorktree", args: { target: "persist" } }]),
        stop(),
      ],
    });
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd: repo,
      sessionStorageDir: sessions,
      headless: true,
      permissionMode: "bypassPermissions",
      preset: "terminal-coding",
    });
    (engine as any).hooks.clear();

    await engine.run("switch to a worktree", { sessionId: "enterpersist123" });

    const workspace = engine.getSessionManager().getSessionWorkspace("enterpersist123");
    expect(workspace?.kind).toBe("worktree");
    expect(workspace?.root).toContain(join(".worktrees", "persist-enterper"));
    expect(existsSync(workspace!.root)).toBe(true);

    removeWorktree(workspace!.root, true);
    scenarios.delete(model);
  });

  test("ExitWorktree(discard) updates live session state so end-of-turn save does not point at the removed worktree", async () => {
    const model = uniqueModel("exit-persist");
    scenarios.set(model, {
      calls: 0,
      responses: [
        toolUse([{ id: "exit-1", toolName: "ExitWorktree", args: { action: "discard" } }]),
        stop(),
      ],
    });
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd: repo,
      sessionStorageDir: sessions,
      headless: true,
      permissionMode: "bypassPermissions",
      preset: "terminal-coding",
    });
    (engine as any).hooks.clear();
    const session = engine.getSessionManager().create(repo, model, provider, "exitdiscard123");
    const wt = createWorktree(repo, "discard-run", "exitdiscard123");
    session.state.workspace = {
      root: wt.worktreePath,
      kind: "worktree",
      worktree: {
        path: wt.worktreePath,
        branch: wt.worktreeBranch,
        baseRef: wt.originalBranch ?? "HEAD",
        createdBy: "codeshell",
      },
    };
    engine.getSessionManager().saveState(session.state);

    await engine.run("discard the worktree", { sessionId: "exitdiscard123" });

    expect(existsSync(wt.worktreePath)).toBe(false);
    expect(engine.getSessionManager().getSessionWorkspace("exitdiscard123")).toEqual({
      root: repo,
      kind: "main",
    });
    scenarios.delete(model);
  });

  test("in-turn workspace switch keeps current tools on the old cwd and takes effect next turn", async () => {
    const model = uniqueModel("next-turn");
    scenarios.set(model, {
      calls: 0,
      responses: [
        toolUse([
          { id: "enter-1", toolName: "EnterWorktree", args: { target: "boundary" } },
          { id: "pwd-same-turn", toolName: "Bash", args: { command: "pwd" } },
        ]),
        stop(),
        toolUse([{ id: "pwd-next-turn", toolName: "Bash", args: { command: "pwd" } }]),
        stop(),
      ],
    });
    const runtime = new CapturingRuntime();
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd: repo,
      sessionStorageDir: sessions,
      headless: true,
      permissionMode: "bypassPermissions",
      preset: "terminal-coding",
      runtime,
    });
    (engine as any).hooks.clear();
    const firstRunResults: Array<{ toolName: string; result?: string }> = [];

    await engine.run("switch then inspect cwd", {
      sessionId: "boundary-session",
      onStream: (event) => {
        if (event.type === "tool_result") {
          firstRunResults.push({
            toolName: event.result.toolName,
            result: event.result.result,
          });
        }
      },
    });

    const switchResult = firstRunResults.find((r) => r.toolName === "EnterWorktree")?.result ?? "";
    const sameTurnPwd = firstRunResults.find((r) => r.toolName === "Bash")?.result ?? "";
    const expectedWorktree = engine
      .getSessionManager()
      .getSessionWorkspace("boundary-session")!.root;
    const mainRoot = git(repo, ["rev-parse", "--show-toplevel"]);
    expect(switchResult).toContain("next turn");
    expect(switchResult).toContain("CURRENT turn");
    expect(sameTurnPwd).toContain(mainRoot);
    expect(sameTurnPwd).not.toContain(expectedWorktree);

    const secondRunResults: Array<{ toolName: string; result?: string }> = [];
    await engine.run("inspect cwd next turn", {
      sessionId: "boundary-session",
      onStream: (event) => {
        if (event.type === "tool_result") {
          secondRunResults.push({
            toolName: event.result.toolName,
            result: event.result.result,
          });
        }
      },
    });

    const nextTurnPwd = secondRunResults.find((r) => r.toolName === "Bash")?.result ?? "";
    expect(nextTurnPwd).toContain(expectedWorktree);
    expect(runtime.sandboxCwds).toEqual([repo, expectedWorktree]);

    removeWorktree(expectedWorktree, true);
    scenarios.delete(model);
  });
});
