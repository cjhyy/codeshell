/**
 * Composition golden baseline (design §12 Phase A/B).
 *
 * The fixture was generated from the PRE-cutover legacy composition path
 * (composeToolCatalog + registerExtensionModules order, resolveAgentPreset,
 * engine behavior-profile merge) at the baseline commit recorded inside it.
 * Post-cutover, the product AgentModule factories compiled through
 * compileComposition() must reproduce that snapshot item by item — this is
 * the proof that the cutover changed wiring, not behavior.
 *
 * The fixture is frozen: do NOT regenerate it to make this test pass. Only
 * a deliberate, reviewed composition change may update it
 * (UPDATE_COMPOSITION_GOLDEN=1 bun test tests/composition-golden.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCodingModule } from "@cjhyy/code-shell-capability-coding";
import { createArenaModule } from "@cjhyy/code-shell-arena";
import { createPetModule } from "@cjhyy/code-shell-pet";
import { compileComposition } from "../packages/core/src/composition/compiler.js";
import { toCompositionSnapshot } from "../packages/core/src/composition/snapshot.js";
import type { AgentModule, CompositionSnapshot } from "../packages/core/src/composition/types.js";

const GOLDEN_PATH = join(import.meta.dir, "fixtures", "composition-golden.json");

describe("composition golden baseline", () => {
  const composition = compileComposition({
    modules: [
      createCodingModule() as unknown as AgentModule,
      createArenaModule() as unknown as AgentModule,
      createPetModule() as unknown as AgentModule,
    ],
    expectedModules: ["coding", "arena", "pet"],
  });
  const snapshot = toCompositionSnapshot(composition);

  test("product factories reproduce the pre-cutover legacy composition", () => {
    if (process.env.UPDATE_COMPOSITION_GOLDEN === "1") {
      const baselineCommit = execSync("git rev-parse HEAD").toString().trim();
      writeFileSync(GOLDEN_PATH, JSON.stringify({ baselineCommit, snapshot }, null, 2));
    }
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as {
      baselineCommit: string;
      snapshot: CompositionSnapshot;
    };
    expect(golden.baselineCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot).toEqual(golden.snapshot);
  });

  test("engine and protocol read the same digest", () => {
    const again = compileComposition({
      modules: [
        createCodingModule() as unknown as AgentModule,
        createArenaModule() as unknown as AgentModule,
        createPetModule() as unknown as AgentModule,
      ],
    });
    expect(again.digest).toBe(composition.digest);
  });
});
