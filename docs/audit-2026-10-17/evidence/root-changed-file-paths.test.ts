import { test, expect } from "bun:test";
globalThis.fetch = (() => { throw new Error("audit fixture forbids network"); }) as typeof fetch;
const { extractChangedFilesFromCodexLines } = await import("../../../packages/coding/src/cc-orchestrator/external-agent-changes.ts");

function line(patch: string, jsonArguments = false) {
  return JSON.stringify({ type: "response_item", payload: jsonArguments
    ? { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ patch }) }
    : { type: "custom_tool_call", name: "apply_patch", input: patch } });
}

test("R2-08 patch rename attribution includes removed source but omits new file", () => {
  const patch = "*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@\n-old\n+new\n*** End Patch";
  const files = extractChangedFilesFromCodexLines(line(patch));
  console.log(JSON.stringify({ case: "rename", patch, files }));
  expect(files).toEqual(["src/old.ts"]);
  expect(files).not.toContain("src/new.ts");
});

test("R2-08 ordinary Update/Add/Delete header extraction normal control", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+new\n*** Delete File: src/c.ts\n*** End Patch";
  expect(extractChangedFilesFromCodexLines(line(patch))).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
});

test("candidate JSON arguments apply_patch is parsed as a literal escaped suffix", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch";
  const files = extractChangedFilesFromCodexLines(line(patch, true));
  console.log(JSON.stringify({ case: "json-args", files }));
  expect(files).toHaveLength(1);
  expect(files[0]).not.toBe("src/a.ts");
  expect(files[0]).toContain("\\n");
});
