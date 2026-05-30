import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listFiles } from "./list-files.js";

// Regression: /files interpolated the user pattern into a `find ... -name
// "${pattern}"` shell string run via execSync (review-2026-05-30, security).
// `"; rm -rf ~ #` style input could break out and execute. The fix runs find
// via execFileSync argv so the pattern is one literal -name value.

describe("listFiles — no shell injection", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-files-"));
    writeFileSync(join(dir, "a.txt"), "");
    writeFileSync(join(dir, "b.md"), "");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "c.txt"), "");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("lists files with no pattern", () => {
    const out = listFiles(dir, "");
    expect(out).toContain("a.txt");
    expect(out).toContain("b.md");
  });

  test("filters by a glob pattern passed as a literal -name value", () => {
    const out = listFiles(dir, "*.txt");
    expect(out).toContain("a.txt");
    expect(out).toContain("c.txt");
    expect(out).not.toContain("b.md");
  });

  test("a shell-injection pattern does not execute — treated as a literal name", () => {
    const sentinel = join(dir, "PWNED");
    const malicious = `x"; touch ${sentinel} #`;
    listFiles(dir, malicious);
    expect(existsSync(sentinel)).toBe(false);
  });

  test("caps output at 50 lines", () => {
    for (let i = 0; i < 80; i++) writeFileSync(join(dir, `f${i}.log`), "");
    const out = listFiles(dir, "*.log");
    expect(out.split("\n").filter(Boolean).length).toBeLessThanOrEqual(50);
  });
});
