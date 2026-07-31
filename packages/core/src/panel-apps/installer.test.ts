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
import { invalidateSkillCache, scanSkills } from "../skills/scanner.js";

function writePanelApp(
  root: string,
  input: { id?: string; html?: string; version?: string; agent?: boolean } = {},
): void {
  mkdirSync(join(root, ".codeshell-panel"), { recursive: true });
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(
    join(root, ".codeshell-panel", "panel.json"),
    JSON.stringify({
      schemaVersion: input.agent ? 2 : 1,
      id: input.id ?? "design-studio",
      version: input.version ?? "0.1.0",
      title: { default: "Design Studio", "zh-CN": "设计工作台" },
      description: "Repository-native design workspace",
      entry: "app/index.html",
      icon: "palette",
      placement: "right-dock",
      singleton: true,
      permissions: ["context.workspace", "workspace.read", "workspace.write", "storage"],
      ...(input.agent
        ? {
            agent: {
              tools: [
                {
                  name: "get_design_context",
                  description: "Read the current design document.",
                  inputSchema: { type: "object", properties: {} },
                  readOnly: true,
                },
              ],
              skills: ["agent/skills/design/SKILL.md"],
            },
          }
        : {}),
    }),
  );
  writeFileSync(
    join(root, "app", "index.html"),
    input.html ?? "<!doctype html><title>Design</title>",
  );
  writeFileSync(join(root, "app", "app.js"), "document.body.dataset.ready = 'true';");
  if (input.agent) {
    mkdirSync(join(root, "agent", "skills", "design"), { recursive: true });
    writeFileSync(
      join(root, "agent", "skills", "design", "SKILL.md"),
      "---\nname: design\ndescription: Edit repository designs.\n---\n",
    );
  }
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

  test("installs schema v2 Agent tools and declared skills as one Panel App", async () => {
    writePanelApp(source, { agent: true, version: "0.3.0" });
    const preview = await previewLocalPanelApp({ kind: "dir", path: source });
    expect(preview.agent).toMatchObject({
      tools: [{ name: "get_design_context", readOnly: true }],
      skills: ["agent/skills/design/SKILL.md"],
    });
    expect(preview.warnings).toContain("Panel App contributes 1 Agent tool(s) and 1 Skill(s)");

    const installed = await installReviewedLocalPanelApp(
      { kind: "dir", path: source },
      preview.reviewToken,
      "2026-07-28T00:00:00.000Z",
    );
    expect(installed.agent?.tools[0]?.name).toBe("get_design_context");
    invalidateSkillCache();
    expect(
      scanSkills(source, { includeDisabledPanelApps: true }).find(
        (skill) => skill.name === "design-studio:design",
      ),
    ).toMatchObject({
      source: "panel-app",
      description: "Edit repository designs.",
    });
    writeFileSync(
      join(home, ".code-shell", "settings.json"),
      JSON.stringify({ disabledPanelApps: ["design-studio"] }),
    );
    expect(scanSkills(source).some((skill) => skill.name === "design-studio:design")).toBe(false);
    mkdirSync(join(source, ".code-shell"), { recursive: true });
    writeFileSync(
      join(source, ".code-shell", "settings.json"),
      JSON.stringify({ panelAppBindings: [] }),
    );
    expect(scanSkills(source).some((skill) => skill.name === "design-studio:design")).toBe(false);
    writeFileSync(
      join(home, ".code-shell", "settings.json"),
      JSON.stringify({ disabledPanelApps: [] }),
    );
    writeFileSync(
      join(source, ".code-shell", "settings.json"),
      JSON.stringify({ panelAppBindings: ["design-studio"] }),
    );
    expect(scanSkills(source).some((skill) => skill.name === "design-studio:design")).toBe(true);

    const projectOverride = join(source, ".agents", "skills", "design-studio:design");
    mkdirSync(projectOverride, { recursive: true });
    writeFileSync(
      join(projectOverride, "SKILL.md"),
      "---\nname: design-studio:design\ndescription: Project-owned override.\n---\n",
    );
    invalidateSkillCache();
    expect(
      scanSkills(source, { includeDisabledPanelApps: true }).filter(
        (skill) => skill.name === "design-studio:design",
      ),
    ).toEqual([
      expect.objectContaining({
        source: "project",
        description: "Project-owned override.",
      }),
    ]);
  });

  test("rejects undeclared or missing schema v2 skill content", async () => {
    writePanelApp(source, { agent: true });
    writeFileSync(join(source, "agent", "skills", "design", "notes.md"), "allowed reference");
    const manifestPath = join(source, ".codeshell-panel", "panel.json");
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
      agent: { skills: string[] };
    };
    manifest.agent.skills = ["agent/skills/missing/SKILL.md"];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(previewLocalPanelApp({ kind: "dir", path: source })).rejects.toThrow(
      /declared Panel App skill is missing/,
    );
  });

  test("rejects malformed or unsupported Panel App tool schemas during review", async () => {
    writePanelApp(source, { agent: true });
    const manifestPath = join(source, ".codeshell-panel", "panel.json");
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
      agent: { tools: Array<{ inputSchema: Record<string, unknown> }> };
    };
    manifest.agent.tools[0].inputSchema = {
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        unused: { type: "array", minItems: "one" },
      },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(previewLocalPanelApp({ kind: "dir", path: source })).rejects.toThrow(
      /inputSchema is invalid/,
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

  test("rejects duplicate Host permissions instead of presenting a misleading review", async () => {
    const manifestPath = join(source, ".codeshell-panel", "panel.json");
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
      permissions: string[];
    };
    manifest.permissions.push("storage");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(previewLocalPanelApp({ kind: "dir", path: source })).rejects.toThrow(
      /permissions must not contain duplicates/,
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

  test("downloads, reviews, installs, and updates a Panel App from a GitHub monorepo subdirectory", async () => {
    const repository = mkdtempSync(join(tmpdir(), "cs-panel-git-source-"));
    const appRoot = join(repository, "examples", "panel-app");
    const cloneUrl = "https://github.com/codeshell-tests/panel-source.git";
    const previousFetch = globalThis.fetch;
    try {
      writePanelApp(appRoot, { id: "remote-panel", version: "1.0.0" });
      runGit(repository, "init", "--initial-branch=main");
      runGit(repository, "config", "user.email", "panel-tests@codeshell.local");
      runGit(repository, "config", "user.name", "Panel Tests");
      runGit(repository, "add", ".");
      runGit(repository, "commit", "-m", "initial panel");

      globalThis.fetch = async () => {
        const archive = spawnSync(
          "git",
          ["archive", "--format=zip", "--prefix=panel-source-main/", "HEAD"],
          { cwd: repository, maxBuffer: 16 * 1024 * 1024 },
        );
        if (archive.status !== 0) {
          throw new Error(`git archive failed: ${String(archive.stderr)}`);
        }
        const body = Buffer.from(archive.stdout);
        return new Response(body, {
          status: 200,
          headers: {
            "content-length": String(body.length),
            "content-type": "application/zip",
          },
        });
      };

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
      // Installing applies the exact bytes the user reviewed. Moving the
      // branch after preview must not trigger another download or silently swap
      // in a newer version.
      writePanelApp(appRoot, { id: "remote-panel", version: "1.2.0" });
      runGit(repository, "add", ".");
      runGit(repository, "commit", "-m", "move branch after review");
      expect(
        (
          await installReviewedPanelAppUpdate(
            "remote-panel",
            update.reviewToken,
            "2026-07-28T01:00:00.000Z",
          )
        ).version,
      ).toBe("1.1.0");

      const nextUpdate = await previewInstalledPanelAppUpdate("remote-panel");
      expect(nextUpdate.version).toBe("1.2.0");
      expect(
        (
          await installReviewedPanelAppUpdate(
            "remote-panel",
            nextUpdate.reviewToken,
            "2026-07-28T02:00:00.000Z",
          )
        ).version,
      ).toBe("1.2.0");
    } finally {
      globalThis.fetch = previousFetch;
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("rejects unsafe GitHub sources before downloading", async () => {
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
