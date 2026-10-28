import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MimiCompanionAction } from "../../shared/mimi-companion.js";

export interface CompanionOperation {
  id: string;
  action: MimiCompanionAction;
  phase: "start" | "end";
  target?: { x: number; y: number };
  capture: boolean;
  failed?: boolean;
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
    (input.phase !== "start" && input.phase !== "end") ||
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
  return {
    id: input.id,
    action: input.action as MimiCompanionAction,
    phase: input.phase,
    capture: input.capture,
    ...(target ? { target } : {}),
    ...(input.failed === true ? { failed: true } : {}),
  };
}

/** Content-free, local presentation channel. It grants no computer-action authority. */
export async function createCuaActivityServer(
  onOperation: (event: CompanionOperation) => void | Promise<void>,
): Promise<{ socketPath: string; token: string; close(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir().length < 60 ? tmpdir() : "/tmp", "cs-actor-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "activity.sock");
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  const cleanups = new Set<Promise<void>>();
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
        const parsed = parseCompanionOperation(input);
        if (!parsed) return socket.destroy();
        queue = queue
          .then(async () => {
            if (socket.destroyed) return;
            if (parsed.phase === "start") {
              if (active.has(parsed.id) || active.size >= 64) return;
              active.set(parsed.id, parsed);
              await onOperation(parsed);
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
    });
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
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled(cleanups);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
