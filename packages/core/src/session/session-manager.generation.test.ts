import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";
import { lockSync } from "../utils/lockfile.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SessionManager close generation fencing", () => {
  it("uses state revision CAS between Engines in the same close epoch", () => {
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
    expect(engineB.saveState(stateB)).toBe(false);
    expect(seed.resume(sid).state.turnCount).toBe(1);
  });

  it("recovers a stale orphaned state lock left by a crashed process", () => {
    const storageDir = mkdtempSync(join(tmpdir(), "session-generation-orphan-lock-"));
    tempDirs.push(storageDir);
    const sid = "orphan-lock-sid";
    const manager = new SessionManager(storageDir);
    const bundle = manager.create("/tmp/project", "model", "provider", sid);
    const lockPath = join(storageDir, sid, "state.json.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999_999, createdAtMs: Date.now() - 60_000 }),
      "utf8",
    );
    const staleAt = new Date(Date.now() - 60_000);
    utimesSync(lockPath, staleAt, staleAt);

    bundle.state.turnCount = 1;
    expect(manager.saveState(bundle.state)).toBe(true);
    expect(manager.resume(sid).state.turnCount).toBe(1);
  });

  it("treats a live lock as contention, then saves the same revision after release", () => {
    const storageDir = mkdtempSync(join(tmpdir(), "session-generation-live-lock-"));
    tempDirs.push(storageDir);
    const sid = "live-lock-sid";
    const manager = new SessionManager(storageDir);
    const bundle = manager.create("/tmp/project", "model", "provider", sid);
    const target = join(storageDir, sid, "state.json");
    const release = lockSync(target, { stale: 10_000, retries: 0, realpath: false });

    bundle.state.turnCount = 1;
    expect(manager.saveState(bundle.state)).toBe(false);
    expect(bundle.state.stateRevision).toBe(0);
    release();

    expect(manager.saveState(bundle.state)).toBe(true);
    expect(manager.resume(sid).state.turnCount).toBe(1);
  });
});
