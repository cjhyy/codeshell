/**
 * Typed factories — the recommended public entry points for business
 * consumers of `@cjhyy/code-shell-core`.
 *
 * Standard §7 declares a stable API shape:
 *
 *   const [serverT, clientT] = createInProcessTransport();
 *   const server = await createServer({ transport: serverT, cwd, llm });
 *   const client = createClient({ transport: clientT });
 *   client.onStreamEvent(({ sessionId, event }) => {});
 *   await client.run({ sessionId: "main", task: "..." });
 *
 * Direct `new Engine(...)` / `new AgentServer(...)` / `new AgentClient(...)`
 * remain supported for advanced cases, but most embedders should use these
 * helpers. They:
 *
 *   - Construct the Engine for you from a flat config.
 *   - Wire the AgentServer to the supplied transport.
 *   - Return a `close()` lifecycle hook that cleans up in the right order.
 *
 * These factories deliberately accept a `Transport` rather than building
 * one internally — they need to compose with `createInProcessTransport`
 * (for in-process embedders), `StdioTransport` (for the worker), or a
 * future `IpcAdapter`. A factory that hides the transport choice would
 * preclude the multi-host story standard §S8 describes.
 */

import type { LLMConfig } from "../types.js";
import { Engine, type EngineConfig } from "../engine/engine.js";
import { AgentServer } from "./server.js";
import { AgentClient } from "./client.js";
import type { Transport } from "./transport.js";

export interface CreateServerOptions {
  /**
   * Transport the server reads requests from and writes notifications to.
   * Pair it with the matching client transport from
   * `createInProcessTransport()` (in-process embed) or a `StdioTransport`
   * (worker process).
   */
  transport: Transport;
  /**
   * LLM provider/model credentials. Forwarded to `EngineConfig.llm`.
   * Required because there is no useful default — every embedder needs
   * to choose a provider.
   */
  llm: LLMConfig;
  /** Working directory the Engine treats as the project root. */
  cwd?: string;
  /** Permission mode for the Engine. Defaults to "default". */
  permissionMode?: EngineConfig["permissionMode"];
  /**
   * Escape hatch for embedders who need to set EngineConfig fields the
   * stable surface doesn't expose. Anything passed here is shallow-merged
   * over the factory's computed config. Use sparingly — fields outside
   * this options bag are not part of the stable API contract and may
   * move to `internal` in a future version.
   */
  engineOverrides?: Partial<EngineConfig>;
}

export interface ServerHandle {
  /**
   * The constructed AgentServer. Most embedders only need `close()`; this
   * is exposed for advanced cases (custom hook registration, dynamic tool
   * registry updates) that the typed surface doesn't yet cover.
   */
  readonly server: AgentServer;
  /**
   * The Engine instance the server wraps. Same caveat as `server` —
   * direct access is supported but not recommended.
   */
  readonly engine: Engine;
  /**
   * Tear down the server (which aborts any active run + emits the final
   * shutdown notification). Safe to call multiple times.
   */
  close(): void;
}

/**
 * Build an `Engine` + `AgentServer` from a flat config and wire them to
 * the caller's `Transport`. Most embedders should call this rather than
 * instantiating the engine/server pair manually.
 */
export function createServer(options: CreateServerOptions): ServerHandle {
  const config: EngineConfig = {
    llm: options.llm,
    cwd: options.cwd,
    permissionMode: options.permissionMode,
    ...options.engineOverrides,
  };
  const engine = new Engine(config);
  const server = new AgentServer({ engine, transport: options.transport });

  let closed = false;
  return {
    server,
    engine,
    close(): void {
      if (closed) return;
      closed = true;
      server.close();
    },
  };
}

export interface CreateClientOptions {
  /** Transport paired with the server's. */
  transport: Transport;
}

/**
 * Thin convenience wrapper around `new AgentClient`. Exists so the
 * recommended public surface is fully createX-style, mirroring
 * `createServer`. Future versions may add typed event subscriptions or
 * stream-event filters here without breaking embedders.
 */
export function createClient(options: CreateClientOptions): AgentClient {
  return new AgentClient({ transport: options.transport });
}
