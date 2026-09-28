import { describe, expect, test } from "bun:test";
import { createArenaModule } from "@cjhyy/code-shell-arena";
import { createCodingModule } from "@cjhyy/code-shell-capability-coding";
import { createOptimizationLabModule } from "@cjhyy/code-shell-capability-optimization-lab";
import { createPetModule } from "@cjhyy/code-shell-pet";
import { compileComposition } from "../packages/core/src/composition/compiler.js";
import type { AgentModule } from "../packages/core/src/composition/types.js";

describe("optimization lab composition", () => {
  test("appending it after the Desktop module set compiles without key collisions", () => {
    expect(() =>
      compileComposition({
        modules: [
          createCodingModule() as unknown as AgentModule,
          createArenaModule() as unknown as AgentModule,
          createPetModule() as unknown as AgentModule,
          createOptimizationLabModule() as unknown as AgentModule,
        ],
        expectedModules: ["coding", "arena", "pet", "optimization-lab"],
      }),
    ).not.toThrow();
  });
});
