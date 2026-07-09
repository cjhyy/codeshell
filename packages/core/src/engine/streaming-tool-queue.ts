/**
 * Tool execution queue for a completed model response.
 *
 * Despite the historical name, TurnLoop currently enqueues tool calls only
 * after `callModelWithFallback()` returns a complete LLMResponse. The queue's
 * job is concurrency policy inside that post-response batch: start
 * concurrency-safe tools as soon as they are enqueued, keep unsafe tools
 * sequential, and return results in original tool-call order.
 *
 * Usage:
 *   const queue = new StreamingToolQueue(executor);
 *   // After the full LLMResponse is available:
 *   queue.enqueue(toolCall);
 *   const results = await queue.drain();
 */

import type { ToolCall, ToolResult } from "../types.js";
import type { ToolExecutor } from "../tool-system/executor.js";

export class StreamingToolQueue {
  private readonly executor: ToolExecutor;
  private readonly pending = new Map<string, Promise<ToolResult>>();
  private readonly unsafeQueue: ToolCall[] = [];
  private readonly callOrder: string[] = [];
  private readonly toolNameById = new Map<string, string>();
  private draining = false;

  constructor(executor: ToolExecutor) {
    this.executor = executor;
  }

  /**
   * Enqueue a tool from the completed response. Concurrency-safe tools start
   * immediately within this post-response phase; unsafe tools are queued for
   * sequential execution during drain().
   */
  enqueue(call: ToolCall): void {
    this.callOrder.push(call.id);
    this.toolNameById.set(call.id, call.toolName);

    if (this.executor.isConcurrencySafe(call.toolName)) {
      // Start immediately. Attach a no-op catch so a synchronous/early rejection
      // doesn't surface as an unhandledRejection before drain() awaits it; the
      // real handling (→ error ToolResult) happens in drain()/toResult().
      const p = this.executor.executeSingle(call);
      p.catch(() => {});
      this.pending.set(call.id, p);
    } else {
      this.unsafeQueue.push(call);
    }
  }

  /**
   * Execute all remaining unsafe tools sequentially, then await all results.
   * Returns results in original enqueue order.
   *
   * A tool's promise can REJECT — not just resolve to an error ToolResult —
   * because permission.handleAsk (and pre_tool_use "ask") throw outside
   * executeSingle's try/catch. We must never let one rejection (a) abort the
   * drain and lose the other tools' results, or (b) leave a hole that surfaces
   * as `undefined` downstream (toolResultToBlock would crash on it). So every
   * await is funneled through toResult(), which converts a thrown value into a
   * synthetic error ToolResult, and any id still missing at the end is filled
   * with one too.
   */
  async drain(): Promise<ToolResult[]> {
    if (this.draining) throw new Error("StreamingToolQueue already draining");
    this.draining = true;

    const resultMap = new Map<string, ToolResult>();

    // Execute unsafe tools sequentially. A rejection here must not stop the
    // remaining unsafe tools from running.
    for (const call of this.unsafeQueue) {
      const p = this.executor.executeSingle(call);
      this.pending.set(call.id, p);
      resultMap.set(call.id, await this.toResult(call.id, call.toolName, p));
    }

    // Await all results (concurrency-safe tools started at enqueue time).
    for (const [id, promise] of this.pending) {
      if (resultMap.has(id)) continue; // already drained above
      const toolName = this.toolNameById.get(id) ?? "unknown";
      resultMap.set(id, await this.toResult(id, toolName, promise));
    }

    // Return in original order, with a synthetic error for any id that somehow
    // never produced a result (defensive — should not happen now).
    return this.callOrder.map(
      (id) =>
        resultMap.get(id) ?? {
          id,
          toolName: this.toolNameById.get(id) ?? "unknown",
          error: "Tool execution produced no result.",
          isError: true,
        },
    );
  }

  /** Await a tool promise, converting a rejection into an error ToolResult. */
  private async toResult(
    id: string,
    toolName: string,
    p: Promise<ToolResult>,
  ): Promise<ToolResult> {
    try {
      return await p;
    } catch (err) {
      return {
        id,
        toolName,
        error: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  }

  /** Number of tools currently enqueued or executing. */
  get size(): number {
    return this.callOrder.length;
  }
}
