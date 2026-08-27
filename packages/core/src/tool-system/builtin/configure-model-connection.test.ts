import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "../../settings/manager.js";
import { getMergedCatalog } from "../../model-catalog/index.js";
import type { CatalogEntry } from "../../model-catalog/types.js";
import type { Credential, ModelInstance } from "../../model-catalog/resolve.js";
import { OpenAIClient } from "../../llm/providers/openai.js";
import type { ToolContext } from "../context.js";
import {
  configureModelConnectionTool,
  probeTextModelConnection,
} from "./configure-model-connection.js";

test("text connection probe sends a small request through the real provider client", async () => {
  const requests: Array<{ path: string; authorization: string | null; body: any }> = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      path: new URL(request.url).pathname,
      authorization: request.headers.get("authorization"),
      body: await request.json(),
    });
    return Response.json({
      id: "probe-response",
      choices: [{ message: { role: "assistant", content: "READY" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    });
  };

  const catalog: CatalogEntry[] = [
    {
      id: "probe-provider",
      tag: "text",
      adapterKind: "openai",
      protocol: "openai-compat",
      displayName: "Probe provider",
      description: "Local test provider",
      defaultBaseUrl: "https://probe.invalid/v1",
      needsKey: true,
      modelPresets: [{ value: "probe-model" }],
    },
  ];
  const credentials: Credential[] = [
    { id: "probe-key", catalogId: "probe-provider", apiKey: "probe-secret" },
  ];
  const connection: ModelInstance = {
    id: "probe-connection",
    catalogId: "probe-provider",
    tag: "text",
    model: "probe-model",
    credentialId: "probe-key",
  };

  const result = await probeTextModelConnection(connection, credentials, catalog, {
    fetch: fetchImpl,
    createClient: async (config, defaults) =>
      new OpenAIClient(config, defaults, { dangerouslyAllowBrowser: true }),
  });
  expect(result).toEqual({
    ok: true,
    response: "READY",
    stopReason: "stop",
    usage: { promptTokens: 4, completionTokens: 1, totalTokens: 5 },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    path: "/v1/chat/completions",
    authorization: "Bearer probe-secret",
    body: {
      model: "probe-model",
      max_tokens: 32,
      messages: [
        {
          role: "system",
          content: "You are a connection health check. Follow the user's reply instruction.",
        },
        { role: "user", content: "Reply with READY only." },
      ],
    },
  });
});

