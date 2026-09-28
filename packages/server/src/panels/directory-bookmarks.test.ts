import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubPanelDirectoryBookmarks, PanelAppDirectoryBookmarks } from "./directory-bookmarks.js";

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
