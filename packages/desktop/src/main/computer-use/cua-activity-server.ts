import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MimiCompanionAction } from "../../shared/mimi-companion.js";
import {
  CUA_ELEMENT_KINDS,
  parseCuaAvoidRect,
  type CuaAvoidRect,
  type CuaElementKind,
} from "./cua-activity.js";
import type { InputGateState, InputLane } from "./input-gate-policy.js";

export interface CompanionOperation {
  id: string;
  action: MimiCompanionAction;
  phase: "start" | "update" | "end";
  target?: { x: number; y: number };
  targetSource?: "native-cursor" | "element";
  avoidRect?: CuaAvoidRect;
  capture: boolean;
  failed?: boolean;
  lane?: InputLane;
  /** Root Session of the call, when the caller declared one. */
  sessionId?: string;
  /** Start only: target process, its window frame and the control category. */
  pid?: number;
  window?: CuaAvoidRect;
  element?: CuaElementKind;
}

const ACTIONS = new Set(["observe", "click", "type", "scroll", "drag", "key", "working", "error"]);

export function parseCompanionOperation(value: unknown): CompanionOperation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    typeof input.id !== "string" ||
    input.id.length < 1 ||
    input.id.length > 160 ||
    typeof input.action !== "string" ||
    !ACTIONS.has(input.action) ||
    (input.phase !== "start" && input.phase !== "update" && input.phase !== "end") ||
    typeof input.capture !== "boolean"
  )
    return null;
  let target: CompanionOperation["target"];
  if (input.target !== undefined) {
    const point = input.target as { x?: unknown; y?: unknown };
    if (
      !point ||
      typeof point.x !== "number" ||
      typeof point.y !== "number" ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      Math.abs(point.x) > 100_000 ||
      Math.abs(point.y) > 100_000
    )
      return null;
    target = { x: point.x, y: point.y };
  }
  if (
    input.phase === "update" &&
    (!target || input.capture || input.targetSource !== "native-cursor")
  )
    return null;
  const avoidRect = parseCuaAvoidRect(input.avoidRect);
  if (input.avoidRect !== undefined && !avoidRect) return null;
  const start = input.phase === "start";
  const frame = start ? parseCuaAvoidRect(input.window) : undefined;
  if (start && input.window !== undefined && !frame) return null;
  return {
    id: input.id,
    action: input.action as MimiCompanionAction,
    phase: input.phase,
    capture: input.capture,
    ...(target ? { target } : {}),
    ...(avoidRect ? { avoidRect } : {}),
    ...(input.targetSource === "native-cursor" ||
    (input.targetSource === "element" && input.phase === "start")
      ? { targetSource: input.targetSource }
      : {}),
    ...(input.failed === true ? { failed: true } : {}),
    ...(input.lane === "read" || input.lane === "background" || input.lane === "foreground"
      ? { lane: input.lane }
      : {}),
    ...(typeof input.sessionId === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(input.sessionId)
      ? { sessionId: input.sessionId }
      : {}),
    ...(start &&
    typeof input.pid === "number" &&
    Number.isSafeInteger(input.pid) &&
    input.pid > 0 &&
    input.pid < 2 ** 31
      ? { pid: input.pid }
      : {}),
    ...(frame ? { window: frame } : {}),
    ...(start && typeof input.element === "string" && CUA_ELEMENT_KINDS.has(input.element)
      ? { element: input.element as CuaElementKind }
      : {}),
  };
}

export interface CuaActivityServerOptions {
  onOperation(event: CompanionOperation): void | Promise<void>;
  /** Execution gate pushed to every authenticated proxy. Without one the gate is open. */
  gate?: {
    snapshot(): InputGateState;
    subscribe(listener: (state: InputGateState) => void): () => void;
  };
  /** Number of authenticated proxy connections changed. */
  onConnections?(count: number): void;
}

const OPEN_GATE: InputGateState = { version: 0, userActive: false, cancelledSessions: [] };

/** Content-free local channel. Activity flows in for presentation; the input
 * gate flows out to the proxy, which enforces it. It grants no input authority. */