describe("ConfigureModelConnection tool", () => {
  let home: string;
  let cwd: string;
  let previousHome: string | undefined;
  let notifications: string[];
  let testedConnections: string[];

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-configure-model-home-"));
    cwd = join(home, "workspace");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    notifications = [];
    testedConnections = [];
  });

  afterEach(() => {
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function userSettingsPath(): string {
    return join(home, ".code-shell", "settings.json");
  }

  function projectSettingsPath(): string {
    return join(cwd, ".code-shell", "settings.json");
  }

  function writeUserSettings(settings: Record<string, unknown>): void {
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    writeFileSync(userSettingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
  }

  function readSettings(path = userSettingsPath()): Record<string, any> {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
  }

  function context(settingsScope: "full" | "project" | "isolated" = "full"): ToolContext {
    return { cwd, settingsScope } as ToolContext;
  }

  function deps() {
    return {
      makeSettingsManager: (managerCwd: string, scope: "full" | "project") =>
        new SettingsManager(managerCwd, scope),
      getCatalog: getMergedCatalog,
      notifySettingsChanged: () => notifications.push("changed"),
      testTextConnection: async (connection: { id: string }) => {
        testedConnections.push(connection.id);
        return { ok: true, response: "READY", stopReason: "stop" };
      },
    };
  }

  test("adds a catalog model, reuses one compatible credential, seeds params, and sets default", async () => {
    writeUserSettings({
      credentials: [
        { id: "openrouter-key", catalogId: "openrouter", apiKey: "sk-or-secret" },
        { id: "deepseek-key", catalogId: "deepseek", apiKey: "sk-deepseek-secret" },
      ],
      modelConnections: [
        {
          id: "deepseek",
          catalogId: "deepseek",
          tag: "text",
          model: "deepseek-v4-flash",
          credentialId: "deepseek-key",
        },
      ],
      defaults: { text: "deepseek" },
    });

    const out = await configureModelConnectionTool(
      {
        catalogId: "openrouter",
        model: "openai/gpt-5.5",
        setDefault: true,
      },
      context(),
      deps(),
    );

    const result = JSON.parse(out);
    expect(result).toMatchObject({
      ok: true,
      action: "added",
      scope: "user",
      connection: {
        id: "openrouter",
        catalogId: "openrouter",
        tag: "text",
        model: "openai/gpt-5.5",
        credentialId: "openrouter-key",
        paramValues: { reasoning: "medium" },
      },
      defaultForTag: "text",
      hotReloadRequested: true,
    });
    expect(out).not.toContain("sk-or-secret");

    const saved = readSettings();
    expect(saved.modelConnections).toHaveLength(2);
    expect(saved.modelConnections[0].id).toBe("deepseek");
    expect(saved.defaults.text).toBe("openrouter");
    expect(saved.credentials[0].apiKey).toBe("sk-or-secret");
    expect(notifications).toEqual(["changed"]);
    expect(testedConnections).toEqual([]);
  });

  test("can make one real-request-shaped verification after the atomic save", async () => {
    writeUserSettings({
      credentials: [{ id: "openrouter-key", catalogId: "openrouter", apiKey: "secret" }],
      modelConnections: [],
      defaults: {},
    });

    const out = await configureModelConnectionTool(
      {
        catalogId: "openrouter",
        model: "openai/gpt-5.5",
        testConnection: true,
      },
      context(),
      deps(),
    );

    expect(JSON.parse(out)).toMatchObject({
      ok: true,
      connection: { id: "openrouter" },
      verification: { ok: true, response: "READY", stopReason: "stop" },
    });
    expect(readSettings().modelConnections).toHaveLength(1);
    expect(notifications).toEqual(["changed"]);
    expect(testedConnections).toEqual(["openrouter"]);
  });

  test("keeps a validated connection when verification fails and redacts credential text", async () => {
    writeUserSettings({
      credentials: [{ id: "openrouter-key", catalogId: "openrouter", apiKey: "secret-never-echo" }],
      modelConnections: [],
    });
    const failingDeps = {
      ...deps(),
      testTextConnection: async () => {
        throw new Error("upstream rejected secret-never-echo");
      },
    };

    const out = await configureModelConnectionTool(
      {
        catalogId: "openrouter",
        model: "openai/gpt-5.5",
        testConnection: true,
      },
      context(),
      failingDeps,
    );

    expect(JSON.parse(out)).toMatchObject({
      ok: true,
      verification: {
        ok: false,
        error: "could not start connection test: upstream rejected [REDACTED]",
      },
    });
    expect(out).not.toContain("secret-never-echo");
    expect(readSettings().modelConnections).toHaveLength(1);
    expect(notifications).toEqual(["changed"]);
  });

  test("repeated calls update the same catalog model instead of duplicating it", async () => {
    writeUserSettings({
      credentials: [{ id: "openrouter-key", catalogId: "openrouter", apiKey: "secret" }],
      modelConnections: [],
      defaults: {},
    });

    await configureModelConnectionTool(
      { catalogId: "openrouter", model: "openai/gpt-5.5" },
      context(),
      deps(),
    );
    const second = await configureModelConnectionTool(
      {
        catalogId: "openrouter",
        model: "openai/gpt-5.5",
        paramValues: { reasoning: "low" },
      },
      context(),
      deps(),
    );

    expect(JSON.parse(second)).toMatchObject({ action: "updated" });
    const saved = readSettings();
    expect(saved.modelConnections).toHaveLength(1);
    expect(saved.modelConnections[0].paramValues).toEqual({ reasoning: "low" });
    expect(notifications).toEqual(["changed", "changed"]);
  });

  test("requires an explicit credential when several compatible accounts exist", async () => {
    writeUserSettings({
      credentials: [
        { id: "openrouter-a", catalogId: "openrouter", apiKey: "secret-a" },
        { id: "openrouter-b", catalogId: "openrouter", apiKey: "secret-b" },
      ],
      modelConnections: [],
    });

    const out = await configureModelConnectionTool(
      { catalogId: "openrouter", model: "openai/gpt-5.5" },
      context(),
      deps(),
    );

    expect(out).toContain("multiple compatible credentials");
    expect(out).toContain("openrouter-a, openrouter-b");
    expect(readSettings().modelConnections).toEqual([]);
    expect(notifications).toEqual([]);
  });

  test("rejects a credential from another provider without writing", async () => {
    writeUserSettings({
      credentials: [{ id: "openai-key", catalogId: "openai", apiKey: "secret" }],
      modelConnections: [],
    });

    const out = await configureModelConnectionTool(
      {
        catalogId: "openrouter",
        model: "openai/gpt-5.5",
        credentialId: "openai-key",
      },
      context(),
      deps(),
    );

    expect(out).toContain("not compatible");
    expect(readSettings().modelConnections).toEqual([]);
    expect(notifications).toEqual([]);
  });

  test("rejects unknown or invalid parameter values atomically", async () => {
    writeUserSettings({
      credentials: [{ id: "openrouter-key", catalogId: "openrouter", apiKey: "secret" }],
      modelConnections: [],
    });

    const unknown = await configureModelConnectionTool(
      {
        catalogId: "openrouter",
        model: "openai/gpt-5.5",
        paramValues: { made_up: true },
      },
      context(),
      deps(),
    );
    const invalidEnum = await configureModelConnectionTool(
      {
        catalogId: "openrouter",
        model: "openai/gpt-5.5",
        paramValues: { reasoning: "ultra" },
      },
      context(),
      deps(),
    );

    expect(unknown).toContain('unknown parameter "made_up"');
    expect(invalidEnum).toContain("must be one of");
    expect(readSettings().modelConnections).toEqual([]);
    expect(notifications).toEqual([]);
  });

  test("fails closed when a project-scoped engine attempts a user settings write", async () => {
    writeUserSettings({
      credentials: [{ id: "openrouter-key", catalogId: "openrouter", apiKey: "secret" }],
      modelConnections: [],
    });

    const out = await configureModelConnectionTool(
      {
        catalogId: "openrouter",
        model: "openai/gpt-5.5",
        scope: "user",
      },
      context("project"),
      deps(),
    );

    expect(out).toContain("settingsScope=full");
    expect(readSettings().modelConnections).toEqual([]);
    expect(notifications).toEqual([]);
  });

  test("can write a project connection that references an effective user credential", async () => {
    writeUserSettings({
      credentials: [{ id: "openrouter-key", catalogId: "openrouter", apiKey: "secret" }],
      modelConnections: [],
      defaults: {},
    });

    const out = await configureModelConnectionTool(
      {
        catalogId: "openrouter",
        model: "openai/gpt-5.5",
        scope: "project",
      },
      context(),
      deps(),
    );

    expect(JSON.parse(out)).toMatchObject({ ok: true, scope: "project" });
    const project = readSettings(projectSettingsPath());
    expect(project.modelConnections[0]).toMatchObject({
      catalogId: "openrouter",
      credentialId: "openrouter-key",
    });
    expect(readSettings().modelConnections).toEqual([]);
    expect(notifications).toEqual(["changed"]);
  });
});
