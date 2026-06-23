import { describe, it, expect } from "bun:test";
import {
  findToolMetadataIssues,
  validateToolMetadata,
  collectToolMetadataIssues,
} from "./validate-tool-metadata.js";
import { BUILTIN_TOOLS } from "./builtin/index.js";
import type { RegisteredTool } from "../types.js";

function tool(partial: Partial<RegisteredTool> & { name: string }): RegisteredTool {
  return {
    description: "",
    inputSchema: { type: "object", properties: {} },
    source: "builtin",
    permissionDefault: "ask",
    ...partial,
  } as RegisteredTool;
}

describe("validateToolMetadata", () => {
  it("passes a tool whose pathPolicy.arg exists in the schema", () => {
    const t = tool({
      name: "Read",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      pathPolicy: [{ kind: "arg", arg: "path", operation: "read" }],
    });
    expect(findToolMetadataIssues(t)).toEqual([]);
    expect(() => validateToolMetadata(t)).not.toThrow();
  });

  it("flags a pathPolicy.arg that is a typo (not in the schema)", () => {
    const t = tool({
      name: "BadRead",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      // typo: "pat" — the executor would read args["pat"] === undefined and
      // silently run with no path protection.
      pathPolicy: [{ kind: "arg", arg: "pat", operation: "read" }],
    });
    const issues = findToolMetadataIssues(t);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.arg).toBe("pat");
    expect(() => validateToolMetadata(t)).toThrow(/BadRead/);
  });

  it("validates apply_patch policies the same way", () => {
    const ok = tool({
      name: "ApplyPatch",
      inputSchema: { type: "object", properties: { input: { type: "string" } } },
      pathPolicy: [{ kind: "apply_patch", arg: "input", operation: "write" }],
    });
    const bad = tool({
      name: "ApplyPatchBad",
      inputSchema: { type: "object", properties: { input: { type: "string" } } },
      pathPolicy: [{ kind: "apply_patch", arg: "patch", operation: "write" }],
    });
    expect(findToolMetadataIssues(ok)).toEqual([]);
    expect(findToolMetadataIssues(bad)).toHaveLength(1);
  });

  it("treats a defaultToCwd arg the same — it must still be a declared property", () => {
    // Glob/Grep can omit the arg at call time (defaults to cwd), but the field
    // must still be declared so a typo can't hide.
    const t = tool({
      name: "Glob",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      pathPolicy: [{ kind: "arg", arg: "path", operation: "read", defaultToCwd: true }],
    });
    expect(findToolMetadataIssues(t)).toEqual([]);
  });

  it("no pathPolicy → no issues", () => {
    expect(findToolMetadataIssues(tool({ name: "WebSearch" }))).toEqual([]);
  });

  it("every shipped built-in tool has consistent pathPolicy metadata", () => {
    // Doubles as a codebase audit: any real typo in a builtin's pathPolicy.arg
    // surfaces here.
    const issues = collectToolMetadataIssues(
      BUILTIN_TOOLS.map((t) => t.definition),
    );
    expect(issues).toEqual([]);
  });
});
