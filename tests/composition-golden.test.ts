/**
 * Composition golden baseline (design §12 Phase A).
 *
 * Dumps the CURRENT legacy composition path (composeToolCatalog +
 * registerExtensionModules order, composePromptSections,
 * composeCapabilityEngineHooks, resolveAgentPreset, engine behavior-profile
 * merge) for the real Core+Coding+Arena+Pet stack into a snapshot-shaped
 * object, asserts it equals the checked-in golden fixture, and asserts the
 * NEW compiler reproduces the same snapshot from bridged modules.
 *
 * Regenerate: UPDATE_COMPOSITION_GOLDEN=1 bun test tests/composition-golden.test.ts
 * (requires fresh dists: bun run build)
 */
import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODING_CAPABILITY } from "@cjhyy/code-shell-capability-coding";
import { createArenaCapability } from "@cjhyy/code-shell-arena";
import { createPetCapability } from "@cjhyy/code-shell-pet";
import { BUILTIN_TOOLS } from "../packages/core/src/tool-system/builtin/index.js";
import {
  composeCapabilityEngineHooks,
  composePromptSections,
  composeToolCatalog,
  type CapabilityModule,
} from "../packages/core/src/capabilities/index.js";
import { BUILTIN_AGENT_PRESETS, resolveAgentPreset } from "../packages/core/src/preset/index.js";
import {
  ISOLATED_TASK_PROFILE,
  QUICK_CHAT_RESTRICTED_PROFILE,
} from "../packages/core/src/engine/run-types.js";
import type { ExtensionModule } from "../packages/core/src/tool-system/capability-module.js";
import { compileComposition } from "../packages/core/src/composition/compiler.js";
import { toCompositionSnapshot } from "../packages/core/src/composition/snapshot.js";
import type { CompositionSnapshot } from "../packages/core/src/composition/types.js";
import { fromCapabilityModule, fromExtensionModule } from "./helpers/composition-bridges.js";

const GOLDEN_PATH = join(import.meta.dir, "fixtures", "composition-golden.json");

const coding = CODING_CAPABILITY as unknown as CapabilityModule;
const arena = createArenaCapability() as unknown as ExtensionModule;
const pet = createPetCapability() as unknown as ExtensionModule;
const capabilities = [coding];
const extensionModules = [arena, pet];

/** Snapshot of the legacy path, mirroring engine.ts construction order. */
function dumpLegacyComposition(): CompositionSnapshot {
  const catalog = composeToolCatalog(BUILTIN_TOOLS, capabilities, extensionModules);
  const builtinNames = new Set(BUILTIN_TOOLS.map((t) => t.definition.name));
  const codingNames = new Set((coding.tools ?? []).map((t) => t.definition.name));
  const catalogOwner = (name: string): string => {
    if (builtinNames.has(name)) return "core";
    if (codingNames.has(name)) return coding.id;
    for (const module of extensionModules) {
      if ((module.catalogTools ?? []).some((t) => t.definition.name === name)) return module.id;
    }
    throw new Error(`Unattributed catalog tool: ${name}`);
  };
  const defaultPreset = resolveAgentPreset(undefined, capabilities).name;
  // Effective preset table: capability presets shadow same-named builtins in
  // place (resolveAgentPreset checks contributed presets before builtins).
  const presets = Object.values(BUILTIN_AGENT_PRESETS).map((p) => ({
    preset: p,
    moduleId: "core",
  }));
  for (const capability of capabilities) {
    for (const preset of capability.presets ?? []) {
      const existing = presets.findIndex((row) => row.preset.name === preset.name);
      if (existing >= 0) presets[existing] = { preset, moduleId: capability.id };
      else presets.push({ preset, moduleId: capability.id });
    }
  }
  return {
    version: 1,
    modules: [
      { id: "core", order: 0, source: "core" },
      { id: coding.id, order: 1, source: "host" },
      ...extensionModules.map((m, i) => ({ id: m.id, order: 2 + i, source: "host" })),
    ],
    tools: [
      ...catalog.map((tool) => ({
        name: tool.definition.name,
        moduleId: catalogOwner(tool.definition.name),
        exposure: "preset-tags" as const,
        presetTags: [...tool.exposure.presetTags],
      })),
      ...extensionModules.flatMap((module) =>
        (module.tools ?? []).map((tool) => ({
          name: tool.definition.name,
          moduleId: module.id,
          exposure: "always" as const,
          presetTags: [] as string[],
        })),
      ),
    ],
    presets: presets.map(({ preset, moduleId }) => ({
      name: preset.name,
      moduleId,
      isDefault: preset.name === defaultPreset,
    })),
    promptSections: Object.keys(composePromptSections(capabilities)).map((name) => ({
      name,
      moduleId: coding.id,
    })),
    hooks: composeCapabilityEngineHooks(capabilities).map((hook) => ({
      event: hook.event,
      name: hook.name,
      priority: hook.priority,
      moduleId: hook.capabilityId,
    })),
    behaviorProfiles: [
      { id: QUICK_CHAT_RESTRICTED_PROFILE.id, moduleId: "core" },
      { id: ISOLATED_TASK_PROFILE.id, moduleId: "core" },
      ...extensionModules.flatMap((module) =>
        (module.behaviorProfiles ?? []).map((p) => ({ id: p.id, moduleId: module.id })),
      ),
    ],
    queries: extensionModules.flatMap((module) =>
      Object.keys(module.queries ?? {}).map((type) => ({ type, moduleId: module.id })),
    ),
    observers: extensionModules.filter((m) => m.createProtocolObserver).map((m) => m.id),
    runValidators: extensionModules.filter((m) => m.validateRunParams).map((m) => m.id),
    hiddenSessionKinds: extensionModules.flatMap((module) =>
      (module.hiddenSessionKinds ?? []).map((kind) => ({ kind, moduleId: module.id })),
    ),
  };
}

describe("composition golden baseline", () => {
  const legacy = dumpLegacyComposition();

  test("legacy composition matches checked-in golden", () => {
    if (process.env.UPDATE_COMPOSITION_GOLDEN === "1") {
      const baselineCommit = execSync("git rev-parse HEAD").toString().trim();
      writeFileSync(GOLDEN_PATH, JSON.stringify({ baselineCommit, snapshot: legacy }, null, 2));
    }
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as {
      baselineCommit: string;
      snapshot: CompositionSnapshot;
    };
    expect(golden.baselineCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(legacy).toEqual(golden.snapshot);
  });

  test("compiler reproduces the legacy composition item by item", () => {
    const composition = compileComposition({
      modules: [
        fromCapabilityModule(coding),
        ...extensionModules.map((m) => fromExtensionModule(m)),
      ],
      expectedModules: ["coding", "arena", "pet"],
    });
    expect(toCompositionSnapshot(composition)).toEqual(legacy);
  });
});
