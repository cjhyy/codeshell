import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyLocalInstallError,
  installLocalPluginForUi,
  parseRecommendedMarketplaces,
  previewLocalPluginForUi,
} from "./marketplace-service.js";

/**
 * Local-install error classification (protects the unsubmitted overwrite UI
 * flow). The contract: core bakes the authoritative plugin name into a
 * "plugin '<name>' already installed" error; the UI must extract that exact
 * name and surface { alreadyInstalled: true } so the overwrite prompt names the
 * right plugin. If core ever changes this error wording, the fragile regex
 * would silently break the overwrite flow — this test pins it.
 */
describe("classifyLocalInstallError", () => {
  test("already-installed error → { alreadyInstalled, authoritative name }", () => {
    const r = classifyLocalInstallError("plugin 'superpowers' already installed");
    expect(r).toEqual({ ok: false, alreadyInstalled: true, name: "superpowers" });
  });

  test("extracts the name core derived (manifest name), not the picker's filename guess", () => {
    // zip picked as "my-download.zip" but the manifest name is "mimi-video".
    const r = classifyLocalInstallError("plugin 'mimi-video' already installed");
    expect(r).toMatchObject({ alreadyInstalled: true, name: "mimi-video" });
  });

  test("handles names with spaces/hyphens (non-greedy capture stops at the quote)", () => {
    const r = classifyLocalInstallError("plugin 'My Cool-Plugin' already installed");
    expect(r).toMatchObject({ alreadyInstalled: true, name: "My Cool-Plugin" });
  });

  test("unrelated error → humanized { ok:false, error } without alreadyInstalled", () => {
    const r = classifyLocalInstallError("some random failure");
    expect(r).toEqual({ ok: false, error: "some random failure" });
    expect("alreadyInstalled" in r).toBe(false);
  });

  test("GIT_NOT_FOUND is humanized to actionable guidance", () => {
    const r = classifyLocalInstallError("GIT_NOT_FOUND: git not on PATH");
    expect(r.ok).toBe(false);
    if (!("alreadyInstalled" in r)) {
      expect(r.error).toContain("Git");
      expect(r.error).toContain("git-scm.com");
    }
  });
});

describe("parseRecommendedMarketplaces", () => {
  test("accepts the object shape served by the GitHub recommendation list", () => {
    const list = parseRecommendedMarketplaces({
      marketplaces: [
        {
          id: "mimi",
          name: "Mimi Plugins",
          reason: "default recommendation",
          source: { source: "github", repo: "cjhyy/mimi-plugins" },
          format: "universal",
          official: true,
          sort: 5,
        },
      ],
    });
    expect(list).toEqual([
      expect.objectContaining({
        id: "mimi",
        name: "Mimi Plugins",
        reason: "default recommendation",
        source: { source: "github", repo: "cjhyy/mimi-plugins" },
        format: "universal",
        official: true,
      }),
    ]);
  });

  test("derives stable names/ids and drops invalid entries", () => {
    const list = parseRecommendedMarketplaces([
      { source: { source: "github", repo: "owner/cool-market" } },
      { name: "bad" },
      { source: { source: "git", url: "https://example.com/team/second-market.git" } },
    ]);
    expect(list.map((item) => item.id)).toEqual(["cool-market", "second-market"]);
    expect(list.map((item) => item.name)).toEqual(["cool-market", "second-market"]);
  });
});

describe("reviewed local plugin installation", () => {
  let home: string;
  let source: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "desktop-plugin-review-home-"));
    source = mkdtempSync(join(tmpdir(), "desktop-plugin-review-source-"));
    process.env.HOME = home;
    mkdirSync(join(source, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(source, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "reviewed-local", version: "1.0.0" }),
    );
    mkdirSync(join(source, "commands"), { recursive: true });
    writeFileSync(join(source, "commands", "hello.md"), "hello\n");
  });

  afterEach(() => {
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  });

  test("rejects a source changed after review without mutating installed state", async () => {
    const reviewed = await previewLocalPluginForUi({ kind: "dir", path: source });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    writeFileSync(join(source, "commands", "hello.md"), "changed\n");

    const result = await installLocalPluginForUi({
      kind: "dir",
      path: source,
      reviewToken: reviewed.preview.reviewToken,
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, previewChanged: true }));
    expect(existsSync(join(home, ".code-shell", "plugins", "reviewed-local"))).toBe(false);
  });

  test("installs only with the current review token", async () => {
    const reviewed = await previewLocalPluginForUi({ kind: "dir", path: source });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;

    const result = await installLocalPluginForUi({
      kind: "dir",
      path: source,
      reviewToken: reviewed.preview.reviewToken,
    });

    expect(result).toEqual({ ok: true, name: "reviewed-local" });
    expect(existsSync(join(home, ".code-shell", "plugins", "reviewed-local"))).toBe(true);
  });
});
