import { describe, expect, test } from "bun:test";
import {
  BUILTIN_TOOLS,
  Engine,
  buildPresetSystemPrompt,
  resolveAgentPreset,
} from "@cjhyy/code-shell-core";
import { CODING_CAPABILITY } from "./index.js";

const llm = { provider: "openai" as const, model: "test", apiKey: "test" };

describe("coding capability package", () => {
  test("owns coding implementations instead of leaving them in core", () => {
    const coreNames = BUILTIN_TOOLS.map((tool) => tool.definition.name);
    expect(coreNames).not.toContain("Brief");
    expect(coreNames).not.toContain("NotebookEdit");
    expect(coreNames).not.toContain("LSP");
  });

  test("installs its preset and tools into one Engine instance", () => {
    const engine = new Engine({
      llm,
      preset: "terminal-coding",
      capabilities: [CODING_CAPABILITY],
      settingsScope: "isolated",
    });
    expect(engine.getToolRegistry().hasTool("Brief")).toBe(true);
    expect(engine.getToolRegistry().hasTool("NotebookEdit")).toBe(true);
    expect(engine.getToolRegistry().hasTool("LSP")).toBe(true);
  });

  test("owns the product default while core remains harness-min", () => {
    expect(resolveAgentPreset(undefined, [CODING_CAPABILITY]).name).toBe("terminal-coding");
  });

  test("supplies the coding prompt from this package", () => {
    const preset = resolveAgentPreset("terminal-coding", [CODING_CAPABILITY]);
    const prompt = buildPresetSystemPrompt(preset, {
      promptSections: CODING_CAPABILITY.promptSections,
    });
    expect(prompt).toContain("# Coding assistant capability");
  });
});
