import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath } from "./path-policy.js";

// P3: on Windows the file system is case-insensitive, so workspace-boundary
// and sensitive-path checks must compare case-insensitively (normPath lower-
// cases on win32). A case-sensitive startsWith would (a) misfire a spurious
// "outside workspace" ask for a legit in-workspace path written in a different
// case and (b) let a sensitive-dir check be evaded by varying case.
//
// NOTE: this runs on macOS, whose default FS is ALSO case-insensitive at the
// realpath layer — so this can't fully isolate the normPath fix from realpath
// case-folding. It exercises the win32 branch and documents intent; the
// authoritative check is the Windows real-machine smoke test (P8).

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
const dirs: string[] = [];
function tmpWs(): string {
  const d = mkdtempSync(join(tmpdir(), "cs-win-path-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  setPlatform(realPlatform);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("classifyPath — win32 case-insensitive workspace boundary (P3)", () => {
  test("an in-workspace path in a different case classifies as inside (allow)", () => {
    const ws = tmpWs();
    const upper = join(ws.toUpperCase(), "src", "index.ts");
    setPlatform("win32");
    const c = classifyPath(upper, { workspaceRoot: ws, operation: "write" });
    expect(c.decision).toBe("allow");
  });

  test("workspaceRoot given in mixed case still matches a lower-case file", () => {
    const ws = tmpWs();
    const file = join(ws, "lib", "util.ts");
    setPlatform("win32");
    const c = classifyPath(file, { workspaceRoot: ws.toUpperCase(), operation: "write" });
    expect(c.decision).toBe("allow");
  });
});
