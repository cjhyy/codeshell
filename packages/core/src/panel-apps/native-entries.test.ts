import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PanelAppManifest } from "./manifest.js";
import { previewLocalPanelApp } from "./installer.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const source = "console.log('reviewed native tool');";
const sha256 = createHash("sha256").update(source).digest("hex");
function manifest() {
  return {
    schemaVersion: 2,
    id: "native-entry-test",
    version: "1.0.0",
    title: { default: "Native test" },
    entry: "app/index.html",
    permissions: ["process", "resources", "context.workspace"],
    nativeEntries: { sample: { entry: "app/tools/sample.mjs", sha256 } },
  };
}
async function fixture(value: unknown = manifest()) {
  const root = await mkdtemp(join(tmpdir(), "panel-native-review-"));
  roots.push(root);
  await mkdir(join(root, ".codeshell-panel"));
  await mkdir(join(root, "app/tools"), { recursive: true });
  await writeFile(join(root, ".codeshell-panel/panel.json"), JSON.stringify(value));
  await writeFile(join(root, "app/index.html"), "<!doctype html><title>Test</title>");
  await writeFile(join(root, "app/tools/sample.mjs"), source);
  return root;
}
test("review preserves a declared native entry and its content digest", async () => {
  const root = await fixture();
  const preview = await previewLocalPanelApp({ kind: "dir", path: root });
  expect(preview.nativeEntries).toEqual(manifest().nativeEntries);
  expect(preview.permissions).toContain("resources");
});
test("review rejects tampered and missing native tool bytes", async () => {
  const root = await fixture();
  await writeFile(join(root, "app/tools/sample.mjs"), "console.log('unreviewed')");
  await expect(previewLocalPanelApp({ kind: "dir", path: root })).rejects.toThrow("hash");
  await rm(join(root, "app/tools/sample.mjs"));
  await expect(previewLocalPanelApp({ kind: "dir", path: root })).rejects.toThrow("missing");
});
test("native declarations require process permission and reject path traversal", () => {
  expect(PanelAppManifest.safeParse({ ...manifest(), permissions: [] }).success).toBe(false);
  for (const entry of [
    "../native.mjs",
    "app/tools/../sample.mjs",
    "app/tools/sample.ts",
    "/app/tools/sample.mjs",
  ])
    expect(
      PanelAppManifest.safeParse({ ...manifest(), nativeEntries: { sample: { entry, sha256 } } })
        .success,
    ).toBe(false);
  expect(PanelAppManifest.safeParse({ ...manifest(), permissions: ["resources"] }).success).toBe(
    false,
  );
});
test("direct read of originals is a separate grant that needs resources and process", () => {
  const permissions = ["process", "resources", "context.workspace", "resources.directRead"];
  expect(PanelAppManifest.safeParse({ ...manifest(), permissions }).success).toBe(true);
  for (const missing of ["process", "resources"]) {
    const { nativeEntries: _entries, ...plain } = manifest();
    expect(
      PanelAppManifest.safeParse({
        ...plain,
        permissions: permissions.filter((permission) => permission !== missing),
      }).success,
    ).toBe(false);
  }
});

test("background services are strict, permission-gated, bounded reviewed entry declarations", async () => {
  const backgroundServices = {
    feed: {
      entry: "sample",
      channels: { quotes: { maxBytes: 262144 } },
      maxLifetimeMs: 60_000,
      idleGraceMs: 5000,
    },
  };
  const value = {
    ...manifest(),
    permissions: [...manifest().permissions, "background.services"],
    backgroundServices,
  };
  expect(PanelAppManifest.safeParse(value).success).toBe(true);
  for (const missing of ["process", "background.services", "context.workspace"])
    expect(
      PanelAppManifest.safeParse({
        ...value,
        permissions: value.permissions.filter((permission) => permission !== missing),
      }).success,
    ).toBe(false);
  for (const service of [
    { ...backgroundServices.feed, entry: "missing" },
    { ...backgroundServices.feed, channels: {} },
    { ...backgroundServices.feed, maxLifetimeMs: 21_600_001 },
    { ...backgroundServices.feed, unknown: true },
  ])
    expect(
      PanelAppManifest.safeParse({ ...value, backgroundServices: { feed: service } }).success,
    ).toBe(false);
  const preview = await previewLocalPanelApp({ kind: "dir", path: await fixture(value) });
  expect(preview.backgroundServices).toEqual(backgroundServices);
});

test("background service cannot resolve an inherited Object constructor as a reviewed entry", () => {
  expect(
    PanelAppManifest.safeParse({
      ...manifest(),
      nativeEntries: {},
      permissions: [...manifest().permissions, "background.services"],
      backgroundServices: {
        feed: {
          entry: "constructor",
          channels: { quotes: { maxBytes: 1024 } },
          maxLifetimeMs: 60000,
          idleGraceMs: 0,
        },
      },
    }).success,
  ).toBe(false);
});
