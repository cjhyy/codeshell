/**
 * Transport layer — abstracts how messages travel between client and server.
 *
 * Three implementations:
 *   - InProcessTransport: direct function calls (same process, zero overhead)
 *   - StdioTransport:     newline-delimited JSON over stdin/stdout (cross-process,
 *                         e.g. agent daemon spawned as child)
 *   - IpcTransport:       host-agnostic adapter over a sink + subscribe pair.
 *                         Electron wires `webContents.send` and `ipcMain.on`
 *                         into it on the main side, and `ipcRenderer.send` +
 *                         `ipcRenderer.on` on the renderer side. Core does NOT
 *                         import electron — callers supply the IPC functions.
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

// ─── IPC Transport ──────────────────────────────────────────────────

/**
 * Function the IpcTransport calls to push an outbound message onto the
 * host's IPC channel. On the Electron main side this typically wraps
 * `webContents.send(channel, msg)`; on the renderer side it wraps
 * `ipcRenderer.send(channel, msg)`.
 */
export type IpcSink = (message: RpcMessage) => void;

/**
 * Subscribe helper the IpcTransport calls to listen for inbound messages
 * from the host's IPC channel. Returns an unsubscribe function so close()
 * can detach cleanly without leaking handlers on every transport rebuild.
 *
 * Electron main side typically does:
 *   ipcMain.on(channel, listener) → return () => ipcMain.off(channel, listener)
 * Renderer side mirrors with ipcRenderer.on/off.
 */
export type IpcSubscribe = (
  handler: (message: RpcMessage) => void,
) => () => void;

/**
 * Host-agnostic IPC transport. Used by Electron clients but takes no
 * Electron dependency itself — the host supplies a sink and a subscribe
 * function. This keeps `src/protocol/` importable from any environment
 * (Node, Bun, browser bundle) without dragging electron into core.
 *
 * Symmetry: both sides of the channel (main process and renderer process)
 * create their own IpcTransport with their respective sink/subscribe
 * implementations. The Transport contract is identical; only the host
 * wiring differs.
 */
export class IpcTransport implements Transport {
  private handlers: Array<(message: RpcMessage) => void> = [];
  private unsubscribe: (() => void) | null;

  constructor(sink: IpcSink, subscribe: IpcSubscribe) {
    this.sink = sink;
    this.unsubscribe = subscribe((msg) => {
      for (const handler of this.handlers) {
        handler(msg);
      }
    });
  }

  private readonly sink: IpcSink;

  send(message: RpcMessage): void {
    this.sink(message);
  }

  onMessage(handler: (message: RpcMessage) => void): void {
    this.handlers.push(handler);
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.handlers = [];
  }
}
