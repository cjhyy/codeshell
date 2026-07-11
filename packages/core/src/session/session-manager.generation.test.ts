import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SessionManager close generation fencing", () => {
  it("accepts saves from two concurrently opened Engines in the same close epoch", () => {
    const storageDir = mkdtempSync(join(tmpdir(), "session-generation-concurrent-"));
    tempDirs.push(storageDir);
    const sid = "concurrent-sid";
    const seed = new SessionManager(storageDir);
    seed.create("/tmp/project", "model", "provider", sid);

    const engineA = new SessionManager(storageDir);
    const engineB = new SessionManager(storageDir);
    const generationA = engineA.registerSessionGeneration(sid);
    const generationB = engineB.registerSessionGeneration(sid);
    const stateA = engineA.resume(sid).state;
    const stateB = engineB.resume(sid).state;
    stateA.turnCount = 1;
    stateB.turnCount = 2;

    expect(generationA).toBe(generationB);
    expect(engineA.saveState(stateA)).toBe(true);
    expect(engineB.saveState(stateB)).toBe(true);
  });
});
