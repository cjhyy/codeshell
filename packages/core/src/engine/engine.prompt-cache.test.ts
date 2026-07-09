import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, Message, TokenUsage } from "../types.js";
import { logger } from "../logging/logger.js";

const provider = "fake-engine-prompt-cache";
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

type CapturedCall = {
  messages: Message[];
  systemPrompt: string;
};

type Scenario = {
  primaryCalls: CapturedCall[];
  responses: LLMResponse[];
};

const scenarios = new Map<string, Scenario>();

function cloneMessages(messages: Message[]): Message[] {
  return JSON.parse(JSON.stringify(messages)) as Message[];
}

class FakePromptCacheClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`missing fake scenario: ${this.model}`);
    const isPrimaryCall = options.systemPrompt.includes("Working directory:");
    if (!isPrimaryCall) {
      const response = stopResponse("auxiliary");
      this.recordUsage(response.usage!, options);
      return response;
    }

    scenario.primaryCalls.push({
      messages: cloneMessages(options.messages),
      systemPrompt: options.systemPrompt,
    });
    const response =
      scenario.responses[
        Math.min(scenario.primaryCalls.length - 1, scenario.responses.length - 1)
      ]!;
    this.recordUsage(
      response.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      options,
    );
    return response;
  }
}

registerProvider(provider, FakePromptCacheClient);

function stopResponse(
  text: string,
  usage: TokenUsage = { promptTokens: 1000, completionTokens: 1, totalTokens: 1001 },
): LLMResponse {
  return {
    text,
    toolCalls: [],
    stopReason: "stop",
    usage,
  };
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env, stdio: "ignore" });
}

describe("Engine prompt-cache hygiene", () => {
  let repo: string;
  let sessions: string;
  let home: string;
  let prevHome: string | undefined;
  let prevCodeShellHome: string | undefined;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cs-engine-prompt-cache-repo-"));
    sessions = mkdtempSync(join(tmpdir(), "cs-engine-prompt-cache-sessions-"));
    home = mkdtempSync(join(tmpdir(), "cs-engine-prompt-cache-home-"));
    prevHome = process.env.HOME;
    prevCodeShellHome = process.env.CODE_SHELL_HOME;
    process.env.HOME = home;
    process.env.CODE_SHELL_HOME = home;

    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = prevCodeShellHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("does not retain injected userContext or dynamicContext in the compacted history cache", async () => {
    const sessionId = "s-prompt-cache-hygiene";
    const model = `${provider}-hygiene-${Date.now()}-${Math.random()}`;
    const firstUserContextMarker = `FIRST_USER_CONTEXT_${Date.now()}`;
    const secondUserContextMarker = `SECOND_USER_CONTEXT_${Date.now()}`;
    const firstDynamicMarker = `first-dynamic-${Date.now()}.txt`;
    const secondDynamicMarker = `second-dynamic-${Date.now()}.txt`;

    writeFileSync(join(repo, "CODESHELL.md"), `project instructions ${firstUserContextMarker}\n`);
    git(repo, ["add", "CODESHELL.md"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    writeFileSync(join(repo, firstDynamicMarker), "first dynamic context marker\n");

    scenarios.set(model, {
      primaryCalls: [],
      responses: [stopResponse("first done"), stopResponse("second done")],
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: repo,
        sessionStorageDir: sessions,
        enabledBuiltinTools: [],
        preset: "terminal-coding",
        headless: true,
      });
      (engine as any).hooks.clear();

      await engine.run("first task", { sessionId, cwd: repo });

      const cachedHistory = (engine as any).compactedMessagesBySession.get(sessionId) as
        | Message[]
        | undefined;
      const cachedText = JSON.stringify(cachedHistory ?? []);
      expect(cachedText).not.toContain(firstUserContextMarker);
      expect(cachedText).not.toContain(firstDynamicMarker);

      unlinkSync(join(repo, firstDynamicMarker));
      writeFileSync(
        join(repo, "CODESHELL.md"),
        `project instructions ${secondUserContextMarker}\n`,
      );
      writeFileSync(join(repo, secondDynamicMarker), "second dynamic context marker\n");

      await engine.run("second task", { sessionId, cwd: repo });

      const scenario = scenarios.get(model)!;
      expect(scenario.primaryCalls).toHaveLength(2);
      const secondRequestText = JSON.stringify(scenario.primaryCalls[1]!.messages);
      expect(secondRequestText).not.toContain(firstUserContextMarker);
      expect(secondRequestText).not.toContain(firstDynamicMarker);
      expect(secondRequestText).toContain(secondUserContextMarker);
      expect(secondRequestText).toContain(secondDynamicMarker);
    } finally {
      scenarios.delete(model);
    }
  });

  it("warns when cache_read drops sharply for the same session", async () => {
    const sessionId = "s-cache-read-drop";
    const model = `${provider}-drop-${Date.now()}-${Math.random()}`;
    const warn = spyOn(logger, "warn").mockImplementation(() => {});

    writeFileSync(join(repo, "CODESHELL.md"), "project instructions\n");
    git(repo, ["add", "CODESHELL.md"]);
    git(repo, ["commit", "-q", "-m", "init"]);

    scenarios.set(model, {
      primaryCalls: [],
      responses: [
        stopResponse("warm", {
          promptTokens: 2000,
          completionTokens: 1,
          totalTokens: 2001,
          cacheReadTokens: 1200,
          cacheCreationTokens: 0,
        }),
        stopResponse("cold", {
          promptTokens: 2000,
          completionTokens: 1,
          totalTokens: 2001,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }),
      ],
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: repo,
        sessionStorageDir: sessions,
        enabledBuiltinTools: [],
        preset: "terminal-coding",
        headless: true,
      });
      (engine as any).hooks.clear();

      await engine.run("first task", { sessionId, cwd: repo });
      await engine.run("second task", { sessionId, cwd: repo });

      expect(warn).toHaveBeenCalledWith(
        "engine.cache_read_drop",
        expect.objectContaining({
          sessionId,
          previousCacheReadTokens: 1200,
          currentCacheReadTokens: 0,
        }),
      );
    } finally {
      warn.mockRestore();
      scenarios.delete(model);
    }
  });
});
