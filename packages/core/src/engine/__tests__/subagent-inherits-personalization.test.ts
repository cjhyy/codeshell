import { describe, it, expect } from "bun:test";
import { Engine } from "../engine.js";

describe("subagent inherits personalization", () => {
  it("parent EngineConfig carries personalization fields into getConfig", () => {
    const engine = new Engine({
      llm: { provider: "openai", model: "m", apiKey: "", baseUrl: "" },
      cwd: process.cwd(),
      responseLanguage: "简体中文",
      userProfile: "maki",
      instructions: { compatClaude: false, compatCodex: true },
    } as any);
    const cfg = engine.getConfig();
    expect(cfg.responseLanguage).toBe("简体中文");
    expect(cfg.userProfile).toBe("maki");
    expect(cfg.instructions?.compatClaude).toBe(false);
  });
});
