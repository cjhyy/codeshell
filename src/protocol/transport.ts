/**
 * Transport layer — abstracts how messages travel between client and server.
 *
 * Two implementations:
 *   - InProcessTransport: direct function calls (same process, zero overhead)
 *   - StdioTransport: newline-delimited JSON over stdin/stdout (cross-process)
 */

import type { RpcMessage } from "./types.js";
import { EventEmitter } from "node:events";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

// ─── Abstract Transport ─────────────────────────────────────────────

export interface Transport {
  /** Send a message to the other side. */
  send(message: RpcMessage): void;

  /** Register a handler for incoming messages. */
  onMessage(handler: (message: RpcMessage) => void): void;

  /** Clean up resources. */
  close(): void;
}

// ─── In-Process Transport ───────────────────────────────────────────

/**
 * Creates a pair of linked transports for same-process use.
 * Messages sent on one side are received on the other instantly.
 */
export function createInProcessTransport(): [Transport, Transport] {
  const emitterA = new EventEmitter();
  const emitterB = new EventEmitter();

  const sideA: Transport = {
    send(msg) {
      // A sends → B receives
      emitterB.emit("message", msg);
    },
    onMessage(handler) {
      emitterA.on("message", handler);
    },
    close() {
      emitterA.removeAllListeners();
      emitterB.removeAllListeners();
    },
  };

  const sideB: Transport = {
    send(msg) {
      // B sends → A receives
      emitterA.emit("message", msg);
    },
    onMessage(handler) {
      emitterB.on("message", handler);
    },
    close() {
      emitterA.removeAllListeners();
      emitterB.removeAllListeners();
    },
  };

  return [sideA, sideB];
}

// ─── Stdio Transport ────────────────────────────────────────────────

/**
 * Transport over stdio streams (newline-delimited JSON).
 * Used for cross-process communication.
 */
export class StdioTransport implements Transport {
  private rl: ReadlineInterface;
  private handlers: Array<(message: RpcMessage) => void> = [];

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {
    this.rl = createInterface({ input: this.input });
    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as RpcMessage;
        for (const handler of this.handlers) {
          handler(msg);
        }
      } catch {
        // Skip malformed lines
      }
    });
  }

  send(message: RpcMessage): void {
    this.output.write(JSON.stringify(message) + "\n");
  }

  onMessage(handler: (message: RpcMessage) => void): void {
    this.handlers.push(handler);
  }

  close(): void {
    this.rl.close();
    this.handlers = [];
  }
}
