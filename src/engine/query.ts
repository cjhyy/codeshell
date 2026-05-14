/**
 * High-level query API — async generator wrapping TurnLoop.
 *
 * Callers consume events via `for await (const event of query(params))`.
 * This is the public entry point for running agentic queries; TurnLoop
 * is the internal state machine.
 *
 * Adapted from restored-src/src/query.ts, simplified for Code Shell.
 */

import type {
  Message,
  StreamEvent,
  ToolDefinition,
  TerminalReason,
} from "../types.js";
import { TurnLoop, type TurnLoopConfig, type TurnLoopDeps } from "./turn-loop.js";
import { logger } from "../logging/logger.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface QueryParams {
  /** Initial message history (including the new user message). */
  messages: Message[];
  /** System prompt text. */
  systemPrompt: string;
  /** Available tool definitions. */
  tools: ToolDefinition[];
  /** Max turns before forced stop. */
  maxTurns?: number;
  /** Max tool calls per turn (default 20). */
  maxToolCallsPerTurn?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Dependencies injected by the caller (engine). */
  deps: QueryDeps;
}

export interface QueryDeps {
  model: TurnLoopDeps["model"];
  toolExecutor: TurnLoopDeps["toolExecutor"];
  contextManager: TurnLoopDeps["contextManager"];
  hooks: TurnLoopDeps["hooks"];
  transcript: TurnLoopDeps["transcript"];
}

export interface QueryResult {
  text: string;
  reason: TerminalReason;
  turnCount: number;
}

// ─── Query generator ────────────────────────────────────────────────

/**
 * Run an agentic query and yield stream events as they occur.
 *
 * Usage:
 *   const events: StreamEvent[] = [];
 *   for await (const event of query(params)) {
 *     events.push(event);
 *   }
 *   // last event contains the final result
 */
export async function* query(
  params: QueryParams,
): AsyncGenerator<StreamEvent, QueryResult, undefined> {
  const {
    messages,
    systemPrompt,
    tools,
    maxTurns = 30,
    maxToolCallsPerTurn = 20,
    signal,
    deps,
  } = params;

  // Collect events in a queue that the stream callback pushes to
  const eventQueue: StreamEvent[] = [];
  let resolveWait: (() => void) | null = null;

  const onStream = (event: StreamEvent) => {
    eventQueue.push(event);
    if (resolveWait) {
      resolveWait();
      resolveWait = null;
    }
  };

  const config: TurnLoopConfig = {
    maxTurns,
    maxToolCallsPerTurn,
    onStream,
    signal,
  };

  // Local overhead store — query() is a standalone entry point without a real
  // session id, so per-call in-memory state is enough.
  let localOverhead = 0;
  const loopDeps: TurnLoopDeps = {
    model: deps.model,
    toolExecutor: deps.toolExecutor,
    contextManager: deps.contextManager,
    hooks: deps.hooks,
    transcript: deps.transcript,
    systemPrompt,
    tools,
    sessionId: "query",
    ctxOverheadStore: {
      get: () => localOverhead,
      set: (_s, n) => {
        localOverhead = n;
      },
    },
  };

  const loop = new TurnLoop(loopDeps, config);

  // Start the turn loop in the background
  let result: { text: string; reason: TerminalReason } | undefined;
  let loopError: Error | undefined;
  let loopDone = false;

  const loopPromise = loop
    .run(messages)
    .then((r) => {
      result = r;
      loopDone = true;
      // Wake up the yield loop
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
      }
    })
    .catch((err) => {
      loopError = err;
      loopDone = true;
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
      }
    });

  // Yield events as they arrive
  while (!loopDone || eventQueue.length > 0) {
    if (eventQueue.length > 0) {
      yield eventQueue.shift()!;
    } else if (!loopDone) {
      // Wait for next event or loop completion
      await new Promise<void>((resolve) => {
        resolveWait = resolve;
      });
    }
  }

  // Ensure the loop promise is settled
  await loopPromise;

  if (loopError) {
    logger.error("query.error", { error: loopError.message });
    throw loopError;
  }

  return {
    text: result!.text,
    reason: result!.reason,
    turnCount: loop.currentTurn,
  };
}