export async function createCuaActivityServer(
  config: CuaActivityServerOptions | CuaActivityServerOptions["onOperation"],
): Promise<{ socketPath: string; token: string; close(): Promise<void> }> {
  const options: CuaActivityServerOptions =
    typeof config === "function" ? { onOperation: config } : config;
  const onOperation = options.onOperation;
  const authenticated = new Set<Socket>();
  const gateLine = (state: InputGateState) => JSON.stringify({ type: "gate", gate: state }) + "\n";
  const unsubscribeGate = options.gate?.subscribe((state) => {
    const line = gateLine(state);
    for (const socket of authenticated) if (!socket.destroyed) socket.write(line);
  });
  const connectionsChanged = () => options.onConnections?.(authenticated.size);
  const directory = await mkdtemp(join(tmpdir().length < 60 ? tmpdir() : "/tmp", "cs-actor-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "activity.sock");
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  const cleanups = new Set<Promise<void>>();
  // Resolved after a socket's close handler has registered its cleanup, so
  // `close()` cannot observe an empty cleanup set before that handler ran.
  const socketClosures = new Set<Promise<void>>();
  const server = createServer((socket) => {
    sockets.add(socket);
    const active = new Map<string, CompanionOperation>();
    let buffer = "";
    let queue = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 16_384) return socket.destroy();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > 2048) return socket.destroy();
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(line);
        } catch {
          return socket.destroy();
        }
        if (input?.token !== token) return socket.destroy();
        if (input.type === "hello") {
          if (!authenticated.has(socket)) {
            authenticated.add(socket);
            connectionsChanged();
          }
          socket.write(gateLine(options.gate?.snapshot() ?? OPEN_GATE));
          continue;
        }
        const parsed = parseCompanionOperation(input);
        if (!parsed) return socket.destroy();
        queue = queue
          .then(async () => {
            if (socket.destroyed) return;
            if (parsed.phase === "start") {
              if (active.has(parsed.id) || active.size >= 64) return;
              active.set(parsed.id, parsed);
              await onOperation(parsed);
            } else if (parsed.phase === "update") {
              const started = active.get(parsed.id);
              if (
                started &&
                !started.capture &&
                parsed.action === started.action &&
                parsed.capture === started.capture
              ) {
                const updated = {
                  ...started,
                  target: parsed.target,
                  targetSource: parsed.targetSource,
                  // An absent rectangle revokes the previous candidate rather
                  // than letting a stale input field survive an updated point.
                  avoidRect: parsed.avoidRect,
                };
                active.set(parsed.id, updated);
                await onOperation({ ...updated, phase: "update" });
              }
            } else {
              const started = active.get(parsed.id);
              if (started) {
                active.delete(parsed.id);
                await onOperation({ ...started, phase: "end", failed: parsed.failed });
              }
            }
            if (!socket.destroyed)
              socket.write(JSON.stringify({ id: parsed.id, phase: parsed.phase, ok: true }) + "\n");
          })
          .catch(() => {
            socket.destroy();
          });
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      if (authenticated.delete(socket)) connectionsChanged();
      // Queue cleanup after a pending hide has completed, so a dying proxy cannot
      // leave the companion permanently hidden or working.
      const cleanup = queue
        .finally(async () => {
          for (const event of active.values()) {
            try {
              await onOperation({ ...event, phase: "end", failed: true });
            } catch {
              /* Release every operation independently. */
            }
          }
          active.clear();
        })
        .catch(() => {});
      cleanups.add(cleanup);
      void cleanup.finally(() => cleanups.delete(cleanup));
      releaseClosure();
    });
    let releaseClosure!: () => void;
    const closure = new Promise<void>((resolve) => (releaseClosure = resolve));
    socketClosures.add(closure);
    void closure.finally(() => socketClosures.delete(closure));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    socketPath,
    token,
    async close() {
      unsubscribeGate?.();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([...socketClosures]);
      await Promise.allSettled(cleanups);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
