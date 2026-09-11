import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCatalogStore } from "./session-catalog-store";
import type { SessionSummary } from "../shared/session-catalog";

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-session-catalog-"));
  directories.push(directory);
  const file = join(directory, "session-catalog.json");
  return { directory, file, store: new SessionCatalogStore({ file, now: () => 1000 }) };
}
function row(id = "session.1", extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, title: "501058 看一下 这个基金后续变化", createdAt: 1, updatedAt: 2, ...extra };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("SessionCatalogStore", () => {
  test("migrates every legacy project once, backs it up, and preserves canonical choices", async () => {
    const { file, store } = fixture();
    await store.apply({
      projectKey: "investment",
      upserts: [
        { id: "session.1", values: row("session.1", { title: "manual", titleManual: true }) },
      ],
      activeSessionId: null,
    });
    const legacy = {
      investment: {
        sessions: [row("session.1", { pinned: true }), row("session.2")],
        activeSessionId: "session.1",
      },
      __no_repo__: { sessions: [row("loose")], activeSessionId: "loose" },
      removed: {
        sessions: [row("archived", { archived: true })],
        activeSessionId: "archived",
        deletedProjectLabel: "Old project",
      },
    };
    const migrated = await store.importLegacy(legacy);
    expect(migrated.revision).toBe(2);
    expect(migrated.indices.investment.sessions).toEqual([
      row("session.1", { title: "manual", titleManual: true }),
      row("session.2"),
    ]);
    expect(migrated.indices.investment.activeSessionId).toBeNull();
    expect(migrated.indices.removed.activeSessionId).toBeNull();
    const committed = JSON.parse(readFileSync(file, "utf8"));
    expect(committed.legacyMigration.completedAt).toBe(1000);
    const backup = JSON.parse(readFileSync(committed.legacyMigration.backupFile, "utf8"));
    expect(backup.indices.investment.sessions[0].pinned).toBe(true);
    await store.apply({ projectKey: "investment", deletedSessionIds: ["session.2"] });
    const reopened = new SessionCatalogStore({ file });
    const after = await reopened.importLegacy(legacy);
    expect(after.revision).toBe(3);
    expect(after.indices.investment.sessions.map((entry) => entry.id)).toEqual(["session.1"]);
  });

  test("merges concurrent windows field by field, reloads other writers, and persists drafts", async () => {
    const { file, store } = fixture();
    const otherWindow = new SessionCatalogStore({ file });
    await store.apply({ projectKey: "p", upserts: [{ id: "s", values: row("s") }] });
    await Promise.all([
      store.apply({
        projectKey: "p",
        upserts: [{ id: "s", values: { title: "renamed", titleManual: true } }],
      }),
      otherWindow.apply({
        projectKey: "p",
        upserts: [{ id: "s", values: { pinned: true, engineSessionId: "engine.s" } }],
      }),
      store.apply({
        projectKey: "p",
        upserts: [{ id: "second", values: row("second", { updatedAt: 10 }) }],
        activeSessionId: "second",
      }),
    ]);
    const loaded = await store.load();
    expect(loaded.indices.p.sessions[0].id).toBe("second");
    expect(loaded.indices.p.sessions[1]).toMatchObject({
      title: "renamed",
      titleManual: true,
      pinned: true,
      engineSessionId: "engine.s",
    });
    await otherWindow.apply({
      projectKey: "p",
      activeSessionId: null,
      upserts: [{ id: "s", values: {}, removeFields: ["pinned"] }],
    });
    expect((await store.load()).indices.p.activeSessionId).toBeNull();
    expect((await store.load()).indices.p.sessions[1]).not.toHaveProperty("pinned");
  });

  test("tombstones fence late patches and pre-migration stale rows", async () => {
    const { file, store } = fixture();
    await store.apply({
      projectKey: "p",
      upserts: [{ id: "s", values: row("s") }],
      activeSessionId: "s",
    });
    await store.apply({ projectKey: "p", deletedSessionIds: ["s"] });
    const after = await store.apply({
      projectKey: "p",
      upserts: [{ id: "s", values: { pinned: true } }],
    });
    expect(after.indices.p).toEqual({ sessions: [], activeSessionId: null });
    const imported = await new SessionCatalogStore({ file }).importLegacy({
      p: { sessions: [row("s")], activeSessionId: "s" },
    });
    expect(imported.indices.p.sessions).toEqual([]);
  });

  test("failed writes never publish success and leave the queue usable", async () => {
    const { file, store } = fixture();
    await store.importLegacy({ p: { sessions: [row()], activeSessionId: null } });
    const original = readFileSync(file, "utf8");
    const published: number[] = [];
    store.onChanged((snapshot) => published.push(snapshot.revision));
    rmSync(file);
    mkdirSync(file);
    await expect(
      store.apply({ projectKey: "p", upserts: [{ id: "session.1", values: { pinned: true } }] }),
    ).rejects.toThrow();
    expect(published).toEqual([]);
    rmSync(file, { recursive: true });
    writeFileSync(file, original);
    expect((await store.load()).indices.p.sessions[0].pinned).toBeUndefined();
    await store.apply({
      projectKey: "p",
      upserts: [{ id: "session.1", values: { title: "recovered" } }],
    });
    expect(published).toEqual([2]);
    expect((await new SessionCatalogStore({ file }).load()).indices.p.sessions[0].title).toBe(
      "recovered",
    );
  });

  test("isolates subscriber/returned objects and does not report no-op changes", async () => {
    const { store } = fixture();
    store.onChanged(() => {
      throw new Error("window closed");
    });
    store.onChanged((snapshot) => {
      snapshot.indices.p.sessions[0].title = "mutated listener";
    });
    const revisions: number[] = [];
    const off = store.onChanged((snapshot) => revisions.push(snapshot.revision));
    const result = await store.apply({ projectKey: "p", upserts: [{ id: "s", values: row("s") }] });
    result.indices.p.sessions[0].title = "mutated return";
    await store.apply({ projectKey: "p", upserts: [{ id: "s", values: { title: row().title } }] });
    expect(revisions).toEqual([1]);
    expect((await store.load()).indices.p.sessions[0].title).toBe(row().title);
    off();
    await store.apply({ projectKey: "p", upserts: [{ id: "s", values: { pinned: true } }] });
    expect(revisions).toEqual([1]);
  });

  test("rejects unsafe ids, payloads, corrupt files and symbolic links without overwriting", async () => {
    const { directory, file, store } = fixture();
    for (const projectKey of [
      "__proto__",
      "prototype",
      "constructor",
      "../outside",
      "a/b",
      "a\\b",
      "..",
    ]) {
      await expect(store.apply({ projectKey })).rejects.toThrow();
    }
    await expect(
      store.importLegacy(JSON.parse('{"__proto__":{"sessions":[],"activeSessionId":null}}')),
    ).rejects.toThrow();
    await expect(
      store.apply({ projectKey: "p", upserts: [{ id: "s", values: { id: "another" } }] }),
    ).rejects.toThrow();
    await expect(
      store.apply({
        projectKey: "p",
        upserts: [{ id: "s", values: row("s"), removeFields: ["title"] }],
      }),
    ).rejects.toThrow();
    writeFileSync(file, "{broken");
    await expect(store.apply({ projectKey: "p" })).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe("{broken");
    rmSync(file);
    const outside = join(directory, "outside.json");
    writeFileSync(outside, "private");
    symlinkSync(outside, file);
    await expect(store.load()).rejects.toThrow();
    expect(readFileSync(outside, "utf8")).toBe("private");
  });
});
