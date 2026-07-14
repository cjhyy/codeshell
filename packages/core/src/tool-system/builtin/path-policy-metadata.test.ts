import { describe, expect, test } from "bun:test";
import { BUILTIN_TOOLS } from "./index.js";

function propertyNames(tool: (typeof BUILTIN_TOOLS)[number]): string[] {
  const props = tool.definition.inputSchema?.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return [];
  return Object.keys(props as Record<string, unknown>);
}

describe("builtin path-policy metadata", () => {
  test("every builtin with path-like input declares pathPolicy or an explicit exemption", () => {
    const pathLike = new Set(["file_path", "path", "notebook_path", "patch"]);
    const missing = BUILTIN_TOOLS.filter((tool) =>
      propertyNames(tool).some((name) => pathLike.has(name)),
    )
      .filter(
        (tool) =>
          !tool.definition.pathPolicy?.length &&
          !tool.definition.pathResolver &&
          tool.definition.pathPolicyExempt !== true,
      )
      .map((tool) => tool.definition.name);

    expect(missing).toEqual([]);
  });

  test("current filesystem builtins are centrally guarded", () => {
    const guarded = new Map(
      BUILTIN_TOOLS.filter((tool) => tool.definition.pathPolicy?.length).map((tool) => [
        tool.definition.name,
        tool.definition.pathPolicy,
      ]),
    );

    expect(guarded.has("Read")).toBe(true);
    expect(guarded.has("Write")).toBe(true);
    expect(guarded.has("Edit")).toBe(true);
    expect(guarded.has("Glob")).toBe(true);
    expect(guarded.has("Grep")).toBe(true);
    expect(guarded.has("view_image")).toBe(true);
  });
});
