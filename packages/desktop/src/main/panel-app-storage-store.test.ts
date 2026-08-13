import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  panelAppStorageKey,
  panelAppStorageQuotaBytes,
  preparePanelAppStorage,
  readPanelAppStorage,
  writePanelAppStorage,
} from "./panel-app-storage-store.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "codeshell-panel-storage-"));
  roots.push(root);
  return { root, file: join(root, "storage", "app.json") };
}

describe("Panel App storage store", () => {
  test("keeps prototype-looking names as ordinary data keys", async () => {
    const { file } = await fixture();
    const storage = Object.create(null) as Record<string, unknown>;
    storage.__proto__ = { safe: true };
    storage.constructor = "data";
    storage.toString = 42;
    await writePanelAppStorage(file, storage, 4096);

    const loaded = await readPanelAppStorage(file, 4096);
    expect(Object.getPrototypeOf(loaded)).toBeNull();
    expect(loaded.__proto__).toEqual({ safe: true });
    expect(loaded.constructor).toBe("data");
    expect(loaded.toString).toBe(42);
  });

  test("rejects linked storage files without touching their targets", async () => {
    const { root, file } = await fixture();
    await mkdir(join(root, "storage"));
    const outside = join(root, "outside.json");
    await writeFile(outside, JSON.stringify({ keep: true }));
    await symlink(outside, file);

    await expect(readPanelAppStorage(file, 4096)).rejects.toThrow(/regular file/);
    await expect(writePanelAppStorage(file, { changed: true }, 4096)).rejects.toThrow(
      /regular file/,
    );
    expect(JSON.parse(await readFile(outside, "utf8"))).toEqual({ keep: true });
  });

  test("rejects a linked namespace directory", async () => {
    const { root, file } = await fixture();
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(root, "storage"));
    await expect(preparePanelAppStorage(file)).rejects.toThrow(/real directory/);
  });

  test("checks the byte quota before reading oversized state", async () => {
    const { root, file } = await fixture();
    await mkdir(join(root, "storage"), { recursive: true });
    await writeFile(file, "x".repeat(1025));
    await expect(readPanelAppStorage(file, 1024)).rejects.toThrow(/bounded/);
  });

  test("validates keys and normalizes configured quotas", () => {
    expect(panelAppStorageKey({ key: "__proto__" })).toBe("__proto__");
    expect(() => panelAppStorageKey({ key: "bad key" })).toThrow(/storage key/);
    expect(() => panelAppStorageQuotaBytes(Number.POSITIVE_INFINITY)).toThrow(/safe integer/);
    expect(panelAppStorageQuotaBytes(100 * 1024 * 1024)).toBe(16 * 1024 * 1024);
  });
});
