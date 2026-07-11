import { describe, expect, it } from "bun:test";
import type { ToolDefinition } from "../types.js";
import {
  PromptCacheDiagnosticRecorder,
  PROMPT_CACHE_STICKINESS_AUDIT,
  createPromptPrefixFingerprint,
  diffPromptPrefix,
  hashSystemPrompt,
  hashToolDefinitions,
  type PromptPrefixFingerprint,
} from "./prompt-cache-diagnostics.js";

const KEY = Buffer.alloc(32, 7);

function tool(name: string, inputSchema: Record<string, unknown> = {}): ToolDefinition {
  return { name, description: `${name} description`, inputSchema };
}

function fingerprint(overrides: Partial<PromptPrefixFingerprint> = {}): PromptPrefixFingerprint {
  return {
    version: 1,
    cacheScopeHash: "scope",
    systemHash: "system",
    toolsHash: "tools",
    configHash: "config",
    ...overrides,
  };
}

describe("prompt cache diagnostics", () => {
  it("hashes identical system prompts identically and detects one-character changes", () => {
    expect(hashSystemPrompt("system", KEY)).toBe(hashSystemPrompt("system", KEY));
    expect(hashSystemPrompt("system", KEY)).not.toBe(hashSystemPrompt("systeM", KEY));
  });

  it("canonicalizes tool object keys while preserving tool array order", () => {
    const left = [tool("A", { type: "object", properties: { b: { type: "string" }, a: 1 } })];
    const equivalent = [tool("A", { properties: { a: 1, b: { type: "string" } }, type: "object" })];
    expect(hashToolDefinitions(left, KEY)).toBe(hashToolDefinitions(equivalent, KEY));
    expect(hashToolDefinitions([tool("A"), tool("B")], KEY)).not.toBe(
      hashToolDefinitions([tool("B"), tool("A")], KEY),
    );
  });

  it("omits credentials from config identity and changes scope for model or endpoint", () => {
    const common = {
      provider: "openai",
      providerKind: "openai",
      model: "gpt-test",
      endpoint: "https://example.com/v1",
    };
    const first = createPromptPrefixFingerprint(
      "sys",
      [],
      { ...common, apiKey: "SECRET_A", httpHeaders: { Authorization: "Bearer A" } },
      common,
      KEY,
    );
    const second = createPromptPrefixFingerprint(
      "sys",
      [],
      { ...common, apiKey: "SECRET_B", httpHeaders: { Authorization: "Bearer B" } },
      common,
      KEY,
    );
    expect(first.configHash).toBe(second.configHash);

    const otherModel = createPromptPrefixFingerprint(
      "sys",
      [],
      common,
      { ...common, model: "gpt-other" },
      KEY,
    );
    const otherEndpoint = createPromptPrefixFingerprint(
      "sys",
      [],
      common,
      { ...common, endpoint: "https://other.example/v1" },
      KEY,
    );
    expect(otherModel.cacheScopeHash).not.toBe(first.cacheScopeHash);
    expect(otherEndpoint.cacheScopeHash).not.toBe(first.cacheScopeHash);
    expect(JSON.stringify(first)).not.toContain("SECRET");
    expect(JSON.stringify(first)).not.toContain("example.com");
  });

  it("attributes system, tools, config, multiple, and untracked changes", () => {
    const base = fingerprint();
    expect(diffPromptPrefix(base, fingerprint({ systemHash: "system-2" }))).toEqual({
      changedPrefixes: ["system"],
      cause: "system_changed",
    });
    expect(diffPromptPrefix(base, fingerprint({ toolsHash: "tools-2" })).cause).toBe(
      "tools_changed",
    );
    expect(diffPromptPrefix(base, fingerprint({ configHash: "config-2" })).cause).toBe(
      "config_changed",
    );
    expect(
      diffPromptPrefix(base, fingerprint({ systemHash: "system-2", toolsHash: "tools-2" })),
    ).toEqual({
      changedPrefixes: ["system", "tools"],
      cause: "multiple_prefixes_changed",
    });
    expect(diffPromptPrefix(base, fingerprint()).cause).toBe("no_tracked_prefix_change");
  });

  it("ignores missing cache reads without replacing the baseline", () => {
    const recorder = new PromptCacheDiagnosticRecorder({ maxSessions: 256 });
    recorder.record("sid", {
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheReadTokens: 1200 },
      fingerprint: fingerprint(),
      requestKind: "primary",
    });
    expect(
      recorder.record("sid", {
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        fingerprint: fingerprint({ systemHash: "changed" }),
        requestKind: "primary",
      }).kind,
    ).toBe("ignored");
    expect(recorder.get("sid")?.cacheReadTokens).toBe(1200);
  });

  it("attributes a same-scope drop and resets silently on scope or version changes", () => {
    const recorder = new PromptCacheDiagnosticRecorder();
    recorder.record("sid", {
      usage: { promptTokens: 1200, completionTokens: 1, totalTokens: 1201, cacheReadTokens: 1200 },
      fingerprint: fingerprint(),
      requestKind: "primary",
    });
    const drop = recorder.record("sid", {
      usage: { promptTokens: 1200, completionTokens: 1, totalTokens: 1201, cacheReadTokens: 0 },
      fingerprint: fingerprint({ toolsHash: "tools-2" }),
      requestKind: "primary",
    });
    expect(drop).toMatchObject({
      kind: "drop",
      attribution: { cause: "tools_changed", changedPrefixes: ["tools"] },
    });

    expect(
      recorder.record("sid", {
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheReadTokens: 0 },
        fingerprint: fingerprint({ cacheScopeHash: "new-scope" }),
        requestKind: "primary",
      }).kind,
    ).toBe("scope_changed");
    expect(
      recorder.record("sid", {
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheReadTokens: 0 },
        fingerprint: { ...fingerprint({ cacheScopeHash: "new-scope" }), version: 2 as 1 },
        requestKind: "primary",
      }).kind,
    ).toBe("schema_changed");
  });

  it("evicts the least-recently-used session beyond the bound", () => {
    const recorder = new PromptCacheDiagnosticRecorder({ maxSessions: 256 });
    for (let index = 0; index < 260; index++) {
      recorder.record(`s-${index}`, {
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheReadTokens: index },
        fingerprint: fingerprint(),
        requestKind: "primary",
      });
    }
    expect(recorder.size).toBe(256);
    expect(recorder.has("s-0")).toBe(false);
    expect(recorder.has("s-259")).toBe(true);
  });

  it("audits semantic and security switches as hot while reserving locks for cache-only policy", () => {
    for (const key of [
      "planMode",
      "permissionMode",
      "goalState",
      "mcpServerSet",
      "toolAvailability",
    ]) {
      expect(PROMPT_CACHE_STICKINESS_AUDIT[key]?.policy).toBe("hot");
    }
    expect(PROMPT_CACHE_STICKINESS_AUDIT.providerCacheStrategy.policy).toBe("client_sticky");
    expect(PROMPT_CACHE_STICKINESS_AUDIT.futureCacheOnlyPolicy.policy).toBe(
      "session_lock_if_introduced",
    );
  });
});
