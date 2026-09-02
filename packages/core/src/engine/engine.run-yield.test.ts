import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, StreamEvent } from "../types.js";
import type { ToolContext } from "../tool-system/context.js";
import { Engine } from "./engine.js";

/** Per-test provider whose call #1 requests YieldTool; every later call is a
 *  plain final answer. A closure counter keeps tests isolated from each other. */
function registerYieldProvider(name: string): { provider: string } {
  let count = 0;
  class RunYieldClient extends LLMClientBase {
    protected initClient(): void {}

    async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
      const usage = { promptTokens: 10, completionTokens: 1, totalTokens: 11 };
      this.recordUsage(usage, options);
      count += 1;
      if (count === 1) {
        return {
          text: "launching",
          toolCalls: [{ id: "tool-1", toolName: "YieldTool", args: {} }],
          stopReason: "tool_use",
          usage,
        };
      }
      return { text: "finished after yield", toolCalls: [], stopReason: "stop", usage };
    }
  }
  registerProvider(name, RunYieldClient);
  return { provider: name };
}

function makeEngine(
  dir: string,
  provider: string,
  opts: {
    headless: boolean;
    isSubAgent?: boolean;
    yieldReason?: "background_notification" | "reply_committed";
  },
): Engine {
  const engine = new Engine({
    llm: { provider, model: `${provider}-model`, apiKey: "test" } as never,
    cwd: dir,
    sessionStorageDir: join(dir, "sessions"),
    enabledBuiltinTools: [],
    maxTurns: 3,
    headless: opts.headless,
    ...(opts.isSubAgent ? { isSubAgent: true } : {}),
    permissionMode: "bypassPermissions",
  } as never);
  (engine as any).hooks.clear();
  engine.registerCustomTool(
    {
      name: "YieldTool",
      description: "launches async background work and requests a run yield",
      inputSchema: { type: "object", properties: {} },
      source: "builtin",
      permissionDefault: "allow",
    },
    async (_args, ctx?: ToolContext) => {
      if (opts.yieldReason === "reply_committed") {
        ctx?.runYield?.request("background_notification");
      }
      ctx?.runYield?.request(opts.yieldReason ?? "background_notification");
      return "background work started";
    },
  );
  return engine;
}

function turnCompletes(events: StreamEvent[]): Extract<StreamEvent, { type: "turn_complete" }>[] {
  return events.filter(
    (event): event is Extract<StreamEvent, { type: "turn_complete" }> =>
      event.type === "turn_complete",
  );
}

/** Model rounds inside the turn loop; fire-and-forget aux calls (session
 *  title) hit the same fake client but emit no stream_request_start. */
function modelRounds(events: StreamEvent[]): number {
  return events.filter((event) => event.type === "stream_request_start").length;
}

describe("Engine tool run yield gating", () => {
  it("ignores a tool run-yield in a headless run (one-shot caller keeps its full turn)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-run-yield-"));
    const { provider } = registerYieldProvider("fake-run-yield-headless");
    const events: StreamEvent[] = [];

    try {
      const engine = makeEngine(dir, provider, { headless: true });
      const result = await engine.run("start async work", {
        cwd: dir,
        onStream: (event) => {
          events.push(event);
        },
      });

      expect(result.text).toBe("finished after yield");
      expect(modelRounds(events)).toBe(2);
      const completes = turnCompletes(events);
      expect(completes).toHaveLength(1);
      expect(completes[0]!.completionKind).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a tool run-yield in a sub-agent run (parent cannot be woken for it)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-run-yield-"));
    const { provider } = registerYieldProvider("fake-run-yield-subagent");
    const events: StreamEvent[] = [];

    try {
      const engine = makeEngine(dir, provider, { headless: false, isSubAgent: true });
      const result = await engine.run("start async work", {
        cwd: dir,
        onStream: (event) => {
          events.push(event);
        },
      });

      expect(result.text).toBe("finished after yield");
      expect(modelRounds(events)).toBe(2);
      const completes = turnCompletes(events);
      expect(completes).toHaveLength(1);
      expect(completes[0]!.completionKind).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honours a tool run-yield in an interactive top-level run (parks as background_wait)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-run-yield-"));
    const { provider } = registerYieldProvider("fake-run-yield-interactive");
    const events: StreamEvent[] = [];

    try {
      const engine = makeEngine(dir, provider, { headless: false });
      const result = await engine.run("start async work", {
        cwd: dir,
        onStream: (event) => {
          events.push(event);
        },
      });

      expect(result.text).toBe("launching");
      expect(modelRounds(events)).toBe(1);
      const completes = turnCompletes(events);
      expect(completes).toHaveLength(1);
      expect(completes[0]!.completionKind).toBe("background_wait");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const mode of [
    { label: "interactive", headless: false, isSubAgent: false },
    { label: "headless", headless: true, isSubAgent: false },
    { label: "sub-agent", headless: false, isSubAgent: true },
  ]) {
    it(`terminates ${mode.label} runs after a committed gateway reply`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "engine-reply-committed-"));
      const { provider } = registerYieldProvider(`fake-reply-committed-${mode.label}`);
      const events: StreamEvent[] = [];

      try {
        const engine = makeEngine(dir, provider, {
          headless: mode.headless,
          isSubAgent: mode.isSubAgent,
          yieldReason: "reply_committed",
        });
        const result = await engine.run("send the gateway reply", {
          cwd: dir,
          onStream: (event) => events.push(event),
        });

        expect(result.text).toBe("launching");
        expect(result.reason).toBe("completed");
        expect(modelRounds(events)).toBe(1);
        const completes = turnCompletes(events);
        expect(completes).toHaveLength(1);
        expect(completes[0]!.reason).toBe("completed");
        expect(completes[0]!.completionKind).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
