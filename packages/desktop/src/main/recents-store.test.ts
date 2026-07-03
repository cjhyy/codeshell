import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __setRecentsFileForTest,
  loadProjects,
  loadRecents,
  pushRecent,
  setPinned,
  softDelete,
} from "./recents-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recents-"));
  __setRecentsFileForTest(join(dir, "recents.json"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  __setRecentsFileForTest(null);
});

describe("recents-store project source", () => {
  test("softDelete hides project from loadProjects and persists across reload", async () => {
    await pushRecent({ path: dir, name: "a", lastOpenedAt: 1 });
    await softDelete(dir);
    expect((await loadProjects()).find((p) => p.path === dir)).toBeUndefined();
    // simulate restart: loadProjects re-reads the file
    expect((await loadProjects()).find((p) => p.path === dir)).toBeUndefined();
  });

  test("softDelete also hides from loadRecents (so the menu doesn't show it)", async () => {
    await pushRecent({ path: dir, name: "a", lastOpenedAt: 1 });
    await softDelete(dir);
    expect((await loadRecents()).find((p) => p.path === dir)).toBeUndefined();
  });

  test("re-pushing a soft-deleted project un-deletes it", async () => {
    await pushRecent({ path: dir, name: "a", lastOpenedAt: 1 });
    await softDelete(dir);
    await pushRecent({ path: dir, name: "a", lastOpenedAt: 2 });
    expect((await loadProjects()).find((p) => p.path === realpathSync(dir))).toBeDefined();
  });

  test("pinned project survives even when many recents are pushed", async () => {
    await pushRecent({ path: dir, name: "pinme", lastOpenedAt: 1 });
    await setPinned(dir, true);
    for (let i = 0; i < 15; i++) {
      const p = join(dir, `sub${i}`);
      mkdirSync(p, { recursive: true }); // existsSync self-heal needs the dir to exist
      await pushRecent({ path: p, name: `n${i}`, lastOpenedAt: i + 2 });
    }
    const projects = await loadProjects();
    expect(projects.find((p) => p.path === realpathSync(dir))?.pinned).toBe(true);
  });

  test("git subdirectories merge into the repository root", async () => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    const sub = join(dir, "packages", "desktop");
    mkdirSync(sub, { recursive: true });
    await pushRecent({ path: sub, name: "desktop", lastOpenedAt: 1 });
    await pushRecent({ path: dir, name: "root", lastOpenedAt: 2 });
    await setPinned(sub, true);
    const projects = await loadProjects();
    expect(projects).toHaveLength(1);
    const root = realpathSync(dir);
    expect(projects[0]?.path).toBe(root);
    expect(projects[0]?.name).toBe("root");
    expect(projects[0]?.pinned).toBe(true);
  });
});
