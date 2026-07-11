import { describe, expect, it } from "bun:test";
import type { ClientDefaults, LLMConfig, LLMResponse } from "../types.js";
import type { CreateMessageOptions } from "./types.js";
import { LLMClientBase } from "./client-base.js";
import { ModelFacade } from "../engine/model-facade.js";

class IdentityClient extends LLMClientBase {
  constructor(config: LLMConfig, defaults?: ClientDefaults) {
    super(config, defaults);
  }
  protected initClient(): void {}
  async createMessage(_options: CreateMessageOptions): Promise<LLMResponse> {
    return { text: "", toolCalls: [] };
  }
}

describe("LLMClientBase prompt-cache identity", () => {
  it("lets ModelFacade fingerprint the effective system, tools, config, and scope", () => {
    const client = new IdentityClient({
      provider: "openai",
      model: "model-a",
      apiKey: "MUST_NOT_APPEAR",
      baseUrl: "https://example.com/v1",
    });
    const facade = new ModelFacade(client, {} as never);
    const first = facade.getPromptPrefixFingerprint("system-a", [
      { name: "Read", description: "read", inputSchema: { type: "object" } },
    ]);
    const second = facade.getPromptPrefixFingerprint("system-b", [
      { name: "Read", description: "read", inputSchema: { type: "object" } },
    ]);

    expect(first.version).toBe(1);
    expect(first.systemHash).not.toBe(second.systemHash);
    expect(first.toolsHash).toBe(second.toolsHash);
    expect(first.configHash).toBe(second.configHash);
    expect(first.cacheScopeHash).toBe(second.cacheScopeHash);
    expect(JSON.stringify(first)).not.toContain("MUST_NOT_APPEAR");
  });

  it("returns only request-shape config and excludes credentials", () => {
    const client = new IdentityClient(
      {
        provider: "openai",
        providerKind: "openrouter",
        model: "model-a",
        apiKey: "API_KEY_SECRET",
        authCommand: "print-secret",
        httpHeaders: { Authorization: "HEADER_SECRET" },
        baseUrl: "https://user:pass@example.com/v1?token=QUERY_SECRET#fragment",
        maxTokens: 2048,
        reasoning: { mode: "effort", effort: "high" },
        reasoningSummary: "concise",
        serviceTier: "flex",
        extraBody: {
          temperature: 0.2,
          top_p: 0.9,
          thinking: { type: "enabled" },
          api_key: "EXTRA_SECRET",
          arbitrary: "not-request-shape-allowlisted",
        },
      },
      { temperature: 0.3, timeout: 123, retryMaxAttempts: 9, imageDetail: "high" },
    );

    const identity = client.getPromptCacheConfigIdentity();
    expect(identity).toMatchObject({
      provider: "openai",
      providerKind: "openrouter",
      model: "model-a",
      maxTokens: 2048,
      reasoning: { mode: "effort", effort: "high" },
      reasoningSummary: "concise",
      serviceTier: "flex",
      temperature: 0.3,
      imageDetail: "high",
      extraBody: { temperature: 0.2, top_p: 0.9, thinking: { type: "enabled" } },
    });
    const serialized = JSON.stringify(identity);
    for (const secret of ["API_KEY_SECRET", "print-secret", "HEADER_SECRET", "EXTRA_SECRET"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("timeout");
    expect(serialized).not.toContain("retryMaxAttempts");
    expect(serialized).not.toContain("arbitrary");
  });

  it("normalizes endpoint scope without userinfo, query, or fragment", () => {
    const client = new IdentityClient({
      provider: "openai",
      providerKind: "openrouter",
      model: "model-a",
      baseUrl: "HTTPS://user:pass@Example.COM:443/v1/?token=secret#fragment",
    });

    expect(client.getPromptCacheScopeIdentity()).toEqual({
      provider: "openai",
      providerKind: "openrouter",
      model: "model-a",
      endpoint: "https://example.com/v1",
    });
  });
});
