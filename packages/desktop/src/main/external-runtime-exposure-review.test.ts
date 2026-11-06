import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "@cjhyy/code-shell-core";
import {
  BUILTIN_TOOLS,
  assertExternalToolReviewSnapshot,
  createExternalToolReviewSnapshot,
  deriveExternalToolExposure,
  FIRST_PHASE_EXPOSURE,
  REVIEWED_EXTERNAL_TOOL_EXPOSURE,
} from "@cjhyy/code-shell-core/extension";
import { CODING_TOOLS } from "@cjhyy/code-shell-capability-coding";
import { EXTERNAL_GOAL_TOOL_CATALOG } from "./external-runtime-goal-tools.js";

describe("Desktop composed external exposure review", () => {
  test("every declared core, coding and Host controller contract matches the full snapshot", () => {
    const catalog = [
      ...new Map(
        [...BUILTIN_TOOLS, ...CODING_TOOLS, ...EXTERNAL_GOAL_TOOL_CATALOG].map((tool) => [
          tool.definition.name,
          tool,
        ]),
      ).values(),
    ];
    expect(() =>
      assertExternalToolReviewSnapshot(createExternalToolReviewSnapshot(catalog)),
    ).not.toThrow();
    expect(createExternalToolReviewSnapshot(catalog)).toHaveLength(
      REVIEWED_EXTERNAL_TOOL_EXPOSURE.length,
    );
  });

  test("the original reviewed set is unchanged and only the explicit controller grants Goal tools", () => {
    const registry = new ToolRegistry({ toolCatalog: [...BUILTIN_TOOLS, ...CODING_TOOLS] });
    const original = [...FIRST_PHASE_EXPOSURE.toolNames].sort();
    expect(
      [...deriveExternalToolExposure(registry, { goalController: true }).toolNames].sort(),
    ).toEqual(original);
    for (const { definition, exposure } of EXTERNAL_GOAL_TOOL_CATALOG) {
      registry.unregisterTool(definition.name);
      registry.registerTool(definition, async () => "fixture", exposure);
    }
    expect([...deriveExternalToolExposure(registry).toolNames].sort()).toEqual(original);
    expect(
      [...deriveExternalToolExposure(registry, { goalController: true }).toolNames].sort(),
    ).toEqual(
      [...original, ...EXTERNAL_GOAL_TOOL_CATALOG.map((tool) => tool.definition.name)].sort(),
    );
  });
});
