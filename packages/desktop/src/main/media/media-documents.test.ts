import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaDocumentStore } from "./media-documents.js";
import { mediaScopeKey } from "./media-storage.js";

let root = "";
const scope = { appId: "video-studio", projectPath: "/project/a" };
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test("documents survive Host restart and retain scoped immutable versions", async () => {
  root = await mkdtemp(join(tmpdir(), "media-documents-"));
  const store = new MediaDocumentStore(root);
  await store.set(scope, "project", { baseRevision: 0, data: { clips: [1] }, label: "Original" });
  await store.set(scope, "project", {
    baseRevision: 1,
    data: { clips: [2] },
    label: "Automatic cut",
  });
  const restored = new MediaDocumentStore(root);
  expect(await restored.get(scope, "project")).toMatchObject({ revision: 2, data: { clips: [2] } });
  expect(await restored.get(scope, "project", 1)).toMatchObject({
    revision: 1,
    data: { clips: [1] },
  });
  expect(await restored.get({ ...scope, projectPath: "/project/b" }, "project")).toEqual({
    revision: 0,
    data: null,
  });
  expect(await restored.versions(scope, "project")).toHaveLength(2);
});

test("concurrent writes reject stale revisions without losing the winning document", async () => {
  root = await mkdtemp(join(tmpdir(), "media-documents-"));
  const store = new MediaDocumentStore(root);
  const results = await Promise.allSettled(
    [1, 2].map((value) => store.set(scope, "project", { baseRevision: 0, data: value })),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect((await store.get(scope, "project")).revision).toBe(1);
  await expect(store.set(scope, "../escape", { baseRevision: 0, data: {} })).rejects.toThrow();
  await expect(
    store.set(scope, "project", { baseRevision: 1, data: "x".repeat(3 * 1024 * 1024) }),
  ).rejects.toThrow();
  expect((await store.get(scope, "project")).revision).toBe(1);
});

test("queued document writes snapshot revision, label and data before yielding", async () => {
  root = await mkdtemp(join(tmpdir(), "media-documents-"));
  const store = new MediaDocumentStore(root);
  const input = { baseRevision: 0, data: { clips: [1] }, label: "Original" };
  const pending = store.set(scope, "project", input);
  input.baseRevision = 99;
  input.label = "Mutated";
  input.data.clips.push(2);
  expect(await pending).toMatchObject({ revision: 1, label: "Original" });
  expect(await store.get(scope, "project")).toMatchObject({ revision: 1, data: { clips: [1] } });
});

test("corrupt history ordering and metadata are preserved rather than silently rewritten", async () => {
  root = await mkdtemp(join(tmpdir(), "media-documents-"));
  const store = new MediaDocumentStore(root);
  await store.set(scope, "project", { baseRevision: 0, data: "original" });
  const path = join(root, "scopes", mediaScopeKey(scope), "documents", "project", "index.json");
  const initial = JSON.parse(await readFile(path, "utf8"));
  for (const corrupt of [
    { versions: [initial.versions[0], initial.versions[0]] },
    { versions: [{ ...initial.versions[0], updatedAt: -1 }] },
    { versions: [{ ...initial.versions[0], label: "x".repeat(201) }] },
    { versions: [{ ...initial.versions[0], privatePath: "/private/file" }] },
  ]) {
    const serialized = JSON.stringify(corrupt);
    await writeFile(path, serialized);
    await expect(store.get(scope, "project")).rejects.toThrow("preserved");
    await expect(
      store.set(scope, "project", { baseRevision: 1, data: "overwrite" }),
    ).rejects.toThrow("preserved");
    expect(await readFile(path, "utf8")).toBe(serialized);
  }
});

test("history retains twenty versions with isolated revision lookup", async () => {
  root = await mkdtemp(join(tmpdir(), "media-documents-"));
  const store = new MediaDocumentStore(root);
  for (let revision = 0; revision < 22; revision++)
    await store.set(scope, "project", { baseRevision: revision, data: revision + 1 });
  const versions = await store.versions(scope, "project");
  expect(versions.map((v) => v.revision)).toEqual(
    Array.from({ length: 20 }, (_, index) => 22 - index),
  );
  expect(await store.get(scope, "project", 3)).toMatchObject({ data: 3 });
  await expect(store.get(scope, "project", 2)).rejects.toThrow("not found");
  await expect(store.get(scope, "project", 0)).rejects.toThrow("Invalid");
});
