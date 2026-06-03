import { describe, it, expect } from "bun:test";
import { Engine } from "../engine.js";
import { PromptComposer } from "../../prompt/composer.js";
import { buildPresetSystemPrompt } from "../../preset/index.js";

/**
 * #2: refreshRuntimeConfig with a changed `preset` must re-resolve the engine's
 * preset so the NEXT-turn PromptComposer reflects the new preset's system
 * prompt / behavior. Before the fix, refreshRuntimeConfig merged config.preset
 * but the per-turn composer read `this.preset` (resolved ONCE in the ctor), so
 * a hot-reloaded preset was a silent no-op for the system prompt.
 */
function buildEngine(preset: string): Engine {
  return new Engine({
    llm: { provider: "openai", model: "model-a", apiKey: "x", baseUrl: "http://localhost" },
    cwd: process.cwd(),
    preset,
  } as any);
}

/** Build a PromptComposer the way Engine.run() does — from the engine's
 * resolved preset — and return its behavioral-section prompt. */
async function presetSystemPrompt(engine: Engine): Promise<string> {
  const preset = (engine as any).preset;
  const composer = new PromptComposer({ cwd: process.cwd(), model: "model-a", preset });
  // buildSystemPrompt assembles many sections; for a deterministic preset check
  // we compare the preset's own behavioral sections, which is exactly what the
  // composer injects from `preset`.
  return buildPresetSystemPrompt(preset);
}

describe("Engine.refreshRuntimeConfig preset hot-reload (#2)", () => {
  it("re-resolves the preset so the next-turn system prompt reflects the new preset", async () => {
    const engine = buildEngine("general");
    const before = await presetSystemPrompt(engine);
    expect((engine as any).preset.name).toBe("general");

    // Hot-reload to a different real preset.
    engine.refreshRuntimeConfig({ preset: "terminal-coding" }, 1);

    expect((engine as any).preset.name).toBe("terminal-coding");
    const after = await presetSystemPrompt(engine);
    expect(after).not.toBe(before);
    // terminal-coding adds a coding section the general preset lacks.
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("leaves the resolved preset unchanged when the patch preset matches the current one", () => {
    const engine = buildEngine("general");
    const presetBefore = (engine as any).preset;
    engine.refreshRuntimeConfig({ preset: "general" }, 1);
    // Same name → no re-resolve; identity preserved.
    expect((engine as any).preset).toBe(presetBefore);
  });

  it("drops a stale (<= last applied) version without re-resolving", () => {
    const engine = buildEngine("general");
    engine.refreshRuntimeConfig({ preset: "terminal-coding" }, 5);
    expect((engine as any).preset.name).toBe("terminal-coding");
    // Stale version: ignored entirely.
    engine.refreshRuntimeConfig({ preset: "general" }, 3);
    expect((engine as any).preset.name).toBe("terminal-coding");
  });
});
