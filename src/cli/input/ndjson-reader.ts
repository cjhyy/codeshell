/**
 * NDJSON input reader — parses structured input from stdin for SDK mode.
 *
 * Protocol:
 *   {"type": "message", "content": "user text"}
 *   {"type": "approval", "toolCallId": "xxx", "approved": true}
 *   {"type": "abort"}
 */

import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export type NdjsonMessage =
  | { type: "message"; content: string }
  | { type: "approval"; toolCallId: string; approved: boolean; reason?: string }
  | { type: "abort" }
  | { type: "ping" };

export class NdjsonReader {
  private handlers = new Map<string, ((msg: NdjsonMessage) => void)[]>();

  constructor(private readonly input: Readable = process.stdin) {}

  on(type: NdjsonMessage["type"], handler: (msg: NdjsonMessage) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  start(): void {
    const rl = createInterface({ input: this.input, crlfDelay: Infinity });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed) as NdjsonMessage;
        const handlers = this.handlers.get(msg.type) ?? [];
        for (const h of handlers) h(msg);
      } catch {
        // Skip malformed lines
      }
    });

    rl.on("close", () => {
      // stdin closed — trigger abort
      const handlers = this.handlers.get("abort") ?? [];
      for (const h of handlers) h({ type: "abort" });
    });
  }

  /** Async iterator for messages. */
  async *messages(): AsyncGenerator<NdjsonMessage> {
    const rl = createInterface({ input: this.input, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed) as NdjsonMessage;
      } catch {
        // Skip
      }
    }
  }
}
