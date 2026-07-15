import { describe, expect, test } from "bun:test";
import type { SourceDefinition } from "../types.js";
import { mockAdapter } from "./mock.js";

const def: SourceDefinition = {
  id: "m",
  kind: "mock",
  label: "Mock",
  adapterConfig: {},
  enabled: true,
};

describe("mock adapter", () => {
  test("exposes 2 scopes / 3 resources per ADR DS-13 shape", async () => {
    const scopes = await mockAdapter.listScopes(def);
    expect(scopes.map((scope) => scope.id)).toEqual(["alpha", "beta"]);

    const alpha = await mockAdapter.listResources(def, "alpha");
    expect(alpha).toHaveLength(2);
    expect(await mockAdapter.listResources(def, "beta")).toHaveLength(1);
  });

  test("read returns content and honors UTF-8 maxBytes truncation", async () => {
    const full = await mockAdapter.read(def, "alpha/doc-1", { maxBytes: 10_000 });
    expect(full.truncated).toBe(false);
    expect(full.text).toContain("alpha doc one");

    const maxBytes = 15;
    const cut = await mockAdapter.read(def, "alpha/doc-1", { maxBytes });
    expect(cut.truncated).toBe(true);
    expect(Buffer.byteLength(cut.text, "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(cut.text).not.toContain("�");
  });

  test("unknown resource throws", async () => {
    await expect(mockAdapter.read(def, "nope", { maxBytes: 100 })).rejects.toThrow(/nope/);
  });
});
