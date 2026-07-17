import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installReviewedLocalPlugin,
  LocalPluginReviewChangedError,
  previewLocalPlugin,
} from "./preview.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function zipDirectory(source: string, target: string): void {
  execFileSync("zip", ["-r", "-q", target, "."], { cwd: source });
}

describe("previewLocalPlugin", () => {
  let home: string;
  let scratch: string;
  let source: string;
  let previewTmp: string;
  let previousHome: string | undefined;
  let previousTmp: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    previousTmp = process.env.TMPDIR;
    home = mkdtempSync(join(tmpdir(), "plugin-preview-home-"));
    scratch = mkdtempSync(join(tmpdir(), "plugin-preview-work-"));
    source = join(scratch, "source");
    previewTmp = join(scratch, "preview-tmp");
    mkdirSync(source, { recursive: true });
    mkdirSync(previewTmp, { recursive: true });
    process.env.HOME = home;
    process.env.TMPDIR = previewTmp;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
    process.env.TMPDIR = previousTmp;
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  function writeCodexPlugin(): void {
    mkdirSync(join(source, ".codex-plugin"), { recursive: true });
    mkdirSync(join(source, ".codeshell-plugin"), { recursive: true });
    mkdirSync(join(source, "skills", "review-skill"), { recursive: true });
    mkdirSync(join(source, "prompts"), { recursive: true });
    mkdirSync(join(source, "agents"), { recursive: true });
    mkdirSync(join(source, "panels"), { recursive: true });
    mkdirSync(join(source, "assets"), { recursive: true });
    writeFileSync(
      join(source, "skills", "review-skill", "SKILL.md"),
      "---\nname: review-skill\ndescription: Reviews releases\n---\nBody\n",
    );
    writeFileSync(join(source, "prompts", "review.md"), "Review $ARGUMENTS\n");
    writeFileSync(
      join(source, "agents", "reviewer.toml"),
      'name = "reviewer"\ndescription = "Reviews changes"\ndeveloper_instructions = "Be careful."\n',
    );
    writeFileSync(join(source, "panels", "review.html"), "<!doctype html><title>Review</title>");
    writeFileSync(join(source, "assets", "logo.png"), PNG_1X1);
    writeFileSync(
      join(source, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "Review Plugin",
        version: "1.2.3",
        description: "Review plugin",
        interface: {
          displayName: "Review Plugin",
          websiteURL: "https://example.com/plugin",
          privacyPolicyURL: "https://example.com/privacy",
          logo: "./assets/logo.png",
        },
        panels: {
          version: 1,
          entries: [
            {
              id: "review",
              title: { default: "Review" },
              entry: "panels/review.html",
              permissions: ["context.session", "agent.submitPrompt"],
            },
          ],
        },
        hooks: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [{ type: "command", command: "node scripts/start.js" }],
            },
          ],
        },
        mcpServers: {
          local: { command: "node", args: ["server.js"] },
          remote: {
            transport: "streamable-http",
            url: "https://example.com/mcp",
          },
        },
      }),
    );
    writeFileSync(
      join(source, ".codeshell-plugin", "plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        automations: {
          version: 1,
          templates: [
            {
              id: "weekday-review",
              title: { default: "Weekday review" },
              schedule: "0 9 * * 1-5",
              prompt: "Inspect pending work without changing files.",
            },
          ],
        },
      }),
    );
  }

  test("projects authoritative contents and trust warnings without installed-state mutation", async () => {
    writeCodexPlugin();

    const preview = await previewLocalPlugin({ kind: "dir", path: source });

    expect(preview.name).toBe("review-plugin");
    expect(preview.format).toBe("codex");
    expect(preview.version).toBe("1.2.3");
    expect(preview.skills).toEqual([{ name: "review-skill", description: "Reviews releases" }]);
    expect(preview.commands).toEqual(["review"]);
    expect(preview.agents).toEqual(["reviewer"]);
    expect(preview.hooks).toEqual([
      {
        event: "SessionStart",
        matcher: "startup",
        matcherTruncated: false,
        command: "node scripts/start.js",
        commandTruncated: false,
      },
    ]);
    expect(preview.mcpServers.map(({ name, transport }) => ({ name, transport }))).toEqual([
      { name: "local", transport: "stdio" },
      { name: "remote", transport: "streamable-http" },
    ]);
    expect(preview.panels[0]?.permissions).toEqual(["context.session", "agent.submitPrompt"]);
    expect(preview.automationTemplates).toEqual([
      expect.objectContaining({
        id: "weekday-review",
        schedule: "0 9 * * 1-5",
        permissionLevel: "read-only",
        workspace: "current",
      }),
    ]);
    expect(preview.interface.externalLinks).toEqual([
      { kind: "website", url: "https://example.com/plugin" },
      { kind: "privacy", url: "https://example.com/privacy" },
    ]);
    expect(preview.interface.media.logo).toMatch(/logo\.png$/);
    expect(preview.warnings.map((warning) => warning.kind)).toEqual([
      "executable-hooks",
      "stdio-mcp",
      "network-mcp",
      "panel-permissions",
      "automation-templates",
      "external-links",
      "media",
    ]);
    expect(preview.reviewToken).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.alreadyInstalled).toBe(false);
    expect(existsSync(join(home, ".code-shell", "plugins"))).toBe(false);
    expect(readdirSync(previewTmp)).toEqual([]);
  });

  test("uses the same safe zip extraction and cleans every temporary directory", async () => {
    writeCodexPlugin();
    const archive = join(scratch, "review.zip");
    zipDirectory(source, archive);

    const preview = await previewLocalPlugin({ kind: "zip", path: archive });

    expect(preview.name).toBe("review-plugin");
    expect(preview.source.kind).toBe("zip");
    expect(readdirSync(previewTmp)).toEqual([]);
    expect(existsSync(join(home, ".code-shell", "plugins"))).toBe(false);
  });

  test("source changes produce a new review token", async () => {
    writeCodexPlugin();
    const before = await previewLocalPlugin({ kind: "dir", path: source });
    writeFileSync(join(source, "server.js"), "console.log('changed')\n");
    const after = await previewLocalPlugin({ kind: "dir", path: source });
    expect(after.reviewToken).not.toBe(before.reviewToken);
  });

  test("installs only the private snapshot that matches the review token", async () => {
    writeCodexPlugin();
    const preview = await previewLocalPlugin({ kind: "dir", path: source });

    const installed = await installReviewedLocalPlugin(
      { kind: "dir", path: source },
      preview.reviewToken,
      "2026-07-17T00:00:00.000Z",
    );

    expect(installed.name).toBe("review-plugin");
    expect(existsSync(join(installed.dir, "commands", "review.md"))).toBe(true);
    expect(readdirSync(previewTmp)).toEqual([]);
  });

  test("rejects changed sources and symbolic links before installed-state mutation", async () => {
    writeCodexPlugin();
    const preview = await previewLocalPlugin({ kind: "dir", path: source });
    writeFileSync(join(source, "server.js"), "changed after review\n");
    await expect(
      installReviewedLocalPlugin(
        { kind: "dir", path: source },
        preview.reviewToken,
        "2026-07-17T00:00:00.000Z",
      ),
    ).rejects.toBeInstanceOf(LocalPluginReviewChangedError);
    expect(existsSync(join(home, ".code-shell", "plugins", "review-plugin"))).toBe(false);

    rmSync(source, { recursive: true, force: true });
    mkdirSync(join(source, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(source, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "linked-plugin" }),
    );
    const outside = join(scratch, "outside.md");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(source, "linked.md"));
    await expect(previewLocalPlugin({ kind: "dir", path: source })).rejects.toThrow(
      /must not contain symbolic links/,
    );
    expect(existsSync(join(home, ".code-shell", "plugins", "linked-plugin"))).toBe(false);
  });

  test("invalid hooks and oversized preview output fail before installation", async () => {
    mkdirSync(join(source, ".claude-plugin"), { recursive: true });
    mkdirSync(join(source, "hooks"), { recursive: true });
    writeFileSync(
      join(source, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "invalid-hooks" }),
    );
    writeFileSync(
      join(source, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { SessionStart: "not-an-array" } }),
    );
    await expect(previewLocalPlugin({ kind: "dir", path: source })).rejects.toThrow(
      /invalid plugin hooks/,
    );
    expect(existsSync(join(home, ".code-shell", "plugins"))).toBe(false);

    rmSync(join(source, "hooks"), { recursive: true, force: true });
    mkdirSync(join(source, "commands"), { recursive: true });
    for (let index = 0; index < 257; index += 1) {
      writeFileSync(join(source, "commands", `command-${index}.md`), "body\n");
    }
    await expect(previewLocalPlugin({ kind: "dir", path: source })).rejects.toThrow(
      /more than 256/,
    );
    expect(existsSync(join(home, ".code-shell", "plugins"))).toBe(false);
  });
});
