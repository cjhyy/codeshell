import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rename, rm, symlink } from "node:fs/promises";
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
    expect(new PanelAppDirectoryBookmarks(file).restore("video-download", project, id)).toBe(chosen);
    expect(() => new PanelAppDirectoryBookmarks(file).restore("other-app", project, id)).toThrow();
    expect(() => new PanelAppDirectoryBookmarks(file).restore("video-download", "/another/project", id)).toThrow();
    expect(() => new PanelAppDirectoryBookmarks(file).restore("video-download", project, chosen)).toThrow();
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
