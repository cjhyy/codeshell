import { describe, expect, test } from "bun:test";
import {
  createLegacyQuotaQuery,
  UsageProviderService,
  type CliUsageProviderAdapter,
} from "./usage-provider-service.js";

function fixture() {
  const installed = new Set(["codex", "claude"]);
  const queries: string[] = [];
  const probes: string[] = [];
  let connections = [
    { catalogId: "openai", apiKey: "never-expose", baseUrl: "https://private.example" },
    { catalogId: "openai", apiKey: "never-expose", baseUrl: "https://private.example" },
    { catalogId: "local-custom", apiKey: "never-expose", baseUrl: "https://private.example" },
  ];
  const adapter = (id: string, binary: string, provider: string): CliUsageProviderAdapter => ({
    id,
    binary,
    displayName: provider,
    quota: {
      supported: true,
      provider,
      queryCost: provider === "claude" ? "minimal-usage" : "none",
      query: async () => {
        queries.push(provider);
        return { provider, windows: [{ kind: "weekly", usedPercent: 20, resetsAt: null }] };
      },
    },
  });
  const service = new UsageProviderService({
    adapters: [
      adapter("cli:codex", "codex", "codex"),
      adapter("cli:claude-code", "claude", "claude"),
      adapter("cli:future", "future", "future"),
      { id: "cli:local", displayName: "Local", binary: "local", quota: { supported: false } },
    ],
    findExecutable: (binary) => {
      probes.push(binary);
      return installed.has(binary) ? `/private/bin/${binary}` : null;
    },
    modelConnections: () => connections,
    catalog: () => [{ id: "openai", displayName: "OpenAI" }],
  });
  return {
    service,
    installed,
    queries,
    probes,
    clearConnections: () => {
      connections = [];
    },
  };
}

describe("local usage provider discovery", () => {
  test("returns installed adapters and grouped user connections without secrets or requests", () => {
    const f = fixture();
    expect(f.service.listProviders()).toEqual([
      {
        id: "cli:codex",
        displayName: "codex",
        source: "cli",
        quota: { supported: true, queryCost: "none" },
      },
      {
        id: "cli:claude-code",
        displayName: "claude",
        source: "cli",
        quota: { supported: true, queryCost: "minimal-usage" },
      },
      {
        id: "model:openai",
        displayName: "OpenAI",
        source: "model-connection",
        connectionCount: 2,
        quota: { supported: false },
      },
      {
        id: "model:local-custom",
        displayName: "local-custom",
        source: "model-connection",
        connectionCount: 1,
        quota: { supported: false },
      },
    ]);
    expect(f.queries).toEqual([]);
    expect(f.probes).toEqual(["codex", "claude", "future", "local"]);
  });

  test("new adapters and changed local configuration appear without a cached provider list", async () => {
    const f = fixture();
    f.installed.clear();
    f.installed.add("future");
    f.clearConnections();
    expect(f.service.listProviders()).toEqual([
      {
        id: "cli:future",
        displayName: "future",
        source: "cli",
        quota: { supported: true, queryCost: "none" },
      },
    ]);
    expect(await f.service.query("cli:future")).toMatchObject({ provider: "future" });
    expect(f.queries).toEqual(["future"]);
    f.installed.clear();
    expect(f.service.listProviders()).toEqual([]);
  });

  test("selects only the requested adapter and preserves its quota provider semantics", async () => {
    const f = fixture();
    expect(await f.service.query("cli:claude-code")).toEqual({
      provider: "claude",
      windows: [{ kind: "weekly", usedPercent: 20, resetsAt: null }],
    });
    expect(f.queries).toEqual(["claude"]);
    expect(f.probes).toEqual(["claude"]);
  });

  test("rejects malformed, unknown, and unsupported ids before any credential callback", async () => {
    const f = fixture();
    for (const id of [
      undefined,
      null,
      "",
      1,
      {},
      ["cli:codex"],
      "both",
      "codex",
      "cli:unknown",
      "model:openai",
    ]) {
      await expect(f.service.query(id)).rejects.toThrow();
    }
    await expect(f.service.query("cli:local")).rejects.toThrow("does not support");
    expect(f.probes).toEqual([]);
    expect(f.queries).toEqual([]);
  });

  test("rechecks executable availability before querying a previously discovered CLI", async () => {
    const f = fixture();
    f.service.listProviders();
    f.installed.delete("codex");
    expect(await f.service.query("cli:codex")).toMatchObject({
      provider: "codex",
      errorCode: "unavailable",
    });
    expect(f.queries).toEqual([]);
  });

  test("a present adapter without quota capability is discoverable without a query", () => {
    const f = fixture();
    f.installed.clear();
    f.installed.add("local");
    f.clearConnections();
    expect(f.service.listProviders()).toEqual([
      { id: "cli:local", displayName: "Local", source: "cli", quota: { supported: false } },
    ]);
  });

  test("sanitizes unexpected adapter exceptions", async () => {
    const service = new UsageProviderService({
      adapters: [
        {
          id: "cli:fixture",
          displayName: "Fixture",
          binary: "fixture",
          quota: {
            supported: true,
            provider: "fixture",
            queryCost: "none",
            query: async () => {
              throw new Error("token=private-secret at /private/auth");
            },
          },
        },
      ],
      findExecutable: () => "/private/bin/fixture",
      modelConnections: () => [],
      catalog: () => [],
    });
    expect(await service.query("cli:fixture")).toEqual({
      provider: "fixture",
      errorCode: "request-failed",
      error: "Quota query failed",
    });
  });
});

test("legacy query validates arguments and forwards only the selected credential scope", async () => {
  const selected: string[][] = [];
  const query = createLegacyQuotaQuery(async (providers) => {
    selected.push(providers);
    return {};
  });
  for (const invalid of ["unknown", "cli:codex", "", null, 1, {}, ["codex"]]) {
    await expect(query(invalid)).rejects.toThrow("Invalid quota provider");
  }
  expect(selected).toEqual([]);
  await query("codex");
  await query("claude");
  await query("both");
  await query(undefined);
  expect(selected).toEqual([["codex"], ["claude"], ["claude", "codex"], ["claude", "codex"]]);
});
