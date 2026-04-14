/**
 * Streaming tool queue — enqueues tools for execution during streaming,
 * starts concurrency-safe tools immediately, queues unsafe tools for
 * sequential execution.
 *
 * Usage:
 *   const queue = new StreamingToolQueue(executor);
 *   // During streaming, as tool_use blocks arrive:
 *   queue.enqueue(toolCall);
 *   // After streaming completes:
 *   const results = await queue.drain();
 */

import type { ToolCall, ToolResult } from "../types.js";
import type { ToolExecutor } from "../tool/executor.js";

export class StreamingToolQueue {
  private readonly executor: ToolExecutor;
  private readonly pending = new Map<string, Promise<ToolResult>>();
  private readonly unsafeQueue: ToolCall[] = [];
  private readonly callOrder: string[] = [];
  private draining = false;

  constructor(executor: ToolExecutor) {
    this.executor = executor;
  }

  /**
   * Enqueue a tool for execution. Concurrency-safe tools start immediately;
   * unsafe tools are queued for sequential execution during drain().
   */
  enqueue(call: ToolCall): void {
    this.callOrder.push(call.id);

    if (this.executor.isConcurrencySafe(call.toolName)) {
      // Start immediately
      this.pending.set(call.id, this.executor.executeSingle(call));
    } else {
      this.unsafeQueue.push(call);
    }
  }

  /**
   * Execute all remaining unsafe tools sequentially, then await all results.
   * Returns results in original enqueue order.
   */
  async drain(): Promise<ToolResult[]> {
    if (this.draining) throw new Error("StreamingToolQueue already draining");
    this.draining = true;

    // Execute unsafe tools sequentially
    for (const call of this.unsafeQueue) {
      this.pending.set(call.id, this.executor.executeSingle(call));
      await this.pending.get(call.id);
    }

    // Await all results
    const resultMap = new Map<string, ToolResult>();
    for (const [id, promise] of this.pending) {
      resultMap.set(id, await promise);
    }

    // Return in original order
    return this.callOrder.map((id) => resultMap.get(id)!);
  }

  /** Number of tools currently enqueued or executing. */
  get size(): number {
    return this.callOrder.length;
  }
}
