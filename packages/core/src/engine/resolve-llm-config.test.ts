import { describe, it, expect } from "bun:test";
import { resolveLLMConfigForTag } from "./resolve-llm-config.js";

// 最小可解析 settings:一个 text 连接 + 凭证 + defaults.text。
// catalogId 用 builtin 的 "deepseek"(确定存在于 getMergedCatalog)。
function settingsWith(overrides: Record<string, unknown> = {}) {
  return {
    credentials: [
      { id: "ds-key", catalogId: "deepseek", apiKey: "sk-test", baseUrl: "https://api.deepseek.com/v1" },
    ],
    modelConnections: [
      { id: "ds", catalogId: "deepseek", tag: "text", model: "deepseek-v4-flash", credentialId: "ds-key" },
    ],
    defaults: { text: "ds" },
    ...overrides,
  } as never;
}

describe("resolveLLMConfigForTag", () => {
  it("resolves defaults.text into a runnable LLMConfig", () => {
    const cfg = resolveLLMConfigForTag(settingsWith(), "text");
    expect(cfg).not.toBeNull();
    expect(cfg!.apiKey).toBe("sk-test");
    expect(cfg!.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(cfg!.model).toBe("deepseek-v4-flash");
    expect(cfg!.provider).toBe("openai"); // deepseek protocol → openai client
  });

  it("preferredId wins over defaults.text", () => {
    const s = settingsWith({
      credentials: [
        { id: "ds-key", catalogId: "deepseek", apiKey: "sk-a", baseUrl: "https://api.deepseek.com/v1" },
        { id: "or-key", catalogId: "openrouter", apiKey: "sk-b", baseUrl: "https://openrouter.ai/api/v1" },
      ],
      modelConnections: [
        { id: "ds", catalogId: "deepseek", tag: "text", model: "deepseek-v4-flash", credentialId: "ds-key" },
        { id: "or", catalogId: "openrouter", tag: "text", model: "x/y", credentialId: "or-key" },
      ],
      defaults: { text: "ds" },
    });
    const cfg = resolveLLMConfigForTag(s, "text", "or");
    expect(cfg!.apiKey).toBe("sk-b");
  });

  it("falls back to first usable text connection when defaults.text unset", () => {
    const s = settingsWith({ defaults: {} });
    const cfg = resolveLLMConfigForTag(s, "text");
    expect(cfg!.apiKey).toBe("sk-test");
  });

  it("returns null when no text connection exists", () => {
    const s = settingsWith({ modelConnections: [], defaults: {} });
    expect(resolveLLMConfigForTag(s, "text")).toBeNull();
  });

  it("preferredId that does not resolve falls back to defaults.text", () => {
    const cfg = resolveLLMConfigForTag(settingsWith(), "text", "nonexistent");
    expect(cfg!.model).toBe("deepseek-v4-flash");
  });
});
