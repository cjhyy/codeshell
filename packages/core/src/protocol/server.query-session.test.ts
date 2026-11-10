import { createFakeEngine } from "../testing/create-fake-engine.js";
import { describe, expect, spyOn, test } from "bun:test";
import type { Engine } from "../engine/engine.js";
import type { EngineConfigSlice } from "./chat-session-manager.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { AgentClient } from "./client.js";
import { AgentServer } from "./server.js";
import { createInProcessTransport } from "./transport.js";
import { ErrorCodes, type RpcResponse } from "./types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../session/session-manager.js";
import * as outputJournal from "../session/output-journal.js";
import { defaultCacheDir, writeCache } from "../llm/model-cache.js";

function fakeEngine(slice: EngineConfigSlice): Engine {
  const marker = slice.cwd ?? "global";
  const permissionMode = marker === "/project-b" ? "plan" : "default";
  return createFakeEngine({
    // Preserve the optional-capability fallbacks exercised by this fixture.
    dispose: undefined,
    getSessionManager: undefined,
    prepareSessionCloseFinalization: undefined,

    planMode: permissionMode === "plan",
    isHeadless: () => false,
    getToolRegistry: () => ({
      listToolsDetailed: () => [{ name: `tool:${marker}`, description: marker }],
    }),
    getConfig: () => ({
      cwd: marker,
      permissionMode,
      llm: { provider: "noop", model: `model:${marker}` },
    }),
    getFeatureFlags: () => ({ [`feature:${marker}`]: true }),
    getPermissionRules: () => [{ tool: `tool:${marker}`, decision: "allow" }],
  });
}

describe("AgentServer session-scoped queries", () => {
  test("tools and config resolve the requested session instead of the first live engine", async () => {
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: fakeEngine,
    });
    await manager.getOrCreate("session-a", { cwd: "/project-a" } as EngineConfigSlice);
    await manager.getOrCreate("session-b", { cwd: "/project-b" } as EngineConfigSlice);

    const [serverTransport, clientTransport] = createInProcessTransport();
    const server = new AgentServer({ transport: serverTransport, chatManager: manager });
    const client = new AgentClient({ transport: clientTransport });

    const tools = await client.query("tools", "session-b");
    expect(tools.data).toEqual([{ name: "tool:/project-b", description: "/project-b" }]);

    const config = await client.query("config", "session-b");
    expect(config.data).toMatchObject({
      cwd: "/project-b",
      model: "model:/project-b",
      permissionMode: "plan",
      planMode: true,
      featureFlags: { "feature:/project-b": true },
    });

    server.close();
  });

  test("a global query uses a detached neutral engine, not a live project's policy", async () => {
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: fakeEngine,
    });
    await manager.getOrCreate("session-b", { cwd: "/project-b" } as EngineConfigSlice);

    const [serverTransport, clientTransport] = createInProcessTransport();
    const server = new AgentServer({ transport: serverTransport, chatManager: manager });
    const client = new AgentClient({ transport: clientTransport });

    const config = await client.query("config");
    expect(config.data).toMatchObject({
      cwd: "global",
      model: "model:global",
      permissionMode: "default",
      planMode: false,
    });

    server.close();
  });
});

