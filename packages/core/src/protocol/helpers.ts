/**
 * Helpers for spinning up an in-process AgentServer + AgentClient pair.
 *
 * All internal codeshell paths that want to run an engine should go through
 * the protocol layer (AgentServer wraps the engine, AgentClient is the
 * consumer-facing handle). This helper exists so callers don't repeat the
 * 6-line "create transport / new server / new client / wire onStream /
 * try-finally close" boilerplate at every call site.
 *
 * Existing call sites that should use this:
 *   - src/cli/commands/run.ts        (headless CLI)
 *   - src/run/EngineRunner.ts         (RunManager)
 *
 * The REPL builds its own server+client because it needs the long-lived
 * AgentClient instance to drive the React UI's lifecycle (subscribing to
 * stream events, approval requests, status changes). One-shot callers want
 * the simpler "give me a client, hand back close()" shape this helper
 * provides.
 */

import type { Engine } from "../engine/engine.js";
import type { StreamCallback } from "../types.js";
import { AgentServer } from "./server.js";
import { AgentClient } from "./client.js";
import { createInProcessTransport } from "./transport.js";

export interface InProcessClientHandle {
  /** The client; pass to `client.run(task, { cwd, sessionId })` to execute. */
  readonly client: AgentClient;
  /**
   * Tear down server + client + transports. Call from a `finally` block.
   * Safe to call multiple times; subsequent calls are no-ops.
   */
  close(): void;
}

export interface CreateInProcessClientOptions {
  /** Stream callback to receive every event the server emits. */
  onStream?: StreamCallback;
}

/**
 * Wrap an Engine in an in-process AgentServer and return a client handle.
 * The handle's `close()` tears the whole pair down in the correct order:
 * client first (so its pending requests reject cleanly), then server (which
 * aborts any active run and clears approval timers).
 */
export function createInProcessClient(
  engine: Engine,
  options: CreateInProcessClientOptions = {},
): InProcessClientHandle {
  const [serverTransport, clientTransport] = createInProcessTransport();
  const server = new AgentServer({ engine, transport: serverTransport });
  const client = new AgentClient({ transport: clientTransport });

  if (options.onStream) {
    const cb = options.onStream;
    client.onStreamEvent((envelope) => cb(envelope.event));
  }

  let closed = false;
  return {
    client,
    close(): void {
      if (closed) return;
      closed = true;
      // Order matters: server.close() aborts the in-flight run AND emits
      // a final "shutdown" status notification through the still-open
      // transport pair. Then client.close() drains/rejects any pending
      // requests and tears down its transport end. Reversing this order
      // would silently drop the "shutdown" notification because the
      // client's transport would already be closed when server.notify
      // tries to send.
      server.close();
      client.close();
    },
  };
}
