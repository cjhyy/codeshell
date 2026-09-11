import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, StreamEvent } from "../types.js";
import type { ToolContext, ToolRunYieldReason } from "../tool-system/context.js";
import { Engine } from "./engine.js";
import { Transcript } from "../session/transcript.js";

/** Per-test provider whose call #1 requests YieldTool; every later call is a
 *  plain final answer. A closure counter keeps tests isolated from each other. */
function registerYieldProvider(name: string, gate?: Promise<void>): { provider: string } {
  let count = 0;
  class RunYieldClient extends LLMClientBase {
    protected initClient(): void {}

    async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
      await gate;
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
  it("keeps reused caller options free of previous run stream wrappers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-reused-options-"));
    const { provider } = registerYieldProvider("fake-reused-options");
    const engine = makeEngine(dir, provider, { headless: false });
    const starts: Extract<StreamEvent, { type: "session_started" }>[] = [];
    const onStream = (event: StreamEvent) => {
      if (event.type === "session_started") starts.push(event);
    };
    const options = { cwd: dir, sessionId: "reuse", clientMessageId: "first", onStream };
    try {
      await engine.run("start work", options);
      options.clientMessageId = "second";
      await engine.run("finish work", options);
      const state = engine.getSessionManager().readSessionState("reuse");
      expect(options.onStream).toBe(onStream);
      expect(starts).toHaveLength(2);
      expect(starts[1]).toMatchObject({
        runId: state?.runId,
        previousRunId: starts[0]!.runId,
        clientMessageId: "second",
      });
      expect(starts[1]!.runId).not.toBe(starts[0]!.runId);
    } finally {
      await engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not persist an older Engine terminal under a newer run identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-concurrent-identity-"));
    const oldGate = Promise.withResolvers<void>();
    const newGate = Promise.withResolvers<void>();
    const oldStarted = Promise.withResolvers<void>();
    const newStarted = Promise.withResolvers<void>();
    const older = makeEngine(
      dir,
      registerYieldProvider("fake-concurrent-old", oldGate.promise).provider,
      { headless: false },
    );
    const newer = makeEngine(
      dir,
      registerYieldProvider("fake-concurrent-new", newGate.promise).provider,
      { headless: false },
    );
    const runs: Array<Promise<unknown>> = [];
    let currentRunId: string | undefined;
    try {
      runs.push(
        older.run("older work", {
          cwd: dir,
          sessionId: "shared",
          clientMessageId: "old-submit",
          onStream: (event) => {
            if (event.type === "session_started") oldStarted.resolve();
          },
        }),
      );
      await oldStarted.promise;
      runs.push(
        newer.run("newer work", {
          cwd: dir,
          sessionId: "shared",
          clientMessageId: "new-submit",
          onStream: (event) => {
            if (event.type !== "session_started") return;
            currentRunId = event.runId;
            newStarted.resolve();
          },
        }),
      );
      await newStarted.promise;
      oldGate.resolve();
      await runs[0];
      const state = JSON.parse(readFileSync(join(dir, "sessions", "shared", "state.json"), "utf8"));
      expect(state).toMatchObject({
        runId: currentRunId,
        clientMessageId: "new-submit",
        status: "active",
      });
      expect(state.lastCompletionKind).toBeUndefined();
    } finally {
      oldGate.resolve();
      newGate.resolve();
      await Promise.allSettled(runs);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes the new run identity with active disk state on resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-resume-identity-"));
    const { provider } = registerYieldProvider("fake-resume-disk-identity");
    try {
      const engine = makeEngine(dir, provider, { headless: false });
      await engine.run("start async work", {
        cwd: dir,
        sessionId: "resume-identity",
        clientMessageId: "first-submit",
      });
      const previousRunId = JSON.parse(
        readFileSync(join(dir, "sessions", "resume-identity", "state.json"), "utf8"),
      ).runId;
      let stateAtStart: Record<string, unknown> | undefined;
      let startEvent: StreamEvent | undefined;
      await engine.run("background result", {
        cwd: dir,
        sessionId: "resume-identity",
        injected: true,
        onStream: (event) => {
          if (event.type !== "session_started") return;
          startEvent = event;
          stateAtStart = JSON.parse(
            readFileSync(join(dir, "sessions", "resume-identity", "state.json"), "utf8"),
          );
        },
      });
      expect(startEvent?.runId).toBeString();
      expect(startEvent).toMatchObject({ previousRunId });
      expect(stateAtStart).toMatchObject({ runId: startEvent!.runId, status: "active" });
      expect(stateAtStart?.clientMessageId).toBeUndefined();
      expect(stateAtStart?.lastCompletionKind).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries the final run body on its terminal event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-final-body-"));
    const { provider } = registerYieldProvider("fake-terminal-body");
    const events: StreamEvent[] = [];
    try {
      const result = await makeEngine(dir, provider, { headless: true }).run("finish work", {
        cwd: dir,
        onStream: (event) => events.push(event),
      });
      expect(result.text).toBe("finished after yield");
      expect(turnCompletes(events).at(-1)).toMatchObject({
        reason: "completed",
        text: result.text,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("anchors the run start to its durable user message identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-run-identity-"));
    const { provider } = registerYieldProvider("fake-run-identity");
    const events: StreamEvent[] = [];
    try {
      const engine = makeEngine(dir, provider, { headless: false });
      await engine.run("start async work", {
        cwd: dir,
        sessionId: "identity",
        clientMessageId: "submit-identity",
        onStream: (event) => {
          events.push(event);
        },
      });
      const transcript = Transcript.loadFromFile(
        join(dir, "sessions", "identity", "transcript.jsonl"),
      );
      const user = transcript.getEvents("message").find((event) => event.data.role === "user");
      expect(user?.id).toBeString();
      expect(events.find((event) => event.type === "session_started")).toMatchObject({
        runId: user!.id,
        clientMessageId: "submit-identity",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const layer of ["EngineResult", "run_result"] as const) {
    it(`preserves background_wait in ${layer}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "engine-yield-receipt-"));
      const { provider } = registerYieldProvider(`fake-yield-receipt-${layer}`);
      try {
        const engine = makeEngine(dir, provider, { headless: false });
        const result = await engine.run("start async work", {
          cwd: dir,
          sessionId: "yield-receipt",
          clientMessageId: "yield-submit",
        });
        const receipt = Transcript.loadFromFile(
          join(dir, "sessions", "yield-receipt", "transcript.jsonl"),
        );
        const observed =
          layer === "EngineResult"
            ? result
            : receipt.findRunResultByClientMessageId("yield-submit");
        expect(observed).toMatchObject({ reason: "completed", completionKind: "background_wait" });
        const replayed = await engine.run("start async work", {
          cwd: dir,
          sessionId: "yield-receipt",
          clientMessageId: "yield-submit",
        });
        expect(replayed).toEqual(result);
        expect(
          receipt.getEvents("message").filter((event) => event.data.role === "user"),
        ).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

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
        expect(turnCompletes(events)).toEqual([
          { type: "turn_complete", reason: "completed", text: result.text },
        ]);
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
      expect(turnCompletes(events)).toEqual([
        { type: "turn_complete", reason: "completed", text: result.text },
      ]);
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
