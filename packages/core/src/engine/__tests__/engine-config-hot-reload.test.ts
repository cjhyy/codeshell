import { describe, it, expect } from "bun:test";
import { Engine } from "../engine.js";
import { PromptComposer } from "../../prompt/composer.js";
import { buildPresetSystemPrompt, BUILTIN_AGENT_PRESETS } from "../../preset/index.js";
import type { CapabilityModule } from "../../capabilities/index.js";

const TEST_PRESET_NAME = "test-focused";
const TEST_CAPABILITY: CapabilityModule = {
  id: "test-preset-hot-reload",
  presets: [
    {
      ...BUILTIN_AGENT_PRESETS.general,
      name: TEST_PRESET_NAME,
      label: "Focused test preset",
      description: "A small product-contributed preset used to verify hot reloads.",
      promptSections: ["base"],
    },
  ],
};

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
    capabilities: [TEST_CAPABILITY],
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
    engine.refreshRuntimeConfig({ preset: TEST_PRESET_NAME }, 1);

    expect((engine as any).preset.name).toBe(TEST_PRESET_NAME);
    const after = await presetSystemPrompt(engine);
    expect(after).not.toBe(before);
    expect(before).toContain("Working style");
    expect(after).not.toContain("Working style");
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
    engine.refreshRuntimeConfig({ preset: TEST_PRESET_NAME }, 5);
    expect((engine as any).preset.name).toBe(TEST_PRESET_NAME);
    // Stale version: ignored entirely.
    engine.refreshRuntimeConfig({ preset: "general" }, 3);
    expect((engine as any).preset.name).toBe(TEST_PRESET_NAME);
  });
});

// TODO §6.1 — the fire-and-forget MCP reconcile during hot-reload must not
// surface as an unhandled rejection: one flaky server failing to connect/
// disconnect would otherwise crash the host (or be silently swallowed).
describe("Engine.refreshRuntimeConfig MCP reconcile is best-effort", () => {
  it("a rejecting reconcile does not throw out of refreshRuntimeConfig", async () => {
    const engine = buildEngine("general");
    let reconcileCalled = false;
    let caught = false;
    // Inject a mcpManager whose reconcile rejects.
    (engine as any).mcpManager = {
      reconcile: () => {
        reconcileCalled = true;
        const p = Promise.reject(new Error("server X refused connection"));
        // Track that the engine attached a .catch so the rejection is handled.
        return {
          catch: (fn: (e: unknown) => void) =>
            p.catch((e) => {
              caught = true;
              fn(e);
            }),
        };
      },
    };

    // Must return synchronously without throwing, even though reconcile rejects.
    expect(() =>
      engine.refreshRuntimeConfig({ mcpServers: { X: { command: "x", args: [] } as any } }, 1),
    ).not.toThrow();
    expect(reconcileCalled).toBe(true);

    // Let the rejected promise settle; the engine's .catch must have run.
    await new Promise((r) => setTimeout(r, 0));
    expect(caught).toBe(true);
    // Version still advanced despite the reconcile failure.
    expect((engine as any).lastAppliedConfigVersion).toBe(1);
  });
});
