import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, Message, TranscriptEvent, StreamEvent } from "../types.js";
import { readOutputJournal } from "../session/output-journal.js";
import { Transcript } from "../session/transcript.js";
import { installPromptPrefixGuard } from "../testing/prompt-prefix-guard.js";

installPromptPrefixGuard({ beforeEach, afterEach });

const provider = "fake-engine-prompt-rewrite";
const reminderCanary = "LOCAL_ONLY_STREAM_REMINDER_D672";
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const requestsByModel = new Map<string, Message[][]>();

class FakeClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const response: LLMResponse = {
      text: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 100, completionTokens: 1, totalTokens: 101 },
    };
    if (options.systemPrompt.includes("Working directory:")) {
      requestsByModel.get(this.model)!.push(JSON.parse(JSON.stringify(options.messages)));
    }
    this.recordUsage(response.usage!, options);
    return response;
  }
}
registerProvider(provider, FakeClient);

describe("Engine replays a hook-rewritten prompt as the model saw it", () => {
  let repo: string;
  let sessions: string;
  let home: string;
  let prevHome: string | undefined;
  let prevCodeShellHome: string | undefined;
  let model: string;

  const newEngine = (): Engine => {
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd: repo,
      sessionStorageDir: sessions,
      enabledBuiltinTools: [],
      preset: "general",
      headless: true,
    });
    (engine as any).hooks.clear();
    (engine as any).hooks.register("user_prompt_submit", async (ctx: { data: unknown }) => {
      const prompt = (ctx.data as { prompt?: string }).prompt;
      return {
        messages: [reminderCanary],
        ...(prompt === "first task" ? { updatedPrompt: "first task [expanded by hook]" } : {}),
      };
    });
    return engine;
  };
  const events = (sessionId: string): TranscriptEvent[] =>
    readFileSync(join(sessions, sessionId, "transcript.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TranscriptEvent);

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cs-prompt-rewrite-repo-"));
    sessions = mkdtempSync(join(tmpdir(), "cs-prompt-rewrite-sessions-"));
    home = mkdtempSync(join(tmpdir(), "cs-prompt-rewrite-home-"));
    prevHome = process.env.HOME;
    prevCodeShellHome = process.env.CODE_SHELL_HOME;
    process.env.HOME = home;
    process.env.CODE_SHELL_HOME = home;
    model = `${provider}-${Date.now()}-${Math.random()}`;
    requestsByModel.set(model, []);
    execFileSync("git", ["init", "-q"], { cwd: repo, env, stdio: "ignore" });
    writeFileSync(join(repo, "CODESHELL.md"), "project instructions\n");
  });

  afterEach(() => {
    requestsByModel.delete(model);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = prevCodeShellHome;
    for (const dir of [repo, sessions, home]) rmSync(dir, { recursive: true, force: true });
  });

  it("the first request after a restart extends the previous process's last request", async () => {
    const sessionId = "s-prompt-rewrite";
    const requests = requestsByModel.get(model)!;
    const stream: StreamEvent[] = [];
    const first = await newEngine().run("first task", {
      sessionId,
      cwd: repo,
      onStream: (event) => {
        stream.push(event);
      },
    });
    expect(first).toMatchObject({ reason: "completed" });
    expect(stream.find((event) => event.type === "error")).toBeUndefined();
    expect(JSON.stringify(stream)).not.toContain("[expanded by hook]");
    expect(stream.length).toBeGreaterThan(0);
    expect(JSON.stringify(stream)).not.toContain(reminderCanary);
    const journal = readOutputJournal(sessions, sessionId);
    expect(journal).toMatchObject({ status: "ok" });
    expect(JSON.stringify(journal)).not.toContain("[expanded by hook]");
    expect(JSON.stringify(journal)).toContain("first task");
    expect(JSON.stringify(journal)).not.toContain(reminderCanary);
    expect(requests).toHaveLength(1);
    const contents = requests[0]!.map((message) => message.content);
    expect(contents).toContain("first task [expanded by hook]");
    expect(contents).not.toContain("first task");

    // A new process: history comes from disk.
    await newEngine().run("second task", { sessionId, cwd: repo });
    expect(requests).toHaveLength(2);
    const earlier = requests[0]!;
    expect(requests[1]!.slice(0, earlier.length)).toEqual(earlier);

    // Display keeps what the user typed.
    const stored = events(sessionId);
    const userMessages = stored.filter(
      (event) => event.type === "message" && event.data.role === "user" && !event.data.injected,
    );
    expect(userMessages.map((event) => event.data.content)).toEqual(["first task", "second task"]);
    const rewrites = stored.filter((event) => event.type === "prompt_rewrite");
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]!.data).toEqual({
      messageEventId: userMessages[0]!.id,
      content: "first task [expanded by hook]",
    });
    const replayed = Transcript.loadFromFile(join(sessions, sessionId, "transcript.jsonl"));
    expect(replayed.toMessages().map((message) => message.content)).toContain(
      "first task [expanded by hook]",
    );
  });
});
