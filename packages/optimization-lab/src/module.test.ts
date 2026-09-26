import { describe, expect, test } from "bun:test";
import { createOptimizationLabModule } from "./module.js";

describe("createOptimizationLabModule", () => {
  test("uses a valid composition id", () => {
    expect(createOptimizationLabModule().id).toBe("optimization-lab");
  });

  test("namespaces every protocol query", () => {
    const queries = createOptimizationLabModule().protocol?.queries ?? {};
    for (const name of Object.keys(queries)) {
      expect(name.startsWith("optimization_lab_")).toBe(true);
    }
  });
});
