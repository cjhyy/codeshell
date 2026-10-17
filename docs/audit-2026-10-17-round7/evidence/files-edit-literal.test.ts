import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool } from "../../../packages/core/src/tool-system/builtin/edit.ts";
import { readTool } from "../../../packages/core/src/tool-system/builtin/read.ts";
import { fileCache } from "../../../packages/core/src/tool-system/builtin/file-cache.ts";
import type { ToolContext } from "../../../packages/core/src/tool-system/context.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "audit-r7-edit-literal-")); });
afterEach(() => { fileCache.clear(); rmSync(dir, { recursive: true, force: true }); });
const ctx = () => ({ cwd: dir }) as ToolContext;

for (const [token, observed] of [
  ["$&", "before price = 'PLACEHOLDER'; after"],
  ["$$", "before price = '$'; after"],
  ["$`", "before price = 'before '; after"],
  ["$'", "before price = ' after'; after"],
] as const) {
  test(`FILES-R7-01 default Edit expands literal replacement token ${token}`, async () => {
    const path = join(dir, "prices.js");
    writeFileSync(path, "before PLACEHOLDER after");
    const replacement = `price = '${token}';`;
    const output = await editTool({ file_path: path, old_string: "PLACEHOLDER", new_string: replacement }, ctx());
    expect(output).toContain("Successfully edited");
    expect(output).toContain(`  + ${replacement}`);
    expect(readFileSync(path, "utf8")).toBe(observed);
    expect(await readTool({ file_path: path }, ctx())).toBe(`1\t${observed}`);
  });
}

test("ordinary single replacement and unmatched capture-token control remain literal", async () => {
  const path = join(dir, "control.js");
  writeFileSync(path, "before PLACEHOLDER after");
  expect(await editTool({ file_path: path, old_string: "PLACEHOLDER", new_string: "price = '$1';" }, ctx())).toContain("Successfully edited");
  expect(readFileSync(path, "utf8")).toBe("before price = '$1'; after");
  expect(await editTool({ file_path: path, old_string: "price", new_string: "cost" }, ctx())).toContain("1 replacement");
  expect(readFileSync(path, "utf8")).toBe("before cost = '$1'; after");
});

test("explicit replace_all preserves identical literal replacement bytes", async () => {
  const path = join(dir, "all.js");
  writeFileSync(path, "before PLACEHOLDER after");
  expect(await editTool({ file_path: path, old_string: "PLACEHOLDER", new_string: "price = '$&';", replace_all: true }, ctx())).toContain("1 replacement");
  expect(readFileSync(path, "utf8")).toBe("before price = '$&'; after");
});
