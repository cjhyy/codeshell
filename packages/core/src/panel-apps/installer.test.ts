import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PanelAppInstallError,
  PanelAppReviewChangedError,
  installReviewedLocalPanelApp,
  installReviewedPanelAppUpdate,
  listInstalledPanelApps,
  previewInstalledPanelAppUpdate,
  previewLocalPanelApp,
  uninstallPanelApp,
} from "./index.js";

function writePanelApp(
  root: string,
  input: { id?: string; html?: string; version?: string } = {},
): void {
  mkdirSync(join(root, ".codeshell-panel"), { recursive: true });
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(
    join(root, ".codeshell-panel", "panel.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: input.id ?? "design-studio",
      version: input.version ?? "0.1.0",
      title: { default: "Design Studio", "zh-CN": "设计工作台" },
      description: "Repository-native design workspace",
      entry: "app/index.html",
      icon: "palette",
      placement: "right-dock",
      singleton: true,
      permissions: ["context.workspace", "workspace.read", "workspace.write", "storage"],
    }),
  );
  writeFileSync(
    join(root, "app", "index.html"),
    input.html ?? "<!doctype html><title>Design</title>",
  );
  writeFileSync(join(root, "app", "app.js"), "document.body.dataset.ready = 'true';");
}

function runGit(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

describe("independent Panel App installer", () => {
  let home: string;
  let source: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-panel-home-"));
    source = mkdtempSync(join(tmpdir(), "cs-panel-source-"));
    process.env.HOME = home;
    writePanelApp(source);
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  });

  test("previews, installs, catalogs, and uninstalls outside the plugin registry", async () => {
    const preview = await previewLocalPanelApp({ kind: "dir", path: source });
    expect(preview).toMatchObject({
      id: "design-studio",
      version: "0.1.0",
      entry: "app/index.html",
      alreadyInstalled: false,
    });
    expect(preview.permissions).toContain("workspace.write");

    const installed = await installReviewedLocalPanelApp(
      { kind: "dir", path: source },
      preview.reviewToken,
      "2026-07-28T00:00:00.000Z",
    );
    expect(installed.installPath).toBe(join(home, ".code-shell", "panel-apps", "design-studio"));
    expect(await listInstalledPanelApps()).toHaveLength(1);

    await uninstallPanelApp("design-studio");
    expect(await listInstalledPanelApps()).toEqual([]);
  });

  test("rejects agent-plugin content instead of creating a hybrid package", async () => {
    mkdirSync(join(source, "skills", "designer"), { recursive: true });
    writeFileSync(join(source, "skills", "designer", "SKILL.md"), "# not allowed");
    await expect(previewLocalPanelApp({ kind: "dir", path: source })).rejects.toThrow(
      PanelAppInstallError,
    );
    await expect(previewLocalPanelApp({ kind: "dir", path: source })).rejects.toThrow(
      /cannot contain agent-plugin content/,
    );
  });

  test("rejects even an empty Agent Plugin capability directory", async () => {
    mkdirSync(join(source, "hooks"));
    await expect(previewLocalPanelApp({ kind: "dir", path: source })).rejects.toThrow(
      /cannot contain agent-plugin content 'hooks'/,
    );
  });

  test("requires a nested app entry so package metadata is never web-accessible", async () => {
    writeFileSync(
      join(source, ".codeshell-panel", "panel.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "design-studio",
        version: "0.1.0",
        title: { default: "Design Studio" },
        entry: "index.html",
      }),
    );
    writeFileSync(join(source, "index.html"), "<!doctype html>");
    await expect(previewLocalPanelApp({ kind: "dir", path: source })).rejects.toThrow(
      /entry must be a nested/,
    );
  });

  test("requires a fresh review when package bytes change", async () => {
    const preview = await previewLocalPanelApp({ kind: "dir", path: source });
    writeFileSync(join(source, "app", "index.html"), "<!doctype html><title>Changed</title>");
    await expect(
      installReviewedLocalPanelApp(
        { kind: "dir", path: source },
        preview.reviewToken,
        "2026-07-28T00:00:00.000Z",
      ),
    ).rejects.toBeInstanceOf(PanelAppReviewChangedError);
  });

  test("reviews and updates an installed app directly from its original repo folder", async () => {
    const initial = await previewLocalPanelApp({ kind: "dir", path: source });
    await installReviewedLocalPanelApp(
      { kind: "dir", path: source },
      initial.reviewToken,
      "2026-07-28T00:00:00.000Z",
    );
    writePanelApp(source, {
      version: "0.2.0",
      html: "<!doctype html><title>Updated Design</title>",
    });

    const update = await previewInstalledPanelAppUpdate("design-studio");
    expect(update).toMatchObject({
      id: "design-studio",
      version: "0.2.0",
      alreadyInstalled: true,
      source: { kind: "dir" },
    });
    const installed = await installReviewedPanelAppUpdate(
      "design-studio",
      update.reviewToken,
      "2026-07-28T01:00:00.000Z",
    );
    expect(installed.version).toBe("0.2.0");
    expect(installed.source).toBe(source);
    expect((await listInstalledPanelApps())[0]?.lastUpdated).toBe("2026-07-28T01:00:00.000Z");
  });

  test("fails closed when an installed app's original source disappears", async () => {
    const preview = await previewLocalPanelApp({ kind: "dir", path: source });
    await installReviewedLocalPanelApp(
      { kind: "dir", path: source },
      preview.reviewToken,
      "2026-07-28T00:00:00.000Z",
    );
    rmSync(source, { recursive: true, force: true });
    await expect(previewInstalledPanelAppUpdate("design-studio")).rejects.toThrow(
      /original source.*unavailable/,
    );
  });

  test("clones, reviews, installs, and updates a Panel App from a GitHub monorepo subdirectory", async () => {
    const repository = mkdtempSync(join(tmpdir(), "cs-panel-git-source-"));
    const appRoot = join(repository, "examples", "panel-app");
    const cloneUrl = "https://github.com/codeshell-tests/panel-source.git";
    const envKeys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
    const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    try {
      writePanelApp(appRoot, { id: "remote-panel", version: "1.0.0" });
      runGit(repository, "init", "--initial-branch=main");
      runGit(repository, "config", "user.email", "panel-tests@codeshell.local");
      runGit(repository, "config", "user.name", "Panel Tests");
      runGit(repository, "add", ".");
      runGit(repository, "commit", "-m", "initial panel");

      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = `url.file://${repository}.insteadOf`;
      process.env.GIT_CONFIG_VALUE_0 = cloneUrl;

      const source = {
        kind: "git" as const,
        url: cloneUrl,
        ref: "main",
        subdir: "examples/panel-app",
      };
      const preview = await previewLocalPanelApp(source);
      expect(preview).toMatchObject({
        id: "remote-panel",
        version: "1.0.0",
        source: { kind: "git", label: "codeshell-tests/panel-source/examples/panel-app" },
      });
      const treeUrlPreview = await previewLocalPanelApp({
        kind: "git",
        url: "https://github.com/codeshell-tests/panel-source/tree/main/examples/panel-app",
      });
      expect(treeUrlPreview.reviewToken).toBe(preview.reviewToken);
      const installed = await installReviewedLocalPanelApp(
        source,
        preview.reviewToken,
        "2026-07-28T00:00:00.000Z",
      );
      expect(installed.source).toEqual({
        kind: "git",
        url: cloneUrl,
        ref: "main",
        subdir: "examples/panel-app",
      });

      writePanelApp(appRoot, { id: "remote-panel", version: "1.1.0" });
      runGit(repository, "add", ".");
      runGit(repository, "commit", "-m", "update panel");
      const update = await previewInstalledPanelAppUpdate("remote-panel");
      expect(update.version).toBe("1.1.0");
      expect(
        (
          await installReviewedPanelAppUpdate(
            "remote-panel",
            update.reviewToken,
            "2026-07-28T01:00:00.000Z",
          )
        ).version,
      ).toBe("1.1.0");
    } finally {
      for (const key of envKeys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("rejects unsafe GitHub sources before cloning", async () => {
    await expect(
      previewLocalPanelApp({
        kind: "git",
        url: "http://github.com/acme/panel",
      }),
    ).rejects.toThrow(/public https:\/\/github\.com/);
    await expect(
      previewLocalPanelApp({
        kind: "git",
        url: "https://example.com/acme/panel",
      }),
    ).rejects.toThrow(/public https:\/\/github\.com/);
    await expect(
      previewLocalPanelApp({
        kind: "git",
        url: "https://github.com/acme/panel",
        subdir: "../outside",
      }),
    ).rejects.toThrow(/subdirectory is invalid/);
  });

  test("serializes concurrent registry updates for different apps", async () => {
    const secondSource = mkdtempSync(join(tmpdir(), "cs-panel-source-"));
    writePanelApp(secondSource, { id: "quant-lab" });
    try {
      const [design, quant] = await Promise.all([
        previewLocalPanelApp({ kind: "dir", path: source }),
        previewLocalPanelApp({ kind: "dir", path: secondSource }),
      ]);
      await Promise.all([
        installReviewedLocalPanelApp(
          { kind: "dir", path: source },
          design.reviewToken,
          "2026-07-28T00:00:00.000Z",
        ),
        installReviewedLocalPanelApp(
          { kind: "dir", path: secondSource },
          quant.reviewToken,
          "2026-07-28T00:00:00.000Z",
        ),
      ]);
      expect((await listInstalledPanelApps()).map((app) => app.id)).toEqual([
        "design-studio",
        "quant-lab",
      ]);
    } finally {
      rmSync(secondSource, { recursive: true, force: true });
    }
  });
});
