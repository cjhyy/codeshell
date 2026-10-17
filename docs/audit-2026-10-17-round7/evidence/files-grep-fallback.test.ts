import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepTool, _setGrepExecFileForTest } from "../../../packages/core/src/tool-system/builtin/grep.ts";
import type { ToolContext } from "../../../packages/core/src/tool-system/context.ts";

let dir: string;
let commands: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audit-r7-grep-glob-")); commands = [];
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  writeFileSync(join(dir, "src", "deep", "answer.ts"), "const needle = 42;\n");
  writeFileSync(join(dir, "root.ts"), "const needle = 0;\n");
  writeFileSync(join(dir, "notes.md"), "needle in notes\n");
  _setGrepExecFileForTest(async (command) => {
    commands.push(command);
    throw Object.assign(new Error("synthetic missing command; no process launched"), { code: "ENOENT" });
  });
});
afterEach(() => { _setGrepExecFileForTest(); rmSync(dir, { recursive: true, force: true }); });
const ctx = () => ({ cwd: dir }) as ToolContext;

test("FILES-R7-03 Node fallback loses a directory-qualified glob despite finding the same file unfiltered", async () => {
  const unfiltered = await grepTool({ pattern: "needle", output_mode: "content" }, ctx());
  expect(unfiltered).toContain("src/deep/answer.ts:1:const needle = 42;");
  const filtered = await grepTool({ pattern: "needle", glob: "src/**/*.ts", output_mode: "content" }, ctx());
  expect(filtered).toBe("No matches found.");
  expect(commands).toEqual(["rg", "grep", "rg", "grep"]);
});

test("simple basename filter control finds TypeScript and omits Markdown", async () => {
  const filtered = await grepTool({ pattern: "needle", glob: "*.ts", output_mode: "content" }, ctx());
  expect(filtered).toContain("src/deep/answer.ts:1:const needle = 42;");
  expect(filtered).toContain("root.ts:1:const needle = 0;");
  expect(filtered).not.toContain("notes.md");
  expect(commands).toEqual(["rg", "grep"]);
});
