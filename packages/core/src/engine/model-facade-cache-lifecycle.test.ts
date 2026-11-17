import { describe, expect, it, spyOn } from "bun:test";
import { LLMClientBase } from "../llm/client-base.js";
import type { CreateMessageOptions } from "../llm/types.js";
import { logger } from "../logging/logger.js";
import type { SessionBundle } from "../session/session-manager.js";
import { Transcript } from "../session/transcript.js";
import type { LLMResponse } from "../types.js";
import { ModelFacade } from "./model-facade.js";
import { createRunUsageAccounting, wireRunModelFacade } from "./run-accounting.js";

const usage = { promptTokens: 10, completionTokens: 2, totalTokens: 12 };
const response = (withUsage = true): LLMResponse => ({
  text: "done",
  toolCalls: [],
  stopReason: "stop",
  ...(withUsage ? { usage } : {}),
});

/** Fully local client: no provider SDK, fetch or credentials are involved. */
class OfflineClient extends LLMClientBase {
  readonly calls: CreateMessageOptions[] = [];
  constructor(private readonly respond: (options: CreateMessageOptions) => Promise<LLMResponse>) {
    super({ provider: "openai", model: "offline-fixture" });
  }
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    this.calls.push(options);
    return this.respond(options);
  }
}

describe("ModelFacade primary cache lifecycle", () => {
  for (const method of ["call", "callWithoutStreaming"] as const)
    for (const withUsage of [true, false])
      it(`${method} records request start once after success, ${withUsage ? "with" : "without"} usage`, async () => {
        const clock = spyOn(Date, "now").mockReturnValue(1000);
        const events: string[] = [];
        const stamps: number[] = [];
        const log = spyOn(logger, "info").mockImplementation((event) => {
          if (event === "llm.request") events.push("logged");
        });
        let finish!: (value: LLMResponse) => void;
        const client = new OfflineClient(
          async () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
        const transcript = Transcript.inMemory("primary-cache-success");
        const facade = new ModelFacade(client, transcript, undefined, (startedAt) => {
          stamps.push(startedAt);
          events.push("recorded");
        });
        try {
          const pending = facade[method]("system", [], []);
          expect(stamps).toEqual([]);
          clock.mockReturnValue(9000);
          events.push("provider-completed");
          finish(response(withUsage));
          expect((await pending).text).toBe("done");
          expect(stamps).toEqual([1000]);
          expect(events).toEqual(["provider-completed", "recorded", "logged"]);
          expect(client.calls.map((call) => call.stream)).toEqual([method === "call"]);
          expect(transcript.toMessages()).toEqual([{ role: "assistant", content: "done" }]);
        } finally {
          log.mockRestore();
          clock.mockRestore();
        }
      });

  it("retains reasoning and tool blocks while preserving plain reply shapes", async () => {
    const transcript = Transcript.inMemory("response-shapes");
    const client = new OfflineClient(async () => ({
      ...response(),
      reasoningContent: "private reasoning",
      toolCalls: [{ id: "call", toolName: "Read", args: { path: "file" } }],
    }));
    await new ModelFacade(client, transcript).callWithoutStreaming("system", [], []);
    expect(transcript.toMessages()).toEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", reasoningContent: "private reasoning" },
          { type: "text", text: "done" },
          { type: "tool_use", id: "call", name: "Read", input: { path: "file" } },
        ],
      },
    ]);
  });

  for (const method of ["call", "callWithoutStreaming"] as const)
    it(`${method} leaves cache freshness untouched on failure`, async () => {
      const stamps: number[] = [];
      const client = new OfflineClient(async () => {
        throw new Error("offline transport failure");
      });
      const transcript = Transcript.inMemory("primary-cache-failure");
      const facade = new ModelFacade(client, transcript, undefined, (at) => stamps.push(at));
      await expect(facade[method]("system", [], [])).rejects.toThrow("offline transport failure");
      expect(stamps).toEqual([]);
      expect(transcript.toMessages()).toEqual([]);
    });

  it("records only the successful nonstreaming fallback, using its own request start", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    const stamps: number[] = [];
    const client = new OfflineClient(async (options) => {
      clock.mockReturnValue(options.stream ? 2000 : 9000);
      if (options.stream) throw new Error("stream unavailable");
      return response(false);
    });
    const transcript = Transcript.inMemory("primary-cache-fallback");
    const facade = new ModelFacade(client, transcript, undefined, (at) => stamps.push(at));
    try {
      await expect(facade.call("system", [], [])).rejects.toThrow("stream unavailable");
      expect(stamps).toEqual([]);
      await facade.callWithoutStreaming("system", [], []);
      expect(stamps).toEqual([2000]);
      expect(client.calls.map((call) => call.stream)).toEqual([true, false]);
      expect(transcript.toMessages()).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("wireRunModelFacade cache lifecycle", () => {
  it("does not stamp auxiliary calls even when they reuse the primary client", async () => {
    const stamps: number[] = [];
    const client = new OfflineClient(async () => response());
    const accounting = createRunUsageAccounting({
      session: { state: {} } as SessionBundle,
      sid: "shared-summary-client",
      persistExternalBilledUsage() {},
      recordGoalJudgeUsage: () => undefined,
    });
    const { modelFacade } = wireRunModelFacade({
      llmClient: client,
      auxSummaryClient: client,
      transcript: Transcript.inMemory("shared-summary-client"),
      accounting,
      onPrimaryResponse: (at) => stamps.push(at),
    });
    await modelFacade.summarize!("summarize", "synthetic content");
    expect(stamps).toEqual([]);
    expect(client.calls).toHaveLength(1);
    await modelFacade.callWithoutStreaming("system", [], []);
    expect(stamps).toHaveLength(1);
    expect(client.calls).toHaveLength(2);
  });

  for (const exhaustsBudget of [false, true])
    it(`does not stamp auxiliary summaries${exhaustsBudget ? " or budget-blocked primary calls" : ""}`, async () => {
      const stamps: number[] = [];
      const primary = new OfflineClient(async () => response(false));
      const auxiliary = new OfflineClient(async () => response());
      const accounting = createRunUsageAccounting({
        session: { state: {} } as SessionBundle,
        sid: "cache-lifecycle",
        persistExternalBilledUsage() {},
        recordGoalJudgeUsage: () => (exhaustsBudget ? "token_budget_exhausted" : undefined),
      });
      const { modelFacade } = wireRunModelFacade({
        llmClient: primary,
        auxSummaryClient: auxiliary,
        transcript: Transcript.inMemory("cache-lifecycle-wiring"),
        accounting,
        onPrimaryResponse: (at) => stamps.push(at),
      });
      expect(await modelFacade.summarize!("summarize", "synthetic content")).toBe("done");
      expect(stamps).toEqual([]);
      expect(primary.calls).toHaveLength(0);
      expect(auxiliary.calls).toHaveLength(1);
      expect(auxiliary.calls[0]).toMatchObject({
        requestVisible: false,
        usagePurpose: "tool_summary",
      });
      expect(accounting.getExternalRunUsage()).toMatchObject(usage);
      await modelFacade.call("system", [], []);
      expect(primary.calls).toHaveLength(exhaustsBudget ? 0 : 1);
      expect(stamps).toHaveLength(exhaustsBudget ? 0 : 1);
    });
});
