import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globTool } from "../../../packages/core/src/tool-system/builtin/glob.ts";
import type { ToolContext } from "../../../packages/core/src/tool-system/context.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "audit-r7-glob-order-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const ctx = () => ({ cwd: dir }) as ToolContext;
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Glob did not return text"); return value; }

test("FILES-R7-02 a file omitted by the 200-item page remains absent after becoming newest", async () => {
  const names = Array.from({ length: 201 }, (_, i) => `f${String(i).padStart(3, "0")}.txt`);
  for (const name of names) { const path = join(dir, name); writeFileSync(path, "owned fixture\n"); utimesSync(path, 946684800, 946684800); }
  const first = text(await globTool({ pattern: "*.txt" }, ctx()));
  const shown = first.split("\n").filter((line) => /^f\d{3}\.txt  \(/.test(line)).map((line) => line.split("  (")[0]);
  expect(shown).toHaveLength(200);
  const omitted = names.filter((name) => !shown.includes(name));
  expect(omitted).toHaveLength(1);
  utimesSync(join(dir, omitted[0]), 1893456000, 1893456000);
  expect(statSync(join(dir, omitted[0])).mtimeMs).toBeGreaterThan(statSync(join(dir, shown[0])).mtimeMs);
  const second = text(await globTool({ pattern: "*.txt" }, ctx()));
  expect(second).not.toContain(`${omitted[0]}  (`);
  expect(second).toContain("... and 1 more files (201 total)");
});

test("small result control places the newest file before older files", async () => {
  for (const [name, stamp] of [["old.txt", 946684800], ["middle.txt", 978307200], ["new.txt", 1009843200]] as const) {
    const path = join(dir, name); writeFileSync(path, "owned fixture\n"); utimesSync(path, stamp, stamp);
  }
  const output = text(await globTool({ pattern: "*.txt" }, ctx()));
  expect(output).toContain("3 files matched:");
  expect(output.indexOf("new.txt")).toBeLessThan(output.indexOf("middle.txt"));
  expect(output.indexOf("middle.txt")).toBeLessThan(output.indexOf("old.txt"));
});
