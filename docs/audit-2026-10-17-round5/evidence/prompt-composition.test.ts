import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BUILTIN_AGENT_PRESETS, buildPresetSystemPrompt } from "../../../packages/core/src/preset/index.js";
import { loadSection, loadSections } from "../../../packages/core/src/prompt/section-loader.js";
import { SectionCache } from "../../../packages/core/src/prompt/section-cache.js";
import { PromptComposer } from "../../../packages/core/src/prompt/composer.js";

// Ordinary strings/metadata, no actual tool calls or external providers.
test("actual built-in presets compose their declared sections in order", () => {
  for (const preset of Object.values(BUILTIN_AGENT_PRESETS)) {
    expect(buildPresetSystemPrompt(preset, { platform: "linux" })).toBe(loadSections(preset.promptSections));
  }
  expect(loadSection("tone", { tone: "  CONTRIBUTED_TONE  " })).toBe("CONTRIBUTED_TONE");
  expect(loadSections(["tone", "tone"], { tone: "T" })).toBe("T\n\nT");
  expect(() => loadSection("audit_missing_section")).toThrow("Unknown prompt section");
});

test("actual general preset browser gating is stable across reused composer calls", async () => {
  const composer = new PromptComposer({ cwd: "/offline-audit", model: "offline-audit", preset: BUILTIN_AGENT_PRESETS.general });
  const browser = { name: "browser_navigate", description: "offline metadata", inputSchema: {} };
  const on = await composer.buildSystemPrompt([browser]);
  const off = await composer.buildSystemPrompt([]);
  const onAgain = await composer.buildSystemPrompt([browser]);
  expect(on).toContain("## Browser automation");
  expect(off).not.toContain("## Browser automation");
  expect(off).not.toContain("# Available Tools");
  expect(onAgain).toBe(on);
});

test("section cache follows its explicit name, cacheBreak, and invalidate contract", async () => {
  const cache = new SectionCache();
  let count = 0;
  const section = { name: "audit", compute: () => String(++count) };
  expect(await cache.resolve([section])).toEqual(["1"]);
  expect(await cache.resolve([section])).toEqual(["1"]);
  expect(await cache.resolve([{ ...section, cacheBreak: true }])).toEqual(["2"]);
  cache.invalidate("audit");
  expect(await cache.resolve([section])).toEqual(["3"]);
  expect(await cache.resolve([{ name: "empty", compute: () => "" }])).toEqual([]);
  expect(cache.has("empty")).toBe(true);
  cache.invalidate();
  expect(cache.has("audit")).toBe(false);
});

test("actual coding preset declaration references an available package-owned section", () => {
  // Source-only declaration inspection avoids importing coding's CLI/tool adapters.
  const code = readFileSync(new URL("../../../packages/coding/src/index.capability.ts", import.meta.url), "utf8");
  const coding = readFileSync(new URL("../../../packages/coding/src/prompt/coding.md", import.meta.url), "utf8");
  expect(code).toContain('promptSections: ["base", "orchestration", "coding", "browser", "tone"]');
  expect(code).toContain("promptSections: CODING_PROMPT_SECTIONS");
  expect(loadSections(["base", "orchestration", "coding", "browser", "tone"], { coding })).toContain(coding.trim());
});
