import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
