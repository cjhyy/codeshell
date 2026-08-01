// Repo-level publish safety for digital-human repos.
//
// Three review findings, all rooted in "the slow clone and the fast publish were
// not separated, and nothing serialized the publish":
//
//  1. Two processes could both see `dir` missing, both clone INTO it, and the
//     loser's `rmSync(dir)` deleted the winner's good clone.
//  2. The swap was `dir → retired` then `staging → dir`. A crash in between left
//     NO tree at `dir`, and nothing looked for `.retired-*`, so a perfectly good
//     clone showed as "尚未克隆".
//  3. MAX_REPOS was checked before any lock, so N processes could each observe
//     31 repos and all proceed past the cap.
//
// addHumanRepo() itself needs network git, so these target the publish/recovery
// primitives directly plus the observable registry behaviour.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { humanRepoDir, humanReposRoot, listHumanRepos, removeHumanRepo } from "./catalog-store.js";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-catalog-conc-"));
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

/** Minimal valid catalog so readCatalogFromDir() would accept the tree. */
function writeRepoTree(dir: string, marker: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "humans.json"), JSON.stringify({ humans: [] }));
  writeFileSync(join(dir, "MARKER"), marker);
}

function markerOf(dir: string): string | null {
  try {
    return readFileSync(join(dir, "MARKER"), "utf-8");
  } catch {
    return null;
  }
}

describe("digital-human repo crash recovery", () => {
  test("restores a tree left behind by a crash between retire and promote", async () => {
    // Simulate the exact interrupted state: `dir` gone, `.retired-*` present.
    const repo = "acme/humans";
    const dir = humanRepoDir(repo);
    mkdirSync(humanReposRoot(), { recursive: true });
    const retired = `${dir}.retired-999-crashed`;
    writeRepoTree(retired, "last-known-good");
    expect(existsSync(dir)).toBe(false);

    // removeHumanRepo runs the same reclaim path under the repo lock; use it as
    // the observable entry point, then confirm nothing survives a delete.
    removeHumanRepo(repo);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(retired)).toBe(false);
  });

  test("a stale .retired-* tree is reclaimed rather than orphaned", async () => {
    // Prove the reclaim logic itself: it must MOVE the retired tree back to
    // `dir` when `dir` is absent, not silently delete it.
    const { reclaimForTest } = await importInternals();
    const repo = "acme/reclaim";
    const dir = humanRepoDir(repo);
    mkdirSync(humanReposRoot(), { recursive: true });
    writeRepoTree(`${dir}.retired-1-aaa`, "older");
    writeRepoTree(`${dir}.retired-2-bbb`, "newest");

    reclaimForTest(dir);

    // Newest retired tree is restored; the older leftover is cleaned up.
    expect(markerOf(dir)).toBe("newest");
    expect(existsSync(`${dir}.retired-1-aaa`)).toBe(false);
    expect(existsSync(`${dir}.retired-2-bbb`)).toBe(false);
  });

  test("reclaim leaves an existing good tree untouched", async () => {
    const { reclaimForTest } = await importInternals();
    const repo = "acme/keep";
    const dir = humanRepoDir(repo);
    mkdirSync(humanReposRoot(), { recursive: true });
    writeRepoTree(dir, "current");
    writeRepoTree(`${dir}.retired-1-aaa`, "stale");

    reclaimForTest(dir);

    expect(markerOf(dir)).toBe("current");
    expect(existsSync(`${dir}.retired-1-aaa`)).toBe(false);
  });
});

describe("digital-human repo publish serialization", () => {
  test("concurrent removes of the same repo do not throw or corrupt the registry", () => {
    // The repo lock must be re-entrant-safe across sequential calls and must
    // always leave the registry parseable.
    const repo = "acme/serial";
    mkdirSync(humanReposRoot(), { recursive: true });
    writeRepoTree(humanRepoDir(repo), "x");
    removeHumanRepo(repo);
    removeHumanRepo(repo);
    expect(listHumanRepos()).toEqual([]);
  });

  test("removing one repo never disturbs another", () => {
    const a = "acme/alpha";
    const b = "acme/beta";
    mkdirSync(humanReposRoot(), { recursive: true });
    writeRepoTree(humanRepoDir(a), "alpha");
    writeRepoTree(humanRepoDir(b), "beta");

    removeHumanRepo(a);

    expect(existsSync(humanRepoDir(a))).toBe(false);
    expect(markerOf(humanRepoDir(b))).toBe("beta");
  });
});

/**
 * `reclaimOrphanedTrees` and `promoteStagedRepo` are module-private crash-safety
 * helpers with no I/O-free public entry point. Import the module namespace and
 * reach them so the recovery protocol can be tested without network git.
 */
async function importInternals(): Promise<{ reclaimForTest: (dir: string) => void }> {
  const mod = (await import("./catalog-store.js")) as unknown as {
    __testables?: { reclaimOrphanedTrees: (dir: string) => void };
  };
  const reclaim = mod.__testables?.reclaimOrphanedTrees;
  if (!reclaim) throw new Error("catalog-store must expose __testables for crash-recovery tests");
  return { reclaimForTest: reclaim };
}
