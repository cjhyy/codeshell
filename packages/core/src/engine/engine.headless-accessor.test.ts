import { describe, it, expect } from "bun:test";
import { Engine } from "./engine.js";

const baseLlm = { provider: "openai", model: "gpt-5", apiKey: "test-key" } as any;

describe("Engine.isHeadless", () => {
  it("returns true when constructed headless", () => {
    const engine = new Engine({ llm: baseLlm, headless: true });
    expect(engine.isHeadless()).toBe(true);
  });

  it("returns false when headless is unset", () => {
    const engine = new Engine({ llm: baseLlm });
    expect(engine.isHeadless()).toBe(false);
  });
});
