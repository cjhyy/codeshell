import { expect, test } from "bun:test";
import { compileComposition } from "../../../packages/core/src/composition/compiler.js";
import { toCompositionSnapshot } from "../../../packages/core/src/composition/snapshot.js";
import { compositionPromptSections, resolvePresetFromComposition } from "../../../packages/core/src/composition/resolve-preset.js";
import type { AgentModule } from "../../../packages/core/src/composition/types.js";

test("compiler copies nested ordinary declaration metadata without freezing its author", () => {
  let executed = 0;
  const definition = { name: "OwnedDataTool", description: "original", parameters: { type: "object", properties: { value: { type: "string", description: "original field" } } } };
  const module: AgentModule = { id: "owned-data", engine: { tools: [{ kind: "always", tool: { definition, execute: async () => { executed++; return {}; } } }] } };
  const composition = compileComposition({ modules: [module] });
  const compiled = composition.engine.tools.find(t => t.moduleId === module.id)!.tool.definition;
  definition.description = "author changed";
  definition.parameters.properties.value.description = "author field changed";
  expect(compiled.description).toBe("original");
  expect((compiled.parameters as typeof definition.parameters).properties.value.description).toBe("original field");
  expect(Object.isFrozen(compiled)).toBe(true);
  expect(Object.isFrozen((compiled.parameters as typeof definition.parameters).properties.value)).toBe(true);
  expect(Object.isFrozen(module)).toBe(false);
  expect(Object.isFrozen(definition)).toBe(false);
  expect(executed).toBe(0);
});

test("runtime preset selection and fresh prompt-section projection preserve compiled declarations", () => {
  const module: AgentModule = { id: "owned-preset", engine: {
    defaultPreset: "owned-general",
    presets: [{ name: "owned-general", label: "Owned", description: "Owned ordinary preset", promptSections: ["owned-section"], builtinTools: [], defaultPermissionRules: [] }],
    promptSections: { "owned-section": "Original prompt text" },
  } };
  const composition = compileComposition({ modules: [module] });
  expect(resolvePresetFromComposition(composition).name).toBe("owned-general");
  expect(resolvePresetFromComposition(composition, "general").name).toBe("general");
  expect(() => resolvePresetFromComposition(composition, "missing-owned-preset")).toThrow("Unknown agent preset");
  const first = compositionPromptSections(composition);
  first["owned-section"] = "Local projection edit";
  expect(compositionPromptSections(composition)["owned-section"]).toBe("Original prompt text");
  expect(Object.isFrozen(module)).toBe(false);
});

test("ordered query/prompt metadata snapshot omits callable implementations and prompt bodies", () => {
  let invoked = 0;
  const composition = compileComposition({ modules: [
    { id: "owned-first", engine: { promptSections: { "owned-note": "Body deliberately excluded from topology" } }, protocol: { queries: { "owned-query": () => { invoked++; return "unused"; } } } },
    { id: "owned-second", protocol: { hiddenSessionKinds: ["owned-hidden-kind"] } },
  ] });
  const snapshot = toCompositionSnapshot(composition);
  expect(snapshot.modules.slice(-2).map(m => m.id)).toEqual(["owned-first", "owned-second"]);
  expect(snapshot.queries).toContainEqual({ type: "owned-query", moduleId: "owned-first" });
  expect(snapshot.promptSections).toContainEqual({ name: "owned-note", moduleId: "owned-first" });
  expect(JSON.stringify(snapshot)).not.toContain("Body deliberately excluded");
  expect(JSON.stringify(snapshot)).not.toContain("unused");
  expect(invoked).toBe(0);
});
