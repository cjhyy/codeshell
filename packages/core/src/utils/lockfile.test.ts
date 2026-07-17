import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lock, check, unlock } from "./lockfile.js";

let dir: string;
let target: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lockfile-"));
  target = join(dir, "run.json");
  writeFileSync(target, "{}");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("lockfile (proper-lockfile lazy accessor)", () => {
  test("keeps proper-lockfile's missing declarations out of the public type surface", () => {
    const source = readFileSync(join(import.meta.dir, "lockfile.ts"), "utf8");
    expect(source).not.toMatch(/import\s+type\b[^;]*from\s+["']proper-lockfile["']/);
    expect(source).not.toMatch(/typeof\s+import\(["']proper-lockfile["']\)/);
  });

  // Regression: this module compiles to ESM and proper-lockfile is CommonJS.
  // A bare `require()` threw "require is not defined" in ESM hosts (Electron
  // main), which made every run lock silently fail. Loading the package must
  // not throw, and lock/unlock must round-trip on a real file.
  test("acquires and releases a lock without throwing", async () => {
    const release = await lock(target, { retries: 0 });
    expect(await check(target)).toBe(true);
    await release();
    expect(await check(target)).toBe(false);
  });

  test("a second lock on a held target is refused", async () => {
    const release = await lock(target, { retries: 0 });
    await expect(lock(target, { retries: 0 })).rejects.toThrow();
    await unlock(target);
    void release;
  });
});
