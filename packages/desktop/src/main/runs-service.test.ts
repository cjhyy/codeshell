import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteRunDir, getRun } from "./runs-service";

describe("deleteRunDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-rs-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes a run directory", async () => {
    const rdir = path.join(dir, "run-1");
    fs.mkdirSync(rdir, { recursive: true });
    fs.writeFileSync(path.join(rdir, "run.json"), "{}");
    await deleteRunDir("run-1", dir);
    expect(fs.existsSync(rdir)).toBe(false);
  });

  it("is a no-op when missing", async () => {
    await deleteRunDir("ghost", dir);
    expect(true).toBe(true);
  });

  it("rejects path-shaped ids instead of deleting aliases", async () => {
    const victim = path.join(dir, "victim");
    fs.mkdirSync(victim, { recursive: true });
    const alias = path.join(dir, "run");
    fs.mkdirSync(alias, { recursive: true });
    await expect(deleteRunDir("r/un", dir)).rejects.toThrow(/invalid run id/);
    await expect(deleteRunDir("..", dir)).rejects.toThrow(/invalid run id/);
    expect(fs.existsSync(victim)).toBe(true);
    expect(fs.existsSync(alias)).toBe(true);
  });
});

describe("getRun", () => {
  it("rejects path-shaped and parent-dir ids instead of normalizing them", async () => {
    await expect(getRun("r/un")).rejects.toThrow(/invalid run id/);
    await expect(getRun("run..backup")).rejects.toThrow(/invalid run id/);
    await expect(getRun("a".repeat(129))).rejects.toThrow(/invalid run id/);
  });
});
