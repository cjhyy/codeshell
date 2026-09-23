import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PanelAppDirectoryBookmarks } from "./panel-app-directory-bookmarks.js";

describe("Panel directory bookmarks", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("explicitly picked directories restore across instances only in the same app and project", async () => {
    const root = await mkdtemp(join(tmpdir(), "panel-bookmark-"));
    roots.push(root);
    const project = await realpath(root);
    const chosen = join(project, "videos");
    await mkdir(chosen);
    const file = join(project, "bookmarks.json");
    const id = new PanelAppDirectoryBookmarks(file).remember("video-download", project, chosen);
    expect(new PanelAppDirectoryBookmarks(file).restore("video-download", project, id)).toBe(
      chosen,
    );
    expect(() => new PanelAppDirectoryBookmarks(file).restore("other-app", project, id)).toThrow();
    expect(() =>
      new PanelAppDirectoryBookmarks(file).restore("video-download", "/another/project", id),
    ).toThrow();
    expect(() =>
      new PanelAppDirectoryBookmarks(file).restore("video-download", project, chosen),
    ).toThrow();
  });

  test("reselecting the same directory preserves its ID; replacement needs a new grant", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "panel-stable-bookmark-")));
    roots.push(root);
    const chosen = join(root, "output");
    await mkdir(chosen);
    const file = join(root, "bookmarks.json");
    const first = new PanelAppDirectoryBookmarks(file);
    const second = new PanelAppDirectoryBookmarks(file);
    const id = first.remember("video-download", root, chosen);
    expect(second.remember("video-download", root, chosen)).toBe(id);
    expect(first.restore("video-download", root, id)).toBe(chosen);
    await rename(chosen, join(root, "previous"));
    await mkdir(chosen);
    const next = second.remember("video-download", root, chosen);
    expect(next).not.toBe(id);
    expect(() => first.restore("video-download", root, id)).toThrow();
    expect(first.restore("video-download", root, next)).toBe(chosen);
  });

  test("legacy scoped IDs migrate without changing either existing alias or the legacy file", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "panel-legacy-bookmark-")));
    roots.push(root);
    const chosen = join(root, "output");
    await mkdir(chosen);
    const file = join(root, "current.json"),
      legacyFile = join(root, "legacy.json");
    const legacy = new PanelAppDirectoryBookmarks(legacyFile);
    const oldId = legacy.remember("video-download", root, chosen);
    const before = await readFile(legacyFile, "utf8");
    const current = new PanelAppDirectoryBookmarks(file, { legacyFiles: [legacyFile] });
    const desktopId = current.remember("video-download", root, chosen);
    expect(() => current.restore("different-panel", root, oldId)).toThrow();
    expect(() => current.restore("video-download", root + "/other", oldId)).toThrow();
    expect(current.restore("video-download", root, oldId)).toBe(chosen);
    current.remember("video-download", root, chosen);
    const reopened = new PanelAppDirectoryBookmarks(file);
    expect(reopened.restore("video-download", root, desktopId)).toBe(chosen);
    expect(reopened.restore("video-download", root, oldId)).toBe(chosen);
    expect(await readFile(legacyFile, "utf8")).toBe(before);
    expect(JSON.parse(await readFile(file, "utf8")).bookmarks).toHaveLength(2);
    await rename(chosen, join(root, "old-output"));
    await mkdir(chosen);
    expect(() => current.restore("video-download", root, oldId)).toThrow(/changed/);
  });

  test("legacy grants cannot override a current ID assigned to another scope", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "panel-conflicting-bookmark-")));
    roots.push(root);
    const chosen = join(root, "output");
    await mkdir(chosen);
    const file = join(root, "current.json"),
      legacyFile = join(root, "legacy.json");
    const id = new PanelAppDirectoryBookmarks(legacyFile).remember("video-download", root, chosen);
    const record = JSON.parse(await readFile(legacyFile, "utf8"));
    record.bookmarks[0].appId = "different-panel";
    await writeFile(file, JSON.stringify(record));
    const store = new PanelAppDirectoryBookmarks(file, { legacyFiles: [legacyFile] });
    expect(() => store.restore("video-download", root, id)).toThrow(/unavailable/);
    expect(store.restore("different-panel", root, id)).toBe(chosen);
  });

  test("replacement and symbolic-link targets cannot inherit the saved grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "panel-bookmark-"));
    roots.push(root);
    const project = await realpath(root);
    const chosen = join(project, "videos");
    await mkdir(chosen);
    const store = new PanelAppDirectoryBookmarks(join(project, "bookmarks.json"));
    const id = store.remember("video-download", project, chosen);
    await rename(chosen, join(project, "old-videos"));
    await mkdir(chosen);
    expect(() => store.restore("video-download", project, id)).toThrow(/changed/);
    await rm(chosen, { recursive: true });
    await symlink(join(project, "old-videos"), chosen);
    expect(() => store.restore("video-download", project, id)).toThrow(/changed/);
  });
});
