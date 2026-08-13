import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readInstalledPanelAppsRegistry,
  upsertInstalledPanelAppRecord,
} from "./registry.js";
import { panelAppsRegistryPath } from "./paths.js";

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "codeshell-panel-registry-"));
  previousHome = process.env.HOME;
  process.env.HOME = root;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

const record = {
  id: "safe-app",
  version: "1.0.0",
  source: "marketplace",
  installedAt: "2026-08-13T00:00:00.000Z",
  lastUpdated: "2026-08-13T00:00:00.000Z",
};

describe("Panel App registry persistence", () => {
  test("round-trips a bounded owner-only registry", async () => {
    await upsertInstalledPanelAppRecord(record);
    expect(await readInstalledPanelAppsRegistry()).toEqual([record]);
  });

  test("reads corrupt JSON as empty but refuses to overwrite it", async () => {
    const path = panelAppsRegistryPath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{broken");
    expect(await readInstalledPanelAppsRegistry()).toEqual([]);
    await expect(upsertInstalledPanelAppRecord(record)).rejects.toThrow(/corrupt/);
    expect(await readFile(path, "utf8")).toBe("{broken");
  });

  test("rejects linked registry files without touching their targets", async () => {
    const path = panelAppsRegistryPath();
    await mkdir(join(path, ".."), { recursive: true });
    const outside = join(root, "outside.json");
    await writeFile(outside, JSON.stringify({ keep: true }));
    await symlink(outside, path);
    await expect(readInstalledPanelAppsRegistry()).rejects.toThrow(/bounded regular file/);
    await expect(upsertInstalledPanelAppRecord(record)).rejects.toThrow(/bounded regular file/);
    expect(JSON.parse(await readFile(outside, "utf8"))).toEqual({ keep: true });
  });

  test("rejects an oversized registry before parsing", async () => {
    const path = panelAppsRegistryPath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "x".repeat(4 * 1024 * 1024 + 1));
    await expect(readInstalledPanelAppsRegistry()).rejects.toThrow(/bounded regular file/);
  });
});
