import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExecutable, commandCandidateNames, _clearExecutableCache } from "./exec.js";

// P6: Node's spawn/execFile on Windows don't walk PATHEXT for a bare name, so
// a git.cmd/gh.cmd shim isn't found. resolveExecutable does an explicit
// PATH × PATHEXT lookup on win32; no-op on POSIX.

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cs-exec-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  setPlatform(realPlatform);
  _clearExecutableCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("commandCandidateNames", () => {
  test("POSIX → bare name only", () => {
    setPlatform("linux");
    expect(commandCandidateNames("git")).toEqual(["git"]);
  });
  test("win32 → bare + PATHEXT variants", () => {
    setPlatform("win32");
    const names = commandCandidateNames("git", { PATHEXT: ".EXE;.CMD" } as never);
    expect(names).toEqual(["git", "git.EXE", "git.CMD"]);
  });
  test("win32 with an explicit extension → bare only", () => {
    setPlatform("win32");
    expect(commandCandidateNames("git.exe")).toEqual(["git.exe"]);
  });
});

describe("resolveExecutable", () => {
  test("POSIX returns the command unchanged", () => {
    setPlatform("linux");
    expect(resolveExecutable("git")).toBe("git");
  });

  test("win32 finds a .cmd shim on PATH that bare spawn would miss", () => {
    const dir = tmp();
    // a `mytool.cmd` shim, no bare `mytool`.
    const shim = join(dir, "mytool.cmd");
    writeFileSync(shim, "@echo off\r\n");
    chmodSync(shim, 0o755);

    setPlatform("win32");
    _clearExecutableCache();
    const resolved = resolveExecutable("mytool", { PATH: dir, PATHEXT: ".EXE;.cmd" } as never);
    expect(resolved).toBe(shim);
  });

  test("win32 returns the command unchanged when nothing is found", () => {
    setPlatform("win32");
    _clearExecutableCache();
    const resolved = resolveExecutable("definitely-not-a-real-binary-xyz", {
      PATH: tmp(),
      PATHEXT: ".EXE;.CMD",
    } as never);
    expect(resolved).toBe("definitely-not-a-real-binary-xyz");
  });
});
