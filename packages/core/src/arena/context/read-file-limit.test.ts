import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { executeContextTool } from "./context-tools.js";
import type { ToolCall } from "../../types.js";

// executeReadFile's validatePath gates to REPO_ROOT = resolve(".") (the process
// cwd). The temp file must live INSIDE the repo, not /tmp, or validatePath
// rejects it before the limit logic runs.
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(process.cwd(), "ctx-readfile-"));
  file = join(dir, "f.txt");
  // 10 lines: L1..L10
  writeFileSync(file, Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function readFile(args: Record<string, unknown>): string {
  const tc = { id: "c1", toolName: "read_file", args: { path: file, ...args } } as unknown as ToolCall;
  return executeContextTool(tc);
}

describe("read_file limit guard", () => {
  test("reads from offset for `limit` lines", () => {
    const out = readFile({ offset: 1, limit: 3 });
    expect(out).toContain("L1");
    expect(out).toContain("L3");
    expect(out).not.toContain("L4");
  });

  // Footgun: limit fed straight to lines.slice(offset, offset+limit). A negative
  // limit makes slice count "from the end" → silently returns "all but the last
  // N lines" instead of an error/empty, so the reader sees a truncated file and
  // may think it's shorter than it is. A non-positive limit must not produce a
  // surprise window.
  test("negative limit does not silently drop the file's tail", () => {
    const out = readFile({ offset: 1, limit: -3 });
    // raw slice(0, -3) would return L1..L7 (dropping the last 3). The guard must
    // NOT return that surprise window — a non-positive limit yields no lines.
    expect(out).not.toContain("L7");
    expect(out.trim()).toBe("");
  });

  test("NaN limit falls back to default (not a crash / not empty)", () => {
    const out = readFile({ offset: 1, limit: Number.NaN as unknown as number });
    expect(out).toContain("L1");
    expect(out).toContain("L10"); // default ≥ file length → whole file
  });
});
