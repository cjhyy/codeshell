import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, Message, TranscriptEvent } from "../types.js";
import { MemoryManager } from "../session/memory.js";
import { Transcript } from "../session/transcript.js";
import { invalidateSkillCache } from "../skills/scanner.js";
import { installPromptPrefixGuard } from "../testing/prompt-prefix-guard.js";
import { createWorkspaceContext, type WorkspaceContext } from "../workspace/workspace-context.js";

const guard = installPromptPrefixGuard({ beforeEach, afterEach });

const provider = "fake-engine-context-ledger-scope";
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const requestsByModel = new Map<string, Message[][]>();

class FakeClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const response: LLMResponse = {
      text: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1000, completionTokens: 1, totalTokens: 1001 },
    };
    if (options.systemPrompt.includes("Working directory:")) {
      requestsByModel.get(this.model)?.push(JSON.parse(JSON.stringify(options.messages)));
    }
    this.recordUsage(response.usage!, options);
    return response;
  }
}

registerProvider(provider, FakeClient);

describe("Engine context ledger: a workspace change revokes the earlier context", () => {
  let oldRoot: string;
  let newRoot: string;
  let sessions: string;
  let home: string;
  let prevHome: string | undefined;
  let prevCodeShellHome: string | undefined;
  let model: string;
  const sessionId = "s-ledger-scope";

  const newEngine = (cwd: string): Engine => {
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd,
      sessionStorageDir: sessions,
      enabledBuiltinTools: [],
      preset: "general",
      headless: true,
    });
    (engine as any).hooks.clear();
    return engine;
  };
  const workspace = (): WorkspaceContext =>
    createWorkspaceContext({
      projectId: "p-new",
      projectRevision: 1,
      sessionMainRootId: "r-new",
      roots: [{ id: "r-new", path: newRoot, role: "primary" }],
    });
  const ledgerEvents = (): TranscriptEvent[] =>
    readFileSync(join(sessions, sessionId, "transcript.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TranscriptEvent)
      .filter((event) => event.data.contextLedger !== undefined);

  beforeEach(() => {
    sessions = mkdtempSync(join(tmpdir(), "cs-ledger-scope-sessions-"));
    home = mkdtempSync(join(tmpdir(), "cs-ledger-scope-home-"));
    prevHome = process.env.HOME;
    prevCodeShellHome = process.env.CODE_SHELL_HOME;
    process.env.HOME = home;
    process.env.CODE_SHELL_HOME = home;
    model = `${provider}-${Date.now()}-${Math.random()}`;
    requestsByModel.set(model, []);
    [oldRoot, newRoot] = ["old", "new"].map((name) => {
      const root = mkdtempSync(join(tmpdir(), `cs-ledger-scope-${name}-`));
      execFileSync("git", ["init", "-q"], { cwd: root, env, stdio: "ignore" });
      writeFileSync(join(root, "CODESHELL.md"), "project instructions\n");
      new MemoryManager({ projectDir: root }).save({
        name: `${name}-memory`,
        description: `${name.toUpperCase()}_ROOT_MEMORY_MARKER`,
        type: "user",
        content: "x",
      });
      return root;
    }) as [string, string];
    invalidateSkillCache();
  });

  afterEach(() => {
    requestsByModel.delete(model);
    invalidateSkillCache();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = prevCodeShellHome;
    for (const dir of [oldRoot, newRoot, sessions, home]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops the old root's context and tells the new one once, live and after resume", async () => {
    const requests = requestsByModel.get(model)!;
    const engine = newEngine(oldRoot);
    await engine.run("first task", { sessionId, cwd: oldRoot });
    // An ordinary run in the same workspace adds no ledger message.
    await engine.run("second task", { sessionId, cwd: oldRoot });
    expect(ledgerEvents()).toHaveLength(1);
    expect(guard.current.rewrites).not.toContain("workspace_root_changed");
    expect(JSON.stringify(requests[1])).toContain("OLD_ROOT_MEMORY_MARKER");

    // The session moves to another root; the same resident Engine runs on.
    engine.migrateSessionMainRoot(sessionId, { projectId: "p-new", mainRootId: "r-new" }, newRoot);
    await engine.run("third task", { sessionId, workspaceContext: workspace() });
    expect(guard.current.rewrites).toContain("workspace_root_changed");
    const live = JSON.stringify(requests[2]);
    expect(live).not.toContain("OLD_ROOT_MEMORY_MARKER");
    expect(live).toContain("NEW_ROOT_MEMORY_MARKER");
    const events = ledgerEvents();
    expect(events).toHaveLength(2);
    expect(events[1]!.data.contextLedger).toMatchObject({
      kind: "snapshot",
      revokesEarlier: true,
    });
    // The conversation itself stays.
    expect(live).toContain("first task");

    // Replay from disk drops the revoked chain too.
    const replay = Transcript.loadFromFile(join(sessions, sessionId, "transcript.jsonl"));
    expect(JSON.stringify(replay.toMessages())).not.toContain("OLD_ROOT_MEMORY_MARKER");

    // Further runs in the new root, in memory and in a new process: nothing
    // revoked again, nothing re-sent, the old context stays gone.
    await engine.run("fourth task", { sessionId, workspaceContext: workspace() });
    await newEngine(newRoot).run("fifth task", { sessionId, workspaceContext: workspace() });
    for (const request of requests.slice(3)) {
      const text = JSON.stringify(request);
      expect(text).not.toContain("OLD_ROOT_MEMORY_MARKER");
      expect(text.split("NEW_ROOT_MEMORY_MARKER")).toHaveLength(2);
    }
    expect(ledgerEvents()).toHaveLength(2);
    expect(guard.current.rewrites.filter((kind) => kind === "workspace_root_changed")).toHaveLength(
      1,
    );
  });
});
