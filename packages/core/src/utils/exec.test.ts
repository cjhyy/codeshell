import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveExecutable,
  commandCandidateNames,
  _clearExecutableCache,
  findExecutable,
  setGitPathOverride,
  resolveGit,
  isGitAvailable,
} from "./exec.js";

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

describe("findExecutable", () => {
  test("returns the absolute path when the binary exists on PATH", () => {
    setPlatform("linux");
    const dir = tmp();
    const bin = join(dir, "mytool");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(findExecutable("mytool", { PATH: dir } as never)).toBe(bin);
  });

  test("returns null when the binary is not found (unlike resolveExecutable)", () => {
    setPlatform("linux");
    expect(findExecutable("definitely-not-real-xyz", { PATH: tmp() } as never)).toBeNull();
  });
});

describe("git override + availability", () => {
  afterEach(() => setGitPathOverride(null));

  test("resolveGit honors the override path", () => {
    setPlatform("linux");
    setGitPathOverride("/custom/git");
    // POSIX resolveExecutable returns the command unchanged.
    expect(resolveGit()).toBe("/custom/git");
  });

  test("isGitAvailable is false when neither override nor PATH has git", () => {
    setPlatform("linux");
    setGitPathOverride(null);
    expect(isGitAvailable({ PATH: tmp() } as never)).toBe(false);
  });

  test("isGitAvailable is true when the override path points at a real file", () => {
    setPlatform("linux");
    const dir = tmp();
    const bin = join(dir, "git");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    setGitPathOverride(bin);
    expect(isGitAvailable({ PATH: tmp() } as never)).toBe(true);
  });

  test("empty/whitespace override clears it (falls back to PATH git)", () => {
    setGitPathOverride("   ");
    setPlatform("linux");
    expect(isGitAvailable({ PATH: tmp() } as never)).toBe(false);
  });
});
