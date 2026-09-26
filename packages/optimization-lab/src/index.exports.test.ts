import { describe, expect, it } from "bun:test";
import * as capabilityApi from "./index.capability.js";
import * as rootApi from "./index.js";

describe("optimization-lab package entry contracts", () => {
  it("keeps the capability entry to the module factory", () => {
    expect(Object.keys(capabilityApi).sort()).toEqual(["createOptimizationLabModule"]);
    expect(capabilityApi.createOptimizationLabModule).toBe(rootApi.createOptimizationLabModule);
  });

  it("stays private with only the root and capability subpaths", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(manifest.private).toBe(true);
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./capability"]);
  });
});
