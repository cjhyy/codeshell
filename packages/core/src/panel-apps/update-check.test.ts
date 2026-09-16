import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { asGlobalFetch } from "../testing/fetch-stub.js";
import { MAX_PANEL_UPDATE_MANIFEST_BYTES, readGitHubPanelAppManifest } from "./github-manifest.js";
import { PANEL_APP_MANIFEST_FILE } from "./manifest.js";
import { installReviewedLocalPanelApp, previewLocalPanelApp } from "./installer.js";
import {
  checkInstalledPanelAppUpdate,
  getInstalledPanelAppUpdateIdentity,
} from "./update-check.js";

function manifest(version = "1.2.3", id = "video-studio") {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    version,
    title: { default: "Video Studio" },
    entry: "app/index.html",
    permissions: [],
  });
}

describe("Panel App version discovery", () => {
  let temporaryRoot: string;
  let previousHome: string | undefined;
  let originalFetch: typeof globalThis.fetch;
  let installedManifest: string;
  let sourceRoot: string;
  let registryPath: string;

  function record(source: unknown, version = "0.0.1") {
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        apps: [
          {
            id: "video-studio",
            version,
            source,
            installedAt: "2026-01-01T00:00:00.000Z",
            lastUpdated: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
  }

  beforeEach(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "panel-version-check-"));
    previousHome = process.env.HOME;
    process.env.HOME = temporaryRoot;
    originalFetch = globalThis.fetch;
    installedManifest = join(
      temporaryRoot,
      ".code-shell/panel-apps/video-studio",
      PANEL_APP_MANIFEST_FILE,
    );
    registryPath = join(temporaryRoot, ".code-shell/panel-apps/installed.json");
    sourceRoot = join(temporaryRoot, "source");
    mkdirSync(dirname(installedManifest), { recursive: true });
    mkdirSync(join(sourceRoot, ".codeshell-panel"), { recursive: true });
    writeFileSync(installedManifest, manifest());
    writeFileSync(join(sourceRoot, PANEL_APP_MANIFEST_FILE), manifest("1.3.0"));
    record({
      kind: "git",
      url: "https://github.com/example/panels.git",
      subdir: "panels/video-studio",
    });
    globalThis.fetch = asGlobalFetch(async () => new Response(manifest("1.3.0")));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test("checks only the recorded GitHub manifest at HEAD and uses the installed version", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = asGlobalFetch(async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(manifest("1.3.0"));
    });
    const result = await checkInstalledPanelAppUpdate("video-studio");
    expect(result).toMatchObject({
      id: "video-studio",
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
      status: "update-available",
      sourceKind: "git",
    });
    expect(Number.isNaN(Date.parse(result.checkedAt))).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://raw.githubusercontent.com/example/panels/HEAD/panels/video-studio/.codeshell-panel/panel.json",
    );
    expect(requests[0].init?.redirect).toBe("error");
    expect(requests[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("uses the recorded ref and safely encodes branch/path segments", async () => {
    record({
      kind: "git",
      url: "https://github.com/example/panels.git",
      ref: "release/next",
      subdir: "panels/video #1",
    });
    let requested = "";
    globalThis.fetch = asGlobalFetch(async (url) => {
      requested = String(url);
      return new Response(manifest("1.3.0"));
    });
    expect((await checkInstalledPanelAppUpdate("video-studio")).status).toBe("update-available");
    expect(requested).toBe(
      "https://raw.githubusercontent.com/example/panels/release%2Fnext/panels/video%20%231/.codeshell-panel/panel.json",
    );
  });

  test.each([
    ["1.2.3", "1.2.3", "up-to-date"],
    ["1.2.3", "1.2.2", "source-older"],
    ["1.2.3", "1.10.0", "update-available"],
    ["1.2.3", "1.2.3-beta.1", "source-older"],
    ["1.2.3-beta.2", "1.2.3-beta.10", "update-available"],
    ["1.2.3-beta.10", "1.2.3", "update-available"],
    ["1.2.3+build.1", "1.2.3+build.2", "up-to-date"],
    ["1.2.3-1", "1.2.3-alpha", "update-available"],
  ])("compares %s against %s as %s", async (current, latest, status) => {
    writeFileSync(installedManifest, manifest(current));
    globalThis.fetch = asGlobalFetch(async () => new Response(manifest(latest)));
    expect((await checkInstalledPanelAppUpdate("video-studio")).status).toBe(status);
  });

  test.each(["v1.3.0", "1.03.0", "1.3", "1.3.0-beta.01", " 1.3.0", "latest"])(
    "rejects invalid source version %s",
    async (version) => {
      globalThis.fetch = asGlobalFetch(async () => new Response(manifest(version)));
      expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
        status: "error",
        currentVersion: "1.2.3",
        message: expect.stringContaining("semantic version"),
      });
    },
  );

  test("does not use a stale registry version when the installed manifest is invalid", async () => {
    writeFileSync(installedManifest, manifest("legacy"));
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "error",
      message: expect.stringContaining("semantic version"),
    });
  });

  test("rejects a different panel ID", async () => {
    globalThis.fetch = asGlobalFetch(async () => new Response(manifest("2.0.0", "another-panel")));
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "error",
      message: expect.stringContaining("ID does not match"),
    });
  });

  test.each(["not json", '{"id":"video-studio","version":"2.0.0"}'])(
    "reports malformed manifests as errors",
    async (text) => {
      globalThis.fetch = asGlobalFetch(async () => new Response(text));
      expect((await checkInstalledPanelAppUpdate("video-studio")).status).toBe("error");
    },
  );

  test.each([404, 403, 500, 302])("HTTP %s is an error, never up-to-date", async (status) => {
    globalThis.fetch = asGlobalFetch(async () => new Response(null, { status }));
    expect((await checkInstalledPanelAppUpdate("video-studio")).status).toBe("error");
  });

  test("network failure is reported without throwing", async () => {
    globalThis.fetch = asGlobalFetch(async () => {
      throw new Error("network unavailable");
    });
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "error",
      currentVersion: "1.2.3",
      message: "network unavailable",
    });
  });

  test.each([
    { kind: "git", url: "http://github.com/example/panels" },
    { kind: "git", url: "https://localhost/example/panels" },
    { kind: "git", url: "https://user:password@github.com/example/panels" },
    { kind: "git", url: "https://github.com/example/panels", subdir: "../other" },
  ])("rejects unsafe GitHub sources before fetching", async (source) => {
    record(source);
    let fetched = false;
    globalThis.fetch = asGlobalFetch(async () => {
      fetched = true;
      return new Response(manifest());
    });
    expect((await checkInstalledPanelAppUpdate("video-studio")).status).toBe("error");
    expect(fetched).toBe(false);
  });

  test("local directory checks read only manifests and preserve registry/source and package bytes", async () => {
    record(sourceRoot);
    const beforeRegistry = readFileSync(registryPath);
    const beforeInstalled = readFileSync(installedManifest);
    let fetched = false;
    globalThis.fetch = asGlobalFetch(async () => {
      fetched = true;
      throw new Error("should not fetch");
    });
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "update-available",
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
      sourceKind: "dir",
    });
    expect(readFileSync(registryPath)).toEqual(beforeRegistry);
    expect(readFileSync(installedManifest)).toEqual(beforeInstalled);
    expect(fetched).toBe(false);
  });

  test("ZIP sources remain an unsupported manual review path", async () => {
    const archivePath = join(temporaryRoot, "panel.ZIP");
    writeFileSync(archivePath, "not read or extracted");
    record(archivePath);
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "unsupported",
      currentVersion: "1.2.3",
      sourceKind: "zip",
    });
  });

  test("installed update identity reads the target manifest without walking missing or broken app assets", async () => {
    symlinkSync(
      join(temporaryRoot, "missing-native-code"),
      join(dirname(dirname(installedManifest)), "native"),
    );
    const before = readFileSync(registryPath);
    expect(await getInstalledPanelAppUpdateIdentity("video-studio")).toEqual({
      id: "video-studio",
      version: "1.2.3",
      source: {
        kind: "git",
        url: "https://github.com/example/panels.git",
        subdir: "panels/video-studio",
      },
      lastUpdated: "2026-01-01T00:00:00.000Z",
    });
    expect(readFileSync(registryPath)).toEqual(before);
    expect(await getInstalledPanelAppUpdateIdentity("missing-app")).toBeUndefined();
  });

  test("parent-directory installations find their unique local panel without inspecting assets", async () => {
    record(temporaryRoot);
    // Installed copies live under a hidden directory, which source discovery must skip.
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "update-available",
      latestVersion: "1.3.0",
      sourceKind: "dir",
    });
  });

  test("a genuinely installed source-root symlink keeps working for version checks, including a .zip suffix", async () => {
    mkdirSync(join(sourceRoot, "app"));
    writeFileSync(join(sourceRoot, "app/index.html"), "<!doctype html><title>Video</title>");
    const linkedSource = join(temporaryRoot, "source-link.zip");
    symlinkSync(sourceRoot, linkedSource);
    const input = { kind: "dir" as const, path: linkedSource };
    const preview = await previewLocalPanelApp(input);
    await installReviewedLocalPanelApp(input, preview.reviewToken, "2026-09-16T00:00:00.000Z", {
      overwrite: true,
    });
    writeFileSync(join(sourceRoot, PANEL_APP_MANIFEST_FILE), manifest("1.4.0"));
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "update-available",
      currentVersion: "1.3.0",
      latestVersion: "1.4.0",
      sourceKind: "dir",
    });
    expect((await getInstalledPanelAppUpdateIdentity("video-studio"))?.source).toBe(linkedSource);
  });

  test("ambiguous parent-directory installations cannot silently choose one local panel", async () => {
    record(temporaryRoot);
    const other = join(temporaryRoot, "other", PANEL_APP_MANIFEST_FILE);
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, manifest("2.0.0", "another-panel"));
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "error",
      message: expect.stringContaining("multiple Panel Apps"),
    });
  });

  test("local discovery budget exhaustion cannot report the first panel as the unique match", async () => {
    record(temporaryRoot);
    for (let index = 0; index < 512; index++) mkdirSync(join(temporaryRoot, `directory-${index}`));
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "error",
      message: expect.stringContaining("discovery limit"),
    });
  });

  function mockLegacyGitHubTree(
    entries: { path: string; type: string; mode?: string }[],
    truncated = false,
  ) {
    record({ kind: "git", url: "https://github.com/example/panels.git", ref: "main" });
    const requests: string[] = [];
    globalThis.fetch = asGlobalFetch(async (url) => {
      const value = String(url);
      requests.push(value);
      if (
        value ===
        "https://raw.githubusercontent.com/example/panels/main/.codeshell-panel/panel.json"
      )
        return new Response(null, { status: 404 });
      if (value === "https://api.github.com/repos/example/panels/git/trees/main?recursive=1")
        return Response.json({ tree: entries, truncated });
      return new Response(manifest("1.3.0"));
    });
    return requests;
  }

  test("legacy GitHub parent-directory sources resolve a unique manifest with no archive download", async () => {
    const requests = mockLegacyGitHubTree([
      { path: "panels", type: "tree" },
      { path: "panels/video", type: "tree" },
      { path: "panels/video/.codeshell-panel/panel.json", type: "blob", mode: "100644" },
      { path: "panels/video/assets/nested/.codeshell-panel/panel.json", type: "blob" },
      { path: "node_modules/ignored/.codeshell-panel/panel.json", type: "blob" },
      { path: ".hidden/ignored/.codeshell-panel/panel.json", type: "blob" },
    ]);
    const before = readFileSync(registryPath);
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "update-available",
      latestVersion: "1.3.0",
      sourceKind: "git",
    });
    expect(requests).toEqual([
      "https://raw.githubusercontent.com/example/panels/main/.codeshell-panel/panel.json",
      "https://api.github.com/repos/example/panels/git/trees/main?recursive=1",
      "https://raw.githubusercontent.com/example/panels/main/panels/video/.codeshell-panel/panel.json",
    ]);
    expect(readFileSync(registryPath)).toEqual(before);
  });

  test("GitHub fallback only searches beneath the originally selected parent subdirectory", async () => {
    const requests = mockLegacyGitHubTree([]);
    record({
      kind: "git",
      url: "https://github.com/example/panels.git",
      ref: "main",
      subdir: "panels",
    });
    globalThis.fetch = asGlobalFetch(async (url) => {
      const value = String(url);
      requests.push(value);
      if (value.endsWith("/main/panels/.codeshell-panel/panel.json"))
        return new Response(null, { status: 404 });
      if (value.includes("api.github.com"))
        return Response.json({
          truncated: false,
          tree: [
            { path: "panels/video/.codeshell-panel/panel.json", type: "blob" },
            { path: "outside/another/.codeshell-panel/panel.json", type: "blob" },
          ],
        });
      return new Response(manifest("1.3.0"));
    });
    expect((await checkInstalledPanelAppUpdate("video-studio")).status).toBe("update-available");
    expect(requests.at(-1)).toBe(
      "https://raw.githubusercontent.com/example/panels/main/panels/video/.codeshell-panel/panel.json",
    );
  });

  test("ambiguous or truncated GitHub discovery cannot claim an update", async () => {
    mockLegacyGitHubTree([
      { path: "one/.codeshell-panel/panel.json", type: "blob" },
      { path: "two/.codeshell-panel/panel.json", type: "blob" },
    ]);
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "error",
      message: expect.stringContaining("multiple Panel Apps"),
    });
    mockLegacyGitHubTree([{ path: "one/.codeshell-panel/panel.json", type: "blob" }], true);
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "error",
      message: expect.stringContaining("incomplete"),
    });
  });

  test("GitHub discovery has a bounded depth and directory budget", async () => {
    mockLegacyGitHubTree([
      { path: "one/two/three/four/five/.codeshell-panel/panel.json", type: "blob" },
    ]);
    expect((await checkInstalledPanelAppUpdate("video-studio")).status).toBe("error");
    mockLegacyGitHubTree([
      { path: "one/.codeshell-panel/panel.json", type: "blob" },
      ...Array.from({ length: 512 }, (_, index) => ({ path: `directory-${index}`, type: "tree" })),
    ]);
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "error",
      message: expect.stringContaining("discovery limit"),
    });
  });

  test("GitHub discovery does not count directories inside an already identified panel root", async () => {
    mockLegacyGitHubTree([
      { path: "panels", type: "tree" },
      { path: "panels/video", type: "tree" },
      { path: "panels/video/.codeshell-panel/panel.json", type: "blob" },
      ...Array.from({ length: 512 }, (_, index) => ({
        path: `panels/video/assets-${index}`,
        type: "tree",
      })),
    ]);
    expect((await checkInstalledPanelAppUpdate("video-studio")).status).toBe("update-available");
  });

  test("the GitHub fallback shares the timeout across direct lookup and directory discovery", async () => {
    await expect(
      readGitHubPanelAppManifest(
        { kind: "git", url: "https://github.com/example/panels" },
        {
          timeoutMs: 15,
          fetch: async (url) =>
            String(url).includes("raw.githubusercontent.com")
              ? new Response(null, { status: 404 })
              : new Promise(() => {}),
        },
      ),
    ).rejects.toThrow("timed out");
  });

  test("a directory ending in .zip is still checked as a local folder", async () => {
    const directory = join(temporaryRoot, "source.zip");
    mkdirSync(join(directory, ".codeshell-panel"), { recursive: true });
    writeFileSync(join(directory, PANEL_APP_MANIFEST_FILE), manifest("2.0.0"));
    record(directory);
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "update-available",
      sourceKind: "dir",
      latestVersion: "2.0.0",
    });
  });

  test("missing local sources are errors", async () => {
    record(join(temporaryRoot, "missing"));
    expect((await checkInstalledPanelAppUpdate("video-studio")).status).toBe("error");
  });

  test("rejects local manifest symlinks", async () => {
    record(sourceRoot);
    const sourcePath = join(sourceRoot, PANEL_APP_MANIFEST_FILE);
    rmSync(sourcePath);
    symlinkSync(installedManifest, sourcePath);
    expect((await checkInstalledPanelAppUpdate("video-studio")).status).toBe("error");
  });

  test("unknown and unsafe panel IDs return errors", async () => {
    expect((await checkInstalledPanelAppUpdate("unknown-panel")).status).toBe("error");
    expect((await checkInstalledPanelAppUpdate("../video-studio")).status).toBe("error");
  });

  test("oversized local manifests fail within the same byte budget", async () => {
    record(sourceRoot);
    writeFileSync(
      join(sourceRoot, PANEL_APP_MANIFEST_FILE),
      " ".repeat(MAX_PANEL_UPDATE_MANIFEST_BYTES + 1),
    );
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "error",
      message: expect.stringContaining("1 MiB"),
    });
  });

  test("oversized GitHub Content-Length fails before reading the body", async () => {
    globalThis.fetch = asGlobalFetch(
      async () =>
        new Response(manifest(), {
          headers: { "Content-Length": String(MAX_PANEL_UPDATE_MANIFEST_BYTES + 1) },
        }),
    );
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "error",
      message: expect.stringContaining("1 MiB"),
    });
  });

  test("oversized chunked GitHub responses fail without trusting Content-Length", async () => {
    globalThis.fetch = asGlobalFetch(
      async () => new Response(" ".repeat(MAX_PANEL_UPDATE_MANIFEST_BYTES + 1)),
    );
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "error",
      message: expect.stringContaining("1 MiB"),
    });
  });

  test("truncated Content-Length is an error", async () => {
    globalThis.fetch = asGlobalFetch(
      async () => new Response(manifest(), { headers: { "Content-Length": "5000" } }),
    );
    expect(await checkInstalledPanelAppUpdate("video-studio")).toMatchObject({
      status: "error",
      message: expect.stringContaining("Content-Length"),
    });
  });

  test("fetch timeout also works when the fetch implementation ignores cancellation", async () => {
    await expect(
      readGitHubPanelAppManifest(
        { kind: "git", url: "https://github.com/example/panels" },
        {
          timeoutMs: 15,
          fetch: () => new Promise(() => {}),
        },
      ),
    ).rejects.toThrow("timed out");
  });

  test("the same timeout bounds a stalled response body and cancels its reader", async () => {
    let cancelled = false;
    await expect(
      readGitHubPanelAppManifest(
        { kind: "git", url: "https://github.com/example/panels" },
        {
          timeoutMs: 15,
          fetch: async () =>
            new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
            ),
        },
      ),
    ).rejects.toThrow("timed out");
    expect(cancelled).toBe(true);
  });
});
