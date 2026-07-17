import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  symlinkSync,
  truncateSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installPluginFromPath } from "./install.js";
import { readInstalledPlugins } from "../installedPlugins.js";

const STAMP = "2026-05-29T10:00:00Z";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02,
  0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
]);
const WEBP = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJQBOgCHwAP7+4AAA", "base64");

describe("installPluginFromPath", () => {
  let home: string, src: string, prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-home-"));
    src = mkdtempSync(join(tmpdir(), "cs-src-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  test("installs a CC plugin: copies dir + writes cc meta", async () => {
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
    const dir = await installPluginFromPath(src, "ccplug", STAMP);
    expect(existsSync(join(dir, "skills", "s", "SKILL.md"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, ".cs-meta.json"), "utf-8"));
    expect(meta).toMatchObject({ name: "ccplug", format: "cc", source: src, installedAt: STAMP });
    const entry = readInstalledPlugins().plugins["ccplug@local"]?.[0];
    expect(entry?.approvedMcpDigest).toBe(entry?.mcpDigest);
  });

  test("CC plugin: records the version from .claude-plugin/plugin.json (not 'local')", async () => {
    mkdirSync(join(src, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(src, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "verplug", version: "0.1.0", description: "d" }),
    );
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
    await installPluginFromPath(src, "verplug", STAMP);
    const installed = readInstalledPlugins();
    const entry = installed.plugins["verplug@local"]?.[0];
    expect(entry?.version).toBe("0.1.0");
  });

  test("CC plugin without a manifest version records no version (falls back to source tag)", async () => {
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
    await installPluginFromPath(src, "noverplug", STAMP);
    const installed = readInstalledPlugins();
    const entry = installed.plugins["noverplug@local"]?.[0];
    // appendInstallEntry falls back to "local" when meta.version is undefined.
    expect(entry?.version).toBe("local");
  });

  test("rewrites CLAUDE_PLUGIN_ROOT placeholders in the installed local copy", async () => {
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
    mkdirSync(join(src, "hooks"), { recursive: true });
    writeFileSync(
      join(src, "hooks", "hooks.json"),
      JSON.stringify({
        SessionStart: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/run" }] }],
      }),
    );
    const dir = await installPluginFromPath(src, "rewriteplug", STAMP);

    const installedHooks = readFileSync(join(dir, "hooks", "hooks.json"), "utf-8");
    expect(installedHooks).toContain("${CODESHELL_PLUGIN_ROOT}/run");
    expect(installedHooks).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(existsSync(join(dir, ".code-shell-installed.json"))).toBe(true);
  });

  test("installs a Codex plugin: converts agent + writes mcp-servers.json + codex meta", async () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "cx", version: "2.0.0", mcpServers: { fs: { command: "f" } } }),
    );
    mkdirSync(join(src, "agents"), { recursive: true });
    writeFileSync(join(src, "agents", "r.toml"), 'name = "r"\ndescription = "d"\nmodel = "flash"');
    mkdirSync(join(src, "prompts"), { recursive: true });
    writeFileSync(
      join(src, "prompts", "draftpr.md"),
      "---\ndescription: draft a PR\n---\nDraft $1",
    );
    const dir = await installPluginFromPath(src, "cx", STAMP);
    const md = readFileSync(join(dir, "agents", "r.md"), "utf-8");
    expect(md).toContain("name: r");
    expect(md).toContain("model: flash");
    // Codex prompts → CC commands/ so pluginCommandsLoader picks them up.
    expect(existsSync(join(dir, "commands", "draftpr.md"))).toBe(true);
    const mcp = JSON.parse(readFileSync(join(dir, "mcp-servers.json"), "utf-8"));
    expect(mcp["cx:fs"]).toMatchObject({ command: "f", name: "cx:fs" });
    const entry = readInstalledPlugins().plugins["cx@local"]?.[0];
    expect(entry?.mcpDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(entry?.approvedMcpDigest).toBeUndefined();
    const meta = JSON.parse(readFileSync(join(dir, ".cs-meta.json"), "utf-8"));
    expect(meta).toMatchObject({ name: "cx", format: "codex", version: "2.0.0" });
  });

  test("rejects a Codex plugin with an invalid MCP transport contract", async () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "bad-mcp",
        version: "1.0.0",
        mcpServers: {
          broken: { transport: "streamable-http" },
        },
      }),
    );

    await expect(installPluginFromPath(src, "bad-mcp", STAMP)).rejects.toThrow(
      /invalid plugin MCP/,
    );
  });

  test("Codex install preserves hook scripts and normalizes manifest hook paths", async () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    mkdirSync(join(src, "lifecycle"), { recursive: true });
    mkdirSync(join(src, "scripts"), { recursive: true });
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "hook-cx",
        version: "1.0.0",
        hooks: "./lifecycle/hooks.json",
      }),
    );
    writeFileSync(
      join(src, "lifecycle", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "node $PLUGIN_ROOT/scripts/start.mjs",
                },
              ],
            },
          ],
        },
      }),
    );
    writeFileSync(join(src, "scripts", "start.mjs"), "console.log('{}')");

    const dir = await installPluginFromPath(src, "hook-cx", STAMP);
    expect(existsSync(join(dir, "scripts", "start.mjs"))).toBe(true);
    const hooks = JSON.parse(readFileSync(join(dir, "hooks", "hooks.json"), "utf-8"));
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toContain(
      "$PLUGIN_ROOT/scripts/start.mjs",
    );
    const entry = readInstalledPlugins().plugins["hook-cx@local"]?.[0];
    expect(entry?.hookDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(entry?.approvedHookDigest).toBeUndefined();
  });

  test("writes a canonical manifest and copies Codex panel assets", async () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    mkdirSync(join(src, ".codeshell-plugin"), { recursive: true });
    mkdirSync(join(src, "assets"), { recursive: true });
    mkdirSync(join(src, "panels", "dashboard"), { recursive: true });
    writeFileSync(join(src, "assets", "composer.jpg"), JPEG);
    writeFileSync(join(src, "assets", "logo.webp"), WEBP);
    writeFileSync(join(src, "assets", "logo-dark.png"), PNG);
    writeFileSync(join(src, "assets", "screenshot-1.png"), PNG);
    writeFileSync(join(src, "assets", "screenshot-2.png"), PNG);
    writeFileSync(
      join(src, "panels", "dashboard", "index.html"),
      "<script src='./app.js'></script>",
    );
    writeFileSync(join(src, "panels", "dashboard", "app.js"), "document.body.textContent='ok'");
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "panel-cx",
        version: "1.0.0",
        interface: {
          displayName: "Panel CX",
          shortDescription: "A compact panel plugin",
          longDescription: "A longer explanation of the installed plugin.",
          developerName: "CodeShell",
          category: "Developer tools",
          capabilities: ["Read"],
          websiteURL: "https://example.com/panel-cx",
          privacyPolicyURL: "https://example.com/privacy",
          termsOfServiceURL: "https://example.com/terms",
          defaultPrompt: ["Open the build dashboard."],
          brandColor: "#10A37F",
          composerIcon: "./assets/composer.jpg",
          logo: "./assets/logo.webp",
          logoDark: "./assets/logo-dark.png",
          screenshots: ["./assets/screenshot-1.png", "./assets/screenshot-2.png"],
        },
      }),
    );
    writeFileSync(
      join(src, ".codeshell-plugin", "plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        panels: {
          version: 1,
          entries: [
            {
              id: "dashboard",
              title: { default: "Dashboard" },
              entry: "panels/dashboard/index.html",
              permissions: ["context.session"],
            },
          ],
        },
        automations: {
          version: 1,
          templates: [
            {
              id: "weekday-review",
              title: { default: "Weekday review" },
              schedule: "0 9 * * 1-5",
              prompt: "Inspect pending work and report risks.",
            },
          ],
        },
      }),
    );

    const dir = await installPluginFromPath(src, "panel-cx", STAMP);
    const canonical = JSON.parse(readFileSync(join(dir, ".cs-plugin-manifest.json"), "utf-8"));
    expect(canonical.panels.entries[0]).toMatchObject({
      id: "dashboard",
      entry: "panels/dashboard/index.html",
      permissions: ["context.session"],
    });
    expect(canonical.automations.templates[0]).toMatchObject({
      id: "weekday-review",
      permissionLevel: "read-only",
      workspace: "current",
    });
    expect(canonical.interface).toEqual({
      displayName: "Panel CX",
      shortDescription: "A compact panel plugin",
      longDescription: "A longer explanation of the installed plugin.",
      developerName: "CodeShell",
      category: "Developer tools",
      capabilities: ["Read"],
      websiteURL: "https://example.com/panel-cx",
      privacyPolicyURL: "https://example.com/privacy",
      termsOfServiceURL: "https://example.com/terms",
      defaultPrompt: ["Open the build dashboard."],
      brandColor: "#10A37F",
      composerIcon: ".cs-plugin-assets/composer-icon.jpeg",
      logo: ".cs-plugin-assets/logo.webp",
      logoDark: ".cs-plugin-assets/logo-dark.png",
      screenshots: [".cs-plugin-assets/screenshot-1.png", ".cs-plugin-assets/screenshot-2.png"],
    });
    expect(readFileSync(join(dir, canonical.interface.composerIcon))).toEqual(JPEG);
    expect(readFileSync(join(dir, canonical.interface.logo))).toEqual(WEBP);
    expect(readFileSync(join(dir, canonical.interface.logoDark))).toEqual(PNG);
    expect(readFileSync(join(dir, canonical.interface.screenshots[0]))).toEqual(PNG);
    expect(readFileSync(join(dir, "panels", "dashboard", "app.js"), "utf-8")).toContain("ok");
  });

  test("rejects an invalid plugin automation schedule before installation", async () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    mkdirSync(join(src, ".codeshell-plugin"), { recursive: true });
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "bad-automation", version: "1.0.0" }),
    );
    writeFileSync(
      join(src, ".codeshell-plugin", "plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        automations: {
          version: 1,
          templates: [
            {
              id: "broken",
              title: { default: "Broken" },
              schedule: "99 9 * * *",
              prompt: "This must never be installed.",
            },
          ],
        },
      }),
    );

    await expect(installPluginFromPath(src, "bad-automation", STAMP)).rejects.toThrow(
      /automation template 'broken' has an invalid schedule/,
    );
    expect(existsSync(join(home, ".code-shell", "plugins", "bad-automation"))).toBe(false);
  });

  test("rejects an invalid plugin automation timezone even for interval schedules", async () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    mkdirSync(join(src, ".codeshell-plugin"), { recursive: true });
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "bad-timezone", version: "1.0.0" }),
    );
    writeFileSync(
      join(src, ".codeshell-plugin", "plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        automations: {
          version: 1,
          templates: [
            {
              id: "broken-zone",
              title: { default: "Broken timezone" },
              schedule: "1d",
              timezone: "Not/A_Real_Zone",
              prompt: "This must never be installed.",
            },
          ],
        },
      }),
    );

    await expect(installPluginFromPath(src, "bad-timezone", STAMP)).rejects.toThrow(
      /automation template 'broken-zone' has an invalid schedule/,
    );
  });

  test("does not touch plugin files when no interface assets are declared", async () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    mkdirSync(join(src, ".cs-plugin-assets"), { recursive: true });
    writeFileSync(join(src, ".cs-plugin-assets", "author-owned.txt"), "keep");
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "no-rich-media",
        version: "1.0.0",
        interface: { displayName: "No rich media" },
      }),
    );

    const dir = await installPluginFromPath(src, "no-rich-media", STAMP);
    expect(readFileSync(join(dir, ".cs-plugin-assets", "author-owned.txt"), "utf8")).toBe("keep");
  });

  test("rejects missing, unsupported, and extension-spoofed rich media", async () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    mkdirSync(join(src, "assets"), { recursive: true });
    writeFileSync(join(src, "assets", "vector.svg"), "<svg/>");
    writeFileSync(join(src, "assets", "spoof.png"), "<svg/>");

    for (const [name, logo] of [
      ["missing-media", "./assets/missing.png"],
      ["svg-media", "./assets/vector.svg"],
      ["spoofed-media", "./assets/spoof.png"],
    ] as const) {
      writeFileSync(
        join(src, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name, version: "1.0.0", interface: { logo } }),
      );
      await expect(installPluginFromPath(src, name, STAMP)).rejects.toThrow();
      expect(existsSync(join(home, ".code-shell", "plugins", name))).toBe(false);
    }
  });

  test("rejects escaping asset symlinks and oversized brand images", async () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    mkdirSync(join(src, "assets"), { recursive: true });
    const outside = join(home, "outside.png");
    writeFileSync(outside, PNG);
    symlinkSync(outside, join(src, "assets", "escape.png"));
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "asset-escape",
        version: "1.0.0",
        interface: { logo: "./assets/escape.png" },
      }),
    );
    await expect(installPluginFromPath(src, "asset-escape", STAMP)).rejects.toThrow(/escapes/);
    rmSync(join(src, "assets", "escape.png"), { force: true });

    const huge = join(src, "assets", "huge.png");
    writeFileSync(huge, PNG);
    truncateSync(huge, 2 * 1024 * 1024 + 1);
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "asset-huge",
        version: "1.0.0",
        interface: { logo: "./assets/huge.png" },
      }),
    );
    await expect(installPluginFromPath(src, "asset-huge", STAMP)).rejects.toThrow(/2 MiB/);
  });

  test("rejects decompression-bomb dimensions and non-HTTPS legal links", async () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    mkdirSync(join(src, "assets"), { recursive: true });
    const bomb = Buffer.from(PNG);
    bomb.writeUInt32BE(9000, 16);
    writeFileSync(join(src, "assets", "bomb.png"), bomb);
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "asset-dimensions",
        version: "1.0.0",
        interface: { logo: "./assets/bomb.png" },
      }),
    );
    await expect(installPluginFromPath(src, "asset-dimensions", STAMP)).rejects.toThrow(
      /dimensions exceed/,
    );

    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "unsafe-legal-url",
        version: "1.0.0",
        interface: { websiteURL: "http://example.com/plugin" },
      }),
    );
    await expect(installPluginFromPath(src, "unsafe-legal-url", STAMP)).rejects.toThrow(/https/);

    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "unsafe-legal-credentials",
        version: "1.0.0",
        interface: { termsOfServiceURL: "https://user:password@example.com/terms" },
      }),
    );
    await expect(installPluginFromPath(src, "unsafe-legal-credentials", STAMP)).rejects.toThrow(
      /https/,
    );
  });

  test("enforces the screenshot assets/ PNG and count contract", async () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    mkdirSync(join(src, "assets"), { recursive: true });
    mkdirSync(join(src, "other"), { recursive: true });
    writeFileSync(join(src, "assets", "shot.jpg"), JPEG);
    writeFileSync(join(src, "other", "shot.png"), PNG);
    writeFileSync(join(src, "assets", "huge.png"), PNG);
    truncateSync(join(src, "assets", "huge.png"), 5 * 1024 * 1024 + 1);

    for (const [name, screenshots] of [
      ["screenshot-jpeg", ["./assets/shot.jpg"]],
      ["screenshot-outside-assets", ["./other/shot.png"]],
      ["screenshot-huge", ["./assets/huge.png"]],
      [
        "screenshot-count",
        ["./assets/1.png", "./assets/2.png", "./assets/3.png", "./assets/4.png"],
      ],
    ] as const) {
      writeFileSync(
        join(src, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name, version: "1.0.0", interface: { screenshots } }),
      );
      await expect(installPluginFromPath(src, name, STAMP)).rejects.toThrow();
    }
  });

  test("rejects a panel entry symlink that escapes the plugin root", async () => {
    const outside = join(home, "outside.html");
    writeFileSync(outside, "secret");
    mkdirSync(join(src, ".claude-plugin"), { recursive: true });
    mkdirSync(join(src, "panels"), { recursive: true });
    symlinkSync(outside, join(src, "panels", "index.html"));
    writeFileSync(
      join(src, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "escape",
        version: "1",
        panels: {
          version: 1,
          entries: [{ id: "escape", title: { default: "Escape" }, entry: "panels/index.html" }],
        },
      }),
    );

    await expect(installPluginFromPath(src, "escape", STAMP)).rejects.toThrow(/escapes/);
    expect(existsSync(join(home, ".code-shell", "plugins", "escape"))).toBe(false);
  });

  test("refuses when install dir already exists", async () => {
    mkdirSync(join(home, ".code-shell", "plugins", "dup"), { recursive: true });
    await expect(installPluginFromPath(src, "dup", STAMP)).rejects.toThrow(/already installed/);
  });

  test("isolates concurrent same-name install staging directories", async () => {
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");

    const results = await Promise.allSettled([
      installPluginFromPath(src, "concurrent", STAMP),
      installPluginFromPath(src, "concurrent", STAMP),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(existsSync(join(home, ".code-shell", "plugins", "concurrent"))).toBe(true);
    const rootEntries = readdirSync(join(home, ".code-shell", "plugins"));
    expect(rootEntries.some((entry) => entry.startsWith(".tmp-concurrent-"))).toBe(false);
    expect(readInstalledPlugins().plugins["concurrent@local"]).toHaveLength(1);
  });

  test("registers the install in installed_plugins.json", async () => {
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
    const dir = await installPluginFromPath(src, "regplug", STAMP);
    const reg = readInstalledPlugins();
    const entry = reg.plugins["regplug@local"]?.[0];
    expect(entry?.installPath).toBe(dir);
    expect(entry?.version).toBeDefined();
    expect(entry?.hookDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(entry?.approvedHookDigest).toBe(entry?.hookDigest);
    expect(entry?.approvedMcpDigest).toBe(entry?.mcpDigest);
  });

  test("leaves no install dir when conversion fails", async () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "x", version: "1" }),
    );
    mkdirSync(join(src, "agents"), { recursive: true });
    writeFileSync(join(src, "agents", "bad.toml"), 'description = "no name"');
    await expect(installPluginFromPath(src, "x", STAMP)).rejects.toThrow(/name/);
    expect(existsSync(join(home, ".code-shell", "plugins", "x"))).toBe(false);
  });
});