/** Capture the serialized RPC envelope, including error codes, before query extraction. */
async function queryWire(
  params: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Promise<RpcResponse> {
  const engine = Object.assign(
    fakeEngine({} as EngineConfigSlice),
    { queryCapability: async () => ({ handled: false }) },
    overrides,
  );
  const [serverTransport, peer] = createInProcessTransport();
  const response = new Promise<RpcResponse>((resolve) => {
    peer.onMessage((message) => {
      if ("id" in message && message.id === 71 && !("method" in message)) resolve(message);
    });
  });
  const server = new AgentServer({
    transport: serverTransport,
    engine,
    allowUsageAggregation: true,
  });
  try {
    peer.send({ jsonrpc: "2.0", id: 71, method: "agent/query", params });
    return JSON.parse(JSON.stringify(await response));
  } finally {
    await server.close();
    peer.close();
  }
}

const queryResult = (type: string, data: unknown) => ({
  jsonrpc: "2.0",
  id: 71,
  result: { type, data },
});
const queryError = (code: number, message: string) => ({
  jsonrpc: "2.0",
  id: 71,
  error: { code, message },
});

describe("AgentServer query wire contracts before registry extraction", () => {
  test.each([
    ["config_set", {}, "key is required for config_set"],
    ["config_get", {}, "key is required for config_get"],
    ["permission_set", { value: "invalid" }, "invalid permission mode: invalid"],
    ["provider_add", {}, "provider_add: requires {key, kind, baseUrl, ...}"],
    ["provider_refresh", {}, "provider_refresh: key required"],
    ["provider_delete", {}, "provider_delete: key required"],
    ["model_add", {}, "model_add: requires {key, model, providerKey}"],
    ["model_delete", {}, "model_delete: key required"],
  ])("%s retains its existing InternalError validation response", async (type, params, message) => {
    expect(await queryWire({ type, ...(params as object) })).toEqual(
      queryError(ErrorCodes.InternalError, String(message)),
    );
  });

  test("configuration reads and writes retain their data shape and secret masking", async () => {
    const writes: unknown[] = [];
    const engine = {
      updateConfig: (key: string, value: unknown) => writes.push([key, value]),
      readSetting: () => ({ label: "visible", apiKey: "fixture-secret" }),
    };
    expect(
      await queryWire({ type: "config_set", key: "llm.apiKey", value: "fixture-secret" }, engine),
    ).toEqual(queryResult("config_set", { key: "llm.apiKey", value: "[redacted]" }));
    expect(writes).toEqual([["llm.apiKey", "fixture-secret"]]);
    expect(await queryWire({ type: "config_get", key: "provider" }, engine)).toEqual(
      queryResult("config_get", {
        key: "provider",
        value: { label: "visible", apiKey: "[redacted]" },
      }),
    );
    expect(await queryWire({ type: "config_set", key: "permissions", value: {} }, engine)).toEqual(
      queryError(
        ErrorCodes.InternalError,
        'config_set refused: "permissions" is a protected trust/permission field and cannot be written through this path.',
      ),
    );
    expect(writes).toHaveLength(1);
  });

  test("permission_set returns the selected mode and forwards it once", async () => {
    const modes: string[] = [];
    expect(
      await queryWire(
        { type: "permission_set", value: "dontAsk" },
        {
          setPermissionMode: (mode: string) => modes.push(mode),
        },
      ),
    ).toEqual(queryResult("permission_set", { mode: "dontAsk" }));
    expect(modes).toEqual(["dontAsk"]);
  });

  test.each([
    [
      "provider_add",
      { provider: { key: "new", kind: "openai", baseUrl: "https://fixture.invalid" } },
      "providers",
      [{ key: "old" }, { key: "new", kind: "openai", baseUrl: "https://fixture.invalid" }],
      { ok: true, key: "new" },
    ],
    ["provider_delete", { key: "old" }, "providers", [], { ok: true }],
    [
      "model_add",
      { model: { key: "new", model: "model-new", providerKey: "provider" } },
      "models",
      [{ key: "old" }, { key: "new", model: "model-new", providerKey: "provider" }],
      { ok: true, key: "new" },
    ],
    ["model_delete", { key: "old" }, "models", [], { ok: true }],
  ])("%s preserves mutation and success response", async (type, params, key, next, data) => {
    const writes: unknown[] = [];
    const result = await queryWire(
      { type, ...(params as object) },
      {
        readSetting: (name: string) => (name === key ? [{ key: "old" }] : []),
        updateConfig: (name: string, value: unknown) => writes.push([name, value]),
      },
    );
    expect(result).toEqual(queryResult(String(type), data));
    expect(writes).toEqual([[key, next]]);
  });

  test("provider deletion preserves references and refresh rejects unknown providers", async () => {
    const engine = {
      readSetting: (key: string) =>
        key === "models"
          ? [
              { key: "m1", providerKey: "p" },
              { key: "m2", providerKey: "p" },
            ]
          : [],
    };
    expect(await queryWire({ type: "provider_delete", key: "p" }, engine)).toEqual(
      queryError(ErrorCodes.InternalError, "provider p referenced by models: m1, m2"),
    );
    expect(await queryWire({ type: "provider_refresh", key: "missing" }, engine)).toEqual(
      queryError(ErrorCodes.InternalError, "provider not found: missing"),
    );
  });

  test("model entries retain protocol names, fallback labels, active marker and limits", async () => {
    expect(
      await queryWire(
        { type: "models" },
        {
          getModelPool: () => ({
            getActiveKey: () => "m",
            list: () => [
              {
                key: "m",
                model: "native",
                provider: "openai",
                providerKey: "p",
                maxOutputTokens: 40,
                maxContextTokens: 200,
              },
            ],
          }),
        },
      ),
    ).toEqual(
      queryResult("models", [
        {
          key: "m",
          label: "m",
          model: "native",
          protocol: "openai",
          providerKey: "p",
          active: true,
          maxOutputTokens: 40,
          maxContextTokens: 200,
        },
      ]),
    );
  });

  test("providers retain model/cache metadata while redacting secrets", async () => {
    const key = "architecture-query-contract";
    const cache = writeCache(defaultCacheDir(), key, [
      { id: "cached", contextLength: 100, maxOutputTokens: 10 },
    ]);
    try {
      expect(
        await queryWire(
          { type: "providers" },
          {
            readSetting: (name: string) =>
              name === "providers"
                ? [{ key, apiKey: "fixture-secret", label: "Visible" }]
                : [{ providerKey: key }, { providerKey: key }],
          },
        ),
      ).toEqual(
        queryResult("providers", [
          {
            key,
            apiKey: "[redacted]",
            label: "Visible",
            modelCount: 2,
            cachedModels: 1,
            cachedAt: cache.fetchedAt,
          },
        ]),
      );
    } finally {
      rmSync(join(defaultCacheDir(), `${key}.json`), { force: true });
    }
  });

  test("provider_refresh uses the bundled OpenRouter snapshot without network requests", async () => {
    const key = "architecture-query-refresh";
    try {
      const response = await queryWire(
        { type: "provider_refresh", key },
        {
          readSetting: () => [{ key, kind: "openrouter", baseUrl: "https://fixture.invalid" }],
        },
      );
      expect(response).toEqual(queryResult("provider_refresh", { count: expect.any(Number) }));
      expect((response.result as { data: { count: number } }).data.count).toBeGreaterThan(0);
    } finally {
      rmSync(join(defaultCacheDir(), `${key}.json`), { force: true });
    }
  });

  test("session list, detail and unavailable journal preserve their response envelopes", async () => {
    const root = mkdtempSync(join(tmpdir(), "query-wire-contract-"));
    try {
      const manager = new SessionManager(root);
      const session = manager.create(root, "fixture", "fixture", "query-session");
      session.transcript.appendMessage("user", "hello");
      const engine = { getSessionManager: () => manager };
      const list = await queryWire({ type: "sessions" }, engine);
      expect(list).toMatchObject(queryResult("sessions", [{ sessionId: "query-session" }]));
      const detail = manager.resume("query-session");
      expect(
        await queryWire({ type: "session_detail", sessionId: "query-session" }, engine),
      ).toEqual(
        queryResult("session_detail", {
          state: detail.state,
          transcript: detail.transcript.getEvents(),
        }),
      );
      expect(await queryWire({ type: "output_journal", sessionId: "missing" }, engine)).toEqual(
        queryResult("output_journal", {
          version: 1,
          status: "unavailable",
          frames: [],
          complete: false,
        }),
      );
      expect(
        await queryWire({ type: "session_detail", sessionId: "missing" }, engine),
      ).toMatchObject({ error: { code: ErrorCodes.SessionNotFound } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(["session_detail", "output_journal"])("%s requires sessionId", async (type) => {
    expect(await queryWire({ type })).toEqual(
      queryError(ErrorCodes.InvalidParams, `sessionId required for ${type}`),
    );
  });

  test("output_journal preserves reader bounds and the page wire shape", async () => {
    // This freezes the protocol boundary; storage identity and physical journal
    // recovery are exercised by session/output-journal.test.ts.
    const page: outputJournal.OutputJournalPage = {
      version: 1,
      status: "ok",
      through: "frozen-through",
      next: "next-page",
      frames: [
        { cursor: "frame-cursor", sequence: 1, event: { type: "text_delta", text: "hello" } },
      ],
      complete: false,
    };
    const read = spyOn(outputJournal, "readOutputJournal").mockReturnValue(page);
    try {
      expect(
        await queryWire(
          {
            type: "output_journal",
            sessionId: "owner",
            after: "after",
            through: "through",
            maxBytes: 4096,
            maxFrames: 7,
          },
          {
            getSessionManager: () => ({ getStorageDir: () => "/fixture-sessions" }),
          },
        ),
      ).toEqual(queryResult("output_journal", page));
      expect(read).toHaveBeenCalledWith("/fixture-sessions", "owner", {
        after: "after",
        through: "through",
        maxBytes: 4096,
        maxFrames: 7,
      });
    } finally {
      read.mockRestore();
    }
  });

  test("usage forwards every bound and maps reader failures to InvalidParams", async () => {
    const calls: unknown[] = [];
    const bounds = {
      scope: "session",
      sessionId: "owner",
      includeChildren: true,
      since: 10,
      until: 20,
      limit: 2,
      cursor: "page",
      runId: "run",
    };
    expect(
      await queryWire(
        { type: "usage", ...bounds },
        {
          sessionExistsOnDisk: () => true,
          getUsageSummary: (options: unknown) => {
            calls.push(options);
            return { scope: "session", requests: 3 };
          },
        },
      ),
    ).toEqual(queryResult("usage", { scope: "session", requests: 3 }));
    expect(calls).toEqual([bounds]);
    expect(
      await queryWire(
        { type: "usage", sessionId: "missing" },
        {
          sessionExistsOnDisk: () => false,
        },
      ),
    ).toEqual(queryError(ErrorCodes.SessionNotFound, "Session not found"));
    expect(await queryWire({ type: "usage", scope: "invalid" })).toEqual(
      queryError(
        ErrorCodes.InvalidParams,
        "Usage query requires an owned Session or trusted host aggregation",
      ),
    );
    expect(
      await queryWire(
        { type: "usage" },
        {
          getUsageSummary: () => {
            throw new Error("fixture invalid cursor");
          },
        },
      ),
    ).toEqual(queryError(ErrorCodes.InvalidParams, "fixture invalid cursor"));
  });

  test.each(["tools", "config", "models", "providers"])(
    "%s preserves thrown engine errors",
    async (type) => {
      const fail = () => {
        throw new Error("fixture unavailable");
      };
      expect(
        await queryWire(
          { type },
          {
            getToolRegistry: fail,
            getConfig: fail,
            getModelPool: fail,
            readSetting: fail,
          },
        ),
      ).toEqual(queryError(ErrorCodes.InternalError, "fixture unavailable"));
    },
  );

  test.each(["custom-query", "constructor", "toString", "__proto__"])(
    "%s reaches capability fallback and retains unknown-query errors",
    async (type) => {
      expect(await queryWire({ type })).toEqual(
        queryError(ErrorCodes.InvalidParams, `Unknown query type: ${type}`),
      );
      const calls: unknown[] = [];
      expect(
        await queryWire(
          { type, value: "input" },
          {
            queryCapability: async (name: string, params: unknown) => {
              calls.push([name, params]);
              return { handled: true, data: { extension: "reply" } };
            },
          },
        ),
      ).toEqual(queryResult(type, { extension: "reply" }));
      expect(calls).toEqual([[type, { type, value: "input" }]]);
    },
  );
});
