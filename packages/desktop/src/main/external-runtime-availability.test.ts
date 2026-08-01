/**
 * The probe decides whether a runtime appears in the model picker at all, so
 * both directions are failures worth pinning: advertising a binary that is not
 * there (user picks it, send fails), and hiding one that is (feature looks
 * missing).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { availableExternalRuntimes, findOnPath } from "./external-runtime-availability.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-runtime-probe-"));
  dirs.push(dir);
  return dir;
}
function makeExecutable(dir: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("external runtime availability", () => {
  test("finds an executable on PATH", () => {
    const dir = tempDir();
    const file = makeExecutable(dir, "codex");
    expect(findOnPath("codex", dir)).toBe(file);
  });

  test("returns null when the binary is absent", () => {
    expect(findOnPath("codex", tempDir())).toBeNull();
  });

  test.skipIf(process.platform === "win32")(
    "a present but non-executable file does not count",
    () => {
      // The confusing failure: the file exists, so a naive existsSync() probe
      // says "installed" and the spawn fails later with EACCES.
      const dir = tempDir();
      const file = join(dir, "codex");
      writeFileSync(file, "not executable");
      chmodSync(file, 0o644);
      expect(findOnPath("codex", dir)).toBeNull();
    },
  );

  test("a directory named like the binary does not count", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "codex"));
    expect(findOnPath("codex", dir)).toBeNull();
  });

  test("searches every PATH entry in order", () => {
    const first = tempDir();
    const second = tempDir();
    const file = makeExecutable(second, "codex");
    expect(findOnPath("codex", [first, second].join(delimiter))).toBe(file);
  });

  test("earlier PATH entries win", () => {
    const first = tempDir();
    const second = tempDir();
    const winner = makeExecutable(first, "codex");
    makeExecutable(second, "codex");
    expect(findOnPath("codex", [first, second].join(delimiter))).toBe(winner);
  });

  test("empty and missing PATH are handled, not crashed on", () => {
    expect(findOnPath("codex", "")).toBeNull();
    expect(findOnPath("codex", undefined)).toBeNull();
    expect(findOnPath("", "/usr/bin")).toBeNull();
  });

  test("an absolute command bypasses PATH", () => {
    const dir = tempDir();
    const file = makeExecutable(dir, "codex");
    // Found regardless of PATH…
    expect(findOnPath(file, "")).toBe(file);
    // …and still validated, so a bad absolute path is null rather than trusted.
    expect(findOnPath(join(dir, "nope"), "")).toBeNull();
  });

  test("availability maps binaries to runtime kinds", () => {
    const dir = tempDir();
    makeExecutable(dir, "codex");
    expect(availableExternalRuntimes(dir)).toEqual(["codex"]);

    makeExecutable(dir, "claude");
    expect(availableExternalRuntimes(dir).sort()).toEqual(["claude-code", "codex"]);
  });

  test("nothing installed yields an empty list, not a throw", () => {
    expect(availableExternalRuntimes(tempDir())).toEqual([]);
  });
});
