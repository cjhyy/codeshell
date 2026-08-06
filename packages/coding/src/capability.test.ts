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

  test("installs its preset tools without the compatibility-only Brief formatter", () => {
    const engine = new Engine({
      llm,
      preset: "terminal-coding",
      capabilities: [CODING_CAPABILITY],
      settingsScope: "isolated",
    });
    // Brief only formats Markdown into a tool result. Exposing it to the model
    // hides user-facing output inside a folded tool card and breaks headless
    // consumers that take the final assistant text as the run result.
    expect(engine.getToolRegistry().hasTool("Brief")).toBe(false);
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
