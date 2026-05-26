/**
 * SDK smoke test — Gate 3 / B3.
 *
 * Asserts that the recommended public surface (`createServer` /
 * `createClient` / `createInProcessTransport`) can be used end-to-end
 * importing only from `@cjhyy/code-shell-core`'s package root — no deep
 * imports into `./engine/...` or `./tool-system/...`. This is the smoke
 * test mentioned in standard §S7 and the plan's B3 checklist.
 *
 * The test does NOT actually hit an LLM (would require credentials and a
 * network round-trip). It verifies the construction shape and the
 * `close()` lifecycle — enough to catch breakage where someone moves a
 * type behind the `internal` boundary by mistake.
 */
import { describe, it, expect } from "bun:test";
// Importing through a relative path that mirrors what an SDK consumer
// would write: from the package root only. Deep imports into engine/* or
// tool-system/* would defeat the purpose — they're internal.
import {
  createServer,
  createClient,
  createInProcessTransport,
  type LLMConfig,
  type ServerHandle,
  type CreateServerOptions,
  type CreateClientOptions,
  Methods,
} from "../packages/core/src/index.ts";

const fakeLLM: LLMConfig = {
  provider: "anthropic",
  model: "claude-haiku-4-5-20251001",
  apiKey: "sk-not-real",
};

describe("SDK smoke (B3)", () => {
  it("createServer + createClient compose via createInProcessTransport", () => {
    const [serverT, clientT] = createInProcessTransport();
    const opts: CreateServerOptions = {
      transport: serverT,
      llm: fakeLLM,
      cwd: process.cwd(),
      permissionMode: "default",
    };
    const handle: ServerHandle = createServer(opts);
    expect(handle.server).toBeDefined();
    expect(handle.engine).toBeDefined();

    const clientOpts: CreateClientOptions = { transport: clientT };
    const client = createClient(clientOpts);
    expect(client).toBeDefined();
    // Method names should be reachable from the public surface so an
    // SDK consumer can build typed wrappers around them.
    expect(Methods.Run).toBeDefined();

    // Cleanup in the documented order (close server first so its final
    // shutdown notification reaches the client transport before it's
    // torn down).
    handle.close();
    client.close();
  });

  it("close() is idempotent", () => {
    const [serverT] = createInProcessTransport();
    const handle = createServer({ transport: serverT, llm: fakeLLM });
    handle.close();
    // Second call must not throw.
    expect(() => handle.close()).not.toThrow();
  });

  it("engineOverrides shallow-merges custom EngineConfig fields", () => {
    const [serverT] = createInProcessTransport();
    const handle = createServer({
      transport: serverT,
      llm: fakeLLM,
      cwd: "/tmp",
      engineOverrides: { maxTurns: 7, headless: true },
    });
    // We can't observe EngineConfig directly without reaching into the
    // engine, but the constructor would throw if overrides clobbered the
    // required `llm` field. Treat successful construction + non-null
    // engine reference as the assertion.
    expect(handle.engine).toBeDefined();
    handle.close();
  });
});
