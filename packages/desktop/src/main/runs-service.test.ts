import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteRunDir } from "./runs-service";

describe("deleteRunDir", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-rs-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

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

  it("refuses to delete for an unsafe id", async () => {
    const victim = path.join(dir, "victim");
    fs.mkdirSync(victim, { recursive: true });
    await deleteRunDir("..", dir);
    expect(fs.existsSync(victim)).toBe(true);
  });
});
