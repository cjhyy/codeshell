import { describe, expect, test } from "bun:test";
import {
  BUILTIN_TOOLS,
  Engine,
  buildPresetSystemPrompt,
  compileComposition,
  resolvePresetFromComposition,
} from "@cjhyy/code-shell-core";
import { createCodingModule } from "./index.js";

const llm = { provider: "openai" as const, model: "test", apiKey: "test" };
const composition = compileComposition({ modules: [createCodingModule()] });

describe("coding module package", () => {
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
      composition,
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
    expect(composition.engine.defaultPreset).toBe("terminal-coding");
    expect(compileComposition({}).engine.defaultPreset).toBe("harness-min");
  });

  test("supplies the coding prompt from this package", () => {
    const preset = resolvePresetFromComposition(composition, "terminal-coding");
    const prompt = buildPresetSystemPrompt(preset, {
      promptSections: Object.fromEntries(
        composition.engine.promptSections.map((s) => [s.key, s.value]),
      ),
    });
    expect(prompt).toContain("# Coding assistant capability");
  });
});
