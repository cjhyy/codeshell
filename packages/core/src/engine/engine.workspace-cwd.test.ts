import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse } from "../types.js";
import { createWorktree, removeWorktree } from "../git/worktree.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const provider = "fake-workspace-cwd";

const scenarios = new Map<string, { calls: number }>();

class FakeWorkspaceCwdClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`missing scenario ${this.model}`);
    scenario.calls++;
    this.recordUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }, options);
    if (scenario.calls === 1) {
      return {
        text: "",
        toolCalls: [{ id: "pwd-1", toolName: "Bash", args: { command: "pwd" } }],
        stopReason: "tool_use",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    }
    return {
      text: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}

registerProvider(provider, FakeWorkspaceCwdClient);

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
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
    const model = `${provider}-${Date.now()}-${Math.random()}`;
    scenarios.set(model, { calls: 0 });
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd: repo,
      sessionStorageDir: sessions,
      headless: true,
      permissionMode: "bypassPermissions",
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
});
