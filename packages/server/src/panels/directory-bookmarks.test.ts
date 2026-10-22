import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { installLocalNetworkGuard } from "../../../../scripts/runtime-cost-smoke-isolation.mjs";

if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME)
  throw new Error("Private HOME required");
const originalFetch = globalThis.fetch;
const originals = [http.request, http.get, https.request, https.get];
const marker = Symbol.for("codeshell.cost-smoke.network-guard");
const previousMarker = Object.getOwnPropertyDescriptor(globalThis, marker);
installLocalNetworkGuard("http://127.0.0.1:9");
expect(() => fetch("https://panel-bookmark.invalid/")).toThrow("non-fixture");
expect(() => http.get("http://127.0.0.1:8/")).toThrow("non-fixture");
afterAll(() => {
  globalThis.fetch = originalFetch;
  [http.request, http.get, https.request, https.get] = originals;
  if (previousMarker) Object.defineProperty(globalThis, marker, previousMarker);
  else delete (globalThis as any)[marker];
  syncBuiltinESMExports();
});

const { hubPanelDirectoryBookmarks, PanelAppDirectoryBookmarks } =
  await import("./directory-bookmarks.js");
const { acquireFileLock } = await import("@cjhyy/code-shell-core/internal");

test("Hub directory bookmarks and mutex stay in the writable data volume", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "panel-bookmark-volume-")));
  const data = join(root, "data"),
    project = join(data, "workspace");
  await mkdir(project, { recursive: true });
  const legacy = new PanelAppDirectoryBookmarks(join(data, "panel-web-directory-bookmarks.json"));
  const previous = legacy.remember("download", project, project);
  // Model /data as the writable mount under a read-only container filesystem.
  await chmod(root, 0o555);
  try {
    const current = hubPanelDirectoryBookmarks(data);
    expect(current.restore("download", project, previous)).toBe(project);
    expect(current.remember("download", project, project)).toBe(previous);
    const restarted = hubPanelDirectoryBookmarks(data);
    expect(restarted.restore("download", project, previous)).toBe(project);
    expect(() => restarted.restore("other-panel", project, previous)).toThrow();
    expect(
      JSON.parse(await readFile(join(data, "panel-directories", "bookmarks.json"), "utf8"))
        .bookmarks,
    ).toHaveLength(1);
  } finally {
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

async function bookmarkFixture(run: (root: string, file: string, chosen: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "panel-bookmark-identity-")));
  const chosen = join(root, "output");
  await mkdir(chosen);
  try {
    await run(root, join(root, "bookmarks.json"), chosen);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Execute the production module with a local filesystem adapter. This models
// Windows IDs on every CI platform without mocking node:fs for other tests.
function withLargeIdentity(chosen: string, identity: { dev: bigint; ino: bigint }) {
  const source = fs.readFileSync(new URL("./directory-bookmarks.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const require = createRequire(import.meta.url);
  const exports: { PanelAppDirectoryBookmarks?: typeof PanelAppDirectoryBookmarks } = {};
  runInNewContext(compiled, {
    exports,
    Buffer,
    process,
    require(name: string) {
      if (name === "./hub-binding.js") return {};
      if (name === "@cjhyy/code-shell-core/internal") return { acquireFileLock };
      if (name !== "node:fs") return require(name);
      return {
        ...fs,
        lstatSync(path: string, options?: { bigint?: boolean }) {
          const info = fs.lstatSync(path, options as { bigint: true });
          if (path !== chosen) return info;
          expect(options?.bigint).toBe(true);
          return Object.assign(Object.create(Object.getPrototypeOf(info)), info, identity);
        },
      };
    },
  });
  return exports.PanelAppDirectoryBookmarks!;
}

test("large Windows directory IDs survive restart and distinguish rounded numeric collisions", async () => {
  await bookmarkFixture(async (root, file, chosen) => {
    const identity = { dev: 18_446_744_073_709_551_614n, ino: 9_007_199_254_740_992n };
    const Store = withLargeIdentity(chosen, identity);
    const id = new Store(file).remember("download", root, chosen);
    const document = JSON.parse(await readFile(file, "utf8"));
    expect(document.version).toBe(2);
    expect(document.bookmarks[0].dev).toBe(identity.dev.toString());
    expect(document.bookmarks[0].ino).toBe(identity.ino.toString());
    expect(new Store(file).restore("download", root, id)).toBe(chosen);
    expect(new Store(file).remember("download", root, chosen)).toBe(id);
    identity.ino++;
    expect(Number(identity.ino)).toBe(Number(identity.ino - 1n));
    expect(() => new Store(file).restore("download", root, id)).toThrow(/changed/);
    const renewed = new Store(file).remember("download", root, chosen);
    expect(renewed).not.toBe(id);
    expect(new Store(file).restore("download", root, renewed)).toBe(chosen);
    expect(() => new Store(file).restore("other-panel", root, renewed)).toThrow(/unavailable/);
    expect(() => new Store(file).restore("download", join(root, "other"), renewed)).toThrow(
      /unavailable/,
    );
  });
});

test("safe numeric v1 grants keep their UUID when migrated to exact v2 identities", async () => {
  await bookmarkFixture(async (root, file, chosen) => {
    const id = new PanelAppDirectoryBookmarks(file).remember("download", root, chosen);
    const document = JSON.parse(await readFile(file, "utf8"));
    document.version = 1;
    for (const record of document.bookmarks) {
      record.dev = Number(record.dev);
      record.ino = Number(record.ino);
    }
    await writeFile(file, JSON.stringify(document));
    expect(new PanelAppDirectoryBookmarks(file).restore("download", root, id)).toBe(chosen);
    expect(new PanelAppDirectoryBookmarks(file).remember("download", root, chosen)).toBe(id);
    const migrated = JSON.parse(await readFile(file, "utf8"));
    expect(migrated.version).toBe(2);
    expect(typeof migrated.bookmarks[0].ino).toBe("string");
    expect(new PanelAppDirectoryBookmarks(file).restore("download", root, id)).toBe(chosen);
  });
});

test.each(["dev", "ino"])(
  "unsafe v1 %s revokes only that grant and cannot fall back to its legacy UUID",
  async (field) => {
    await bookmarkFixture(async (root, file, chosen) => {
      const store = new PanelAppDirectoryBookmarks(file);
      const badId = store.remember("download", root, chosen);
      const safeId = store.remember("other-panel", root, root);
      const document = JSON.parse(await readFile(file, "utf8"));
      document.version = 1;
      for (const record of document.bookmarks) {
        record.dev = Number(record.dev);
        record.ino = Number(record.ino);
      }
      const legacyFile = join(root, "legacy.json");
      await writeFile(legacyFile, JSON.stringify(document));
      document.bookmarks.find((record: { id: string }) => record.id === badId)[field] =
        Number.MAX_SAFE_INTEGER + 1;
      await writeFile(file, JSON.stringify(document));
      const current = new PanelAppDirectoryBookmarks(file, { legacyFiles: [legacyFile] });
      expect(() => current.restore("download", root, badId)).toThrow(/choose it again/);
      expect(current.restore("other-panel", root, safeId)).toBe(root);
      current.remember("other-panel", root, root);
      const renewed = current.remember("download", root, chosen);
      expect(renewed).not.toBe(badId);
      expect(current.remember("download", root, chosen)).toBe(renewed);
      const restarted = new PanelAppDirectoryBookmarks(file, { legacyFiles: [legacyFile] });
      expect(() => restarted.restore("download", root, badId)).toThrow(/choose it again/);
      expect(restarted.restore("download", root, renewed)).toBe(chosen);
      expect(restarted.restore("other-panel", root, safeId)).toBe(root);
      const tombstone = JSON.parse(await readFile(file, "utf8")).bookmarks.find(
        (record: { id: string }) => record.id === badId,
      );
      expect(tombstone.dev).toBeNull();
      expect(tombstone.ino).toBeNull();
    });
  },
);

test.each(["-1", "1e16", " 123", "01", "1".repeat(21), null, 123])(
  "malformed v2 directory identity %s is still rejected",
  async (value) => {
    await bookmarkFixture(async (root, file, chosen) => {
      const id = new PanelAppDirectoryBookmarks(file).remember("download", root, chosen);
      const document = JSON.parse(await readFile(file, "utf8"));
      document.bookmarks[0].ino = value;
      await writeFile(file, JSON.stringify(document));
      expect(() => new PanelAppDirectoryBookmarks(file).restore("download", root, id)).toThrow(
        /Invalid Panel directory bookmarks/,
      );
    });
  },
);

test("bounded-store eviction preserves revocations ahead of live grants", async () => {
  await bookmarkFixture(async (root, file, chosen) => {
    const store = new PanelAppDirectoryBookmarks(file);
    store.remember("download", root, chosen);
    const document = JSON.parse(await readFile(file, "utf8"));
    const template = document.bookmarks[0];
    document.bookmarks = Array.from({ length: 256 }, (_, index) => ({
      ...template,
      id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    }));
    const revoked = document.bookmarks[255];
    const legacyFile = join(root, "legacy.json");
    await writeFile(legacyFile, JSON.stringify({ version: 2, bookmarks: [{ ...revoked }] }));
    revoked.dev = revoked.ino = null;
    await writeFile(file, JSON.stringify(document));
    const current = new PanelAppDirectoryBookmarks(file, { legacyFiles: [legacyFile] });
    const fresh = current.remember("fresh-panel", root, chosen);
    const restarted = new PanelAppDirectoryBookmarks(file, { legacyFiles: [legacyFile] });
    expect(restarted.restore("fresh-panel", root, fresh)).toBe(chosen);
    expect(() => restarted.restore("download", root, revoked.id)).toThrow(/choose it again/);
    expect(JSON.parse(await readFile(file, "utf8")).bookmarks).toHaveLength(256);
  });
});
