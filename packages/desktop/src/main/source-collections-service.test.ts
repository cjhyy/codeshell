import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSourceDefinition } from "@cjhyy/code-shell-core/internal";
import { createSourceCollectionService } from "./source-collections-service.js";
import { bind, catalogDelete, catalogSave, unbind, workspaceAccess } from "./sources-service.js";

let home: string;
let previous: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-collections-"));
  previous = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = join(home, "state");
});
afterEach(() => {
  if (previous === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});
const file = (name = "brief.md", body = "shared content") => {
  const path = join(home, name);
  writeFileSync(path, body);
  return path;
};
function fixture() {
  let paths: string[] | null = [];
  let active = true;
  let pick: undefined | (() => Promise<string[] | null>);
  const api = createSourceCollectionService({
    assertCurrent: () => {
      if (!active) throw new Error("owner revoked");
    },
    pick: async () => (pick ? pick() : paths),
    references: async () => [{ projectId: "first", name: "First project" }],
  });
  return {
    api,
    select: (next: string[] | null) => {
      paths = next;
    },
    revoke: () => {
      active = false;
    },
    delayPicker: (next: () => Promise<string[] | null>) => {
      pick = next;
    },
  };
}

test("native selection keeps original files and reusable stable entry ids", async () => {
  const f = fixture();
  let collection = await f.api.create({ label: "Shared docs" });
  const path = file();
  f.select([path]);
  collection = (await f.api.pick(collection.definition.id, collection.revision, "files"))!;
  expect(collection.entries[0]?.status).toBe("ready");
  const entry = collection.entries[0]!.entry;
  expect(entry.kind).toBe("local");
  expect(entry.kind === "local" && readFileSync(entry.path, "utf8")).toBe("shared content");
  const repeated = (await f.api.pick(collection.definition.id, collection.revision, "files"))!;
  expect(repeated.entries).toHaveLength(1);
  expect(repeated.entries[0]!.entry.id).toBe(entry.id);
  expect(repeated.revision).not.toBe(collection.revision);
  expect(existsSync(join(home, ".code-shell", "uploads"))).toBe(false);
});

test("two projects bind different explicit files; adding a file does not widen either", async () => {
  const f = fixture();
  let c = await f.api.create({ label: "Shared" });
  f.select([file("one.txt"), file("two.txt")]);
  c = (await f.api.pick(c.definition.id, c.revision, "files"))!;
  const first = join(home, "project-one"),
    second = join(home, "project-two");
  mkdirSync(first);
  mkdirSync(second);
  bind(first, { sourceId: c.definition.id, scopes: [c.entries[0]!.entry.id], readPolicy: "ask" });
  bind(second, {
    sourceId: c.definition.id,
    scopes: c.entries.map(({ entry }) => entry.id),
    readPolicy: "ask",
  });
  f.select([file("three.txt")]);
  const updated = (await f.api.pick(c.definition.id, c.revision, "files"))!;
  expect(updated.entries).toHaveLength(3);
  expect(workspaceAccess(first).bindings[0]!.scopes).toEqual([c.entries[0]!.entry.id]);
  expect(workspaceAccess(second).bindings[0]!.scopes).toHaveLength(2);
  unbind(first, c.definition.id);
  expect(workspaceAccess(second).bindings).toHaveLength(1);
  expect(readSourceDefinition(c.definition.id)).toBeDefined();
  expect(existsSync(join(home, "one.txt"))).toBe(true);
});

test("directory selection snapshots current non-hidden regular files", async () => {
  const f = fixture();
  const folder = join(home, "folder");
  mkdirSync(folder);
  mkdirSync(join(folder, "nested"));
  writeFileSync(join(folder, "nested", "a.txt"), "a");
  writeFileSync(join(folder, ".hidden"), "hidden");
  if (process.platform !== "win32") symlinkSync(file("outside.txt"), join(folder, "alias.txt"));
  let c = await f.api.create({ label: "Folder" });
  f.select([folder]);
  c = (await f.api.pick(c.definition.id, c.revision, "folder"))!;
  expect(c.entries.map(({ entry }) => entry.relativePath)).toEqual(["nested/a.txt"]);
  writeFileSync(join(folder, "new.txt"), "new");
  expect((await f.api.get(c.definition.id)).entries).toHaveLength(1);
  const next = (await f.api.pick(c.definition.id, c.revision, "folder"))!;
  expect(next.entries).toHaveLength(2);
  expect(next.entries.find(({ entry }) => entry.name === "a.txt")!.entry.id).toBe(
    c.entries[0]!.entry.id,
  );
});

test("cancelled native selection makes no revision or catalog change", async () => {
  const f = fixture(),
    c = await f.api.create({ label: "Cancel" });
  f.select(null);
  expect(await f.api.pick(c.definition.id, c.revision, "files")).toBeNull();
  expect((await f.api.get(c.definition.id)).revision).toBe(c.revision);
});

test("stale review including pending picker cannot overwrite newer metadata", async () => {
  const f = fixture(),
    c = await f.api.create({ label: "Old" });
  let finish!: (paths: string[]) => void;
  f.delayPicker(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.api.pick(c.definition.id, c.revision, "files");
  const newer = await f.api.update(c.definition.id, c.revision, {
    kind: "metadata",
    label: "New",
    enabled: true,
  });
  finish([file()]);
  await expect(pending).rejects.toThrow("更新");
  await expect(f.api.delete(c.definition.id, c.revision)).rejects.toThrow("更新");
  expect((await f.api.get(c.definition.id)).revision).toBe(newer.revision);
});

test("revoked owner after picker completion performs zero writes", async () => {
  const f = fixture(),
    c = await f.api.create({ label: "Owner" });
  f.delayPicker(async () => {
    f.revoke();
    return [file()];
  });
  await expect(f.api.pick(c.definition.id, c.revision, "files")).rejects.toThrow("owner revoked");
  expect(readSourceDefinition(c.definition.id)!.adapterConfig.revision).toBe(c.revision);
});

test("changed/missing statuses and explicit refresh preserve selected id", async () => {
  const f = fixture();
  let c = await f.api.create({ label: "Versions" });
  const path = file();
  f.select([path]);
  c = (await f.api.pick(c.definition.id, c.revision, "files"))!;
  writeFileSync(path, "updated document contents");
  expect((await f.api.get(c.definition.id)).entries[0]!.status).toBe("changed");
  const updated = await f.api.update(c.definition.id, c.revision, {
    kind: "refresh",
    entryId: c.entries[0]!.entry.id,
  });
  expect(updated.entries[0]!.entry.id).toBe(c.entries[0]!.entry.id);
  expect(updated.entries[0]!.status).toBe("ready");
  rmSync(path);
  expect((await f.api.get(c.definition.id)).entries[0]!.status).toBe("missing");
  await expect(
    f.api.update(c.definition.id, updated.revision, {
      kind: "refresh",
      entryId: c.entries[0]!.entry.id,
    }),
  ).rejects.toThrow();
  expect((await f.api.get(c.definition.id)).revision).toBe(updated.revision);
});

test("remove/delete expose references and never remove originals or project bindings", async () => {
  const f = fixture();
  let c = await f.api.create({ label: "Keep" });
  const path = file();
  f.select([path]);
  c = (await f.api.pick(c.definition.id, c.revision, "files"))!;
  expect(c.references).toEqual([{ projectId: "first", name: "First project" }]);
  const project = join(home, "project");
  mkdirSync(project);
  bind(project, { sourceId: c.definition.id, scopes: [c.entries[0]!.entry.id], readPolicy: "ask" });
  const removed = await f.api.update(c.definition.id, c.revision, {
    kind: "remove",
    entryId: c.entries[0]!.entry.id,
  });
  expect(removed.entries).toHaveLength(0);
  expect(existsSync(path)).toBe(true);
  await f.api.delete(c.definition.id, removed.revision);
  expect(existsSync(path)).toBe(true);
  expect(workspaceAccess(project).bindings).toHaveLength(1);
  expect(workspaceAccess(project).access[0]!.status).toBe("dangling");
});

test("generic catalog cannot replace, forge or delete a Desktop collection", async () => {
  const f = fixture(),
    c = await f.api.create({ label: "Private native custody" });
  expect(() => catalogSave(c.definition)).toThrow("资料集");
  expect(() => catalogSave({ ...c.definition, kind: "mock" })).toThrow("资料集");
  expect(() => catalogDelete(c.definition.id)).toThrow("资料集");
  expect(() => catalogSave({ ...c.definition, id: "forged" })).toThrow("资料集");
  expect(readSourceDefinition(c.definition.id)).toEqual(c.definition);
});

test("oversized file selection is atomic and symlink refresh cannot change target", async () => {
  const f = fixture(),
    c = await f.api.create({ label: "Bounded" });
  const huge = file("huge.txt");
  truncateSync(huge, 20 * 1024 * 1024 + 1);
  f.select([file(), huge]);
  await expect(f.api.pick(c.definition.id, c.revision, "files")).rejects.toThrow("20 MB");
  expect((await f.api.get(c.definition.id)).entries).toHaveLength(0);
  if (process.platform === "win32") return;
  const path = file("selected.txt");
  f.select([path]);
  const selected = (await f.api.pick(c.definition.id, c.revision, "files"))!;
  rmSync(path);
  symlinkSync(file("target.txt"), path);
  await expect(
    f.api.update(c.definition.id, selected.revision, {
      kind: "refresh",
      entryId: selected.entries[0]!.entry.id,
    }),
  ).rejects.toThrow();
  expect((await f.api.get(c.definition.id)).revision).toBe(selected.revision);
});

test("missing mutation revision cannot bypass optimistic concurrency", async () => {
  const f = fixture(),
    c = await f.api.create({ label: "CAS" });
  await expect(
    f.api.update(c.definition.id, undefined as unknown as string, {
      kind: "metadata",
      label: "Bypass",
      enabled: true,
    }),
  ).rejects.toThrow();
  await expect(f.api.delete(c.definition.id, undefined as unknown as string)).rejects.toThrow();
  expect((await f.api.get(c.definition.id)).definition.label).toBe("CAS");
});
