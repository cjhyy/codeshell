import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, StreamEvent } from "../types.js";
import type { ToolContext, ToolRunYieldReason } from "../tool-system/context.js";
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
  opts: { headless: boolean; isSubAgent?: boolean },
  reason: ToolRunYieldReason | ToolRunYieldReason[] = "background_notification",
  onYieldToolRun?: (engine: Engine, ctx: ToolContext | undefined) => void,
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
      for (const r of Array.isArray(reason) ? reason : [reason]) {
        ctx?.runYield?.request(r);
      }
      onYieldToolRun?.(engine, ctx);
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

  it("honours a committed reply stop in interactive, headless, and sub-agent runs", async () => {
    const modes = [
      ["interactive", { headless: false }],
      ["headless", { headless: true }],
      ["subagent", { headless: false, isSubAgent: true }],
    ] as const;

    for (const [label, opts] of modes) {
      const dir = mkdtempSync(join(tmpdir(), `engine-reply-committed-${label}-`));
      const { provider } = registerYieldProvider(`fake-reply-committed-${label}`);
      const events: StreamEvent[] = [];

      try {
        const engine = makeEngine(dir, provider, opts, "reply_committed");
        const result = await engine.run("commit the host reply", {
          cwd: dir,
          onStream: (event) => {
            events.push(event);
          },
        });

        expect(result.text).toBe("launching");
        expect(modelRounds(events)).toBe(1);
        expect(turnCompletes(events)).toEqual([{ type: "turn_complete", reason: "completed" }]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("re-drives a steer that arrived while the reply-committing batch was executing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-reply-steer-"));
    const { provider } = registerYieldProvider("fake-reply-committed-steer");
    const events: StreamEvent[] = [];

    try {
      const engine = makeEngine(
        dir,
        provider,
        { headless: false },
        "reply_committed",
        (eng, ctx) => {
          // Simulates a user message landing mid-batch: the run is active, so
          // the steer is accepted into the queue.
          const steer = eng.enqueueSteer(ctx?.sessionId ?? "", "second user message", "steer-1");
          expect(steer.accepted).toBe(true);
        },
      );
      const result = await engine.run("commit the host reply", {
        cwd: dir,
        onStream: (event) => {
          events.push(event);
        },
      });

      // The committed reply answered the previous content only; the queued
      // steer must be injected and answered by a re-driven model round, not
      // stranded in the engine's steer queue until dispose.
      expect(events.some((e) => e.type === "steer_injected")).toBe(true);
      expect(modelRounds(events)).toBe(2);
      expect(result.text).toBe("finished after yield");
      expect(turnCompletes(events)).toEqual([{ type: "turn_complete", reason: "completed" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the background_wait park when the same batch also committed a reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-reply-bg-"));
    const { provider } = registerYieldProvider("fake-reply-committed-bg");
    const events: StreamEvent[] = [];

    try {
      const engine = makeEngine(dir, provider, { headless: false }, [
        "background_notification",
        "reply_committed",
      ]);
      const result = await engine.run("reply and launch background work", {
        cwd: dir,
        onStream: (event) => {
          events.push(event);
        },
      });

      // Background work is still running: the run must park as background_wait
      // so its completion notification finds a parked session — the committed
      // reply must not downgrade the result to a plain completion.
      expect(result.text).toBe("launching");
      expect(modelRounds(events)).toBe(1);
      const completes = turnCompletes(events);
      expect(completes).toHaveLength(1);
      expect(completes[0]!.completionKind).toBe("background_wait");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
