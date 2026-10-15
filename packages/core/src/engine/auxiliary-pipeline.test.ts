import { afterAll, describe, expect, it } from "bun:test";
import type { LLMConfig, LLMResponse } from "../types.js";
import { LLMClientBase } from "../llm/client-base.js";
import { PROVIDER_REGISTRY, registerProvider } from "../llm/client-factory.js";
import { ModelPool, type ModelEntry } from "../llm/model-pool.js";
import type { SettingsManager } from "../settings/manager.js";
import type { ToolRegistry } from "../tool-system/registry.js";
import type { ToolContext } from "../tool-system/context.js";
import type { EngineConfig } from "./types.js";
import { AuxiliaryPipeline, sameLlmIdentity } from "./auxiliary-pipeline.js";

const base: LLMConfig = {
  apiKey: "primary-key",
  model: "model-a",
  provider: "openai",
  baseUrl: "https://example.test/v1",
};

describe("sameLlmIdentity", () => {
  it("ignores credentials but compares request-shaping fields", () => {
    expect(sameLlmIdentity(base, { ...base, apiKey: "rotated-key" })).toBe(true);
    expect(sameLlmIdentity(base, { ...base, reasoning: { mode: "off" } })).toBe(false);
    expect(sameLlmIdentity(base, { ...base, maxTokens: 2048 })).toBe(false);
  });

  it.each([
    { supportsVision: false },
    { extraBody: { temperature: 0.9 } },
    { serviceTier: "priority" },
    { reasoningSummary: "detailed" },
  ])("distinguishes current capability and request metadata %j", (patch) => {
    const config = { ...base, supportsVision: true, extraBody: { temperature: 0.2 } };
    expect(sameLlmIdentity(config, { ...config, ...patch })).toBe(false);
  });
});

const fixtureProvider = "auxiliary-current-model-fixture";
class FixtureClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(): Promise<LLMResponse> {
    throw new Error("This fixture must never issue a model request");
  }

  get resolvedConfig(): LLMConfig {
    return this.config;
  }
}
registerProvider(fixtureProvider, FixtureClient);
afterAll(() => {
  PROVIDER_REGISTRY.delete(fixtureProvider);
});

function fixture() {
  const entry: ModelEntry = {
    key: "aux",
    provider: fixtureProvider,
    providerKind: "openrouter",
    model: "openai/gpt-6.1-sol",
    apiKey: "fixture-key",
    supportsVision: true,
    extraBody: { temperature: 0.2 },
    maxContextTokens: 12345,
  };
  const pool = new ModelPool([entry]);
  const config: EngineConfig = { llm: { provider: fixtureProvider, model: "primary" } };
  const fallback = new FixtureClient(config.llm);
  const pipeline = new AuxiliaryPipeline({
    config: () => config,
    settings: () =>
      ({
        invalidate: () => {},
        get: () => ({ defaults: { auxText: "aux" } }),
      }) as unknown as SettingsManager,
    modelPool: () => pool,
    toolRegistry: () => ({}) as ToolRegistry,
    toolContext: () => ({}) as ToolContext,
  });
  return { pipeline, pool, config, entry, fallback };
}

describe("AuxiliaryPipeline current model metadata", () => {
  it.each([{ supportsVision: false }, { extraBody: { temperature: 0.9 } }])(
    "does not reuse a primary client with different current metadata %j",
    async (patch) => {
      const { pipeline, pool, config, entry } = fixture();
      config.llm = pool.toLLMConfig(entry);
      const primary = new FixtureClient(config.llm);
      expect(await pipeline.resolveAuxClient(primary)).toBe(primary);
      pool.register({ ...entry, ...patch });
      const client = await pipeline.resolveAuxClient(primary);
      expect(client).not.toBe(primary);
      expect((client as FixtureClient).resolvedConfig).toMatchObject(patch);
    },
  );

  it.each([
    { supportsVision: false },
    { extraBody: { temperature: 0.9 } },
    { model: "vendor/another-model" },
    { apiKey: "rotated-fixture-key" },
  ])("rebuilds an auxiliary client when the same key is reconfigured %j", async (patch) => {
    const { pipeline, pool, entry, fallback } = fixture();
    const first = await pipeline.resolveAuxClient(fallback);
    expect(await pipeline.resolveAuxClient(fallback)).toBe(first);
    pool.register({ ...entry, ...patch });
    const current = await pipeline.resolveAuxClientWithMetadata(fallback);
    expect(current.client).not.toBe(first);
    expect((current.client as FixtureClient).resolvedConfig).toMatchObject(patch);
    expect(current.maxContextTokens).toBe(12345);
    expect(await pipeline.resolveAuxClient(fallback)).toBe(current.client);
  });

  it("uses the fallback after the selected auxiliary entry is removed", async () => {
    const { pipeline, pool, entry, fallback } = fixture();
    const first = await pipeline.resolveAuxClient(fallback);
    pool.clear();
    expect(await pipeline.resolveAuxClientWithMetadata(fallback, 45678)).toEqual({
      client: fallback,
      maxContextTokens: 45678,
    });
    pool.register(entry);
    expect(await pipeline.resolveAuxClient(fallback)).not.toBe(first);
  });

  it("rebuilds the cached client when runtime defaults or transport change", async () => {
    const { pipeline, config, fallback } = fixture();
    config.clientDefaults = { temperature: 0.2 };
    const first = await pipeline.resolveAuxClient(fallback);
    config.clientDefaults.temperature = 0.9;
    const updated = await pipeline.resolveAuxClient(fallback);
    expect(updated).not.toBe(first);
    expect(updated.temperature).toBe(0.9);
    config.clientDefaults.fetch = async () => {
      throw new Error("No network calls allowed");
    };
    expect(await pipeline.resolveAuxClient(fallback)).not.toBe(updated);
  });
});
