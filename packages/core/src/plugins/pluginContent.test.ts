import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePluginContent } from "./pluginContent.js";

function fixturePlugin(): string {
  const root = mkdtempSync(join(tmpdir(), "cs-plugin-content-"));
  // skills/alpha/SKILL.md (+ description), skills/beta/SKILL.md (no desc)
  mkdirSync(join(root, "skills", "alpha"), { recursive: true });
  writeFileSync(
    join(root, "skills", "alpha", "SKILL.md"),
    `---\nname: alpha\ndescription: 第一个技能\n---\nbody`,
  );
  mkdirSync(join(root, "skills", "beta"), { recursive: true });
  writeFileSync(join(root, "skills", "beta", "SKILL.md"), `no frontmatter body`);
  // commands + agents
  mkdirSync(join(root, "commands"), { recursive: true });
  writeFileSync(join(root, "commands", "review.md"), "x");
  writeFileSync(join(root, "commands", "notes.txt"), "ignored");
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(join(root, "agents", "helper.md"), "x");
  return root;
}

describe("describePluginContent (插件详情页 inventory)", () => {
  test("enumerates skills (with description) / commands / agents from disk", () => {
    const root = fixturePlugin();
    try {
      const inv = describePluginContent("my-plugin", root);
      expect(inv.skills).toEqual([
        { name: "alpha", description: "第一个技能" },
        { name: "beta", description: undefined },
      ]);
      expect(inv.commands).toEqual(["review"]);
      expect(inv.agents).toEqual(["helper"]);
      // Hooks come from the installed registry; this fixture has no MCP file.
      expect(inv.hooks).toEqual([]);
      expect(inv.mcpServers).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing directories yield empty lists, not errors", () => {
    const root = mkdtempSync(join(tmpdir(), "cs-plugin-empty-"));
    try {
      const inv = describePluginContent("empty", root);
      expect(inv).toEqual({
        skills: [],
        commands: [],
        agents: [],
        hooks: [],
        mcpServers: [],
        panels: [],
        automationTemplates: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("inventories declared MCP servers even while runtime approval is pending", () => {
    const root = mkdtempSync(join(tmpdir(), "cs-plugin-mcp-content-"));
    try {
      writeFileSync(
        join(root, "mcp-servers.json"),
        JSON.stringify({
          "demo:stdio": { command: "demo-mcp", name: "demo:stdio" },
          "demo:remote": { url: "https://example.com/mcp", name: "demo:remote" },
        }),
      );
      expect(describePluginContent("demo", root).mcpServers).toEqual(["remote", "stdio"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("inventories automation templates with a review revision", () => {
    const root = mkdtempSync(join(tmpdir(), "cs-plugin-automation-content-"));
    try {
      writeFileSync(
        join(root, ".cs-plugin-manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          name: "demo",
          automations: {
            version: 1,
            templates: [
              {
                id: "daily-review",
                title: { default: "Daily review" },
                schedule: "1d",
                prompt: "Review pending work.",
              },
            ],
          },
        }),
      );
      expect(describePluginContent("demo", root, "demo@local").automationTemplates).toEqual([
        expect.objectContaining({
          id: "daily-review",
          permissionLevel: "read-only",
          workspace: "current",
          revision: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not inventory contribution symlinks that escape the plugin root", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "cs-plugin-content-safe-"));
    const outside = mkdtempSync(join(tmpdir(), "cs-plugin-content-outside-"));
    try {
      mkdirSync(join(root, "commands"), { recursive: true });
      mkdirSync(join(root, "skills", "leak"), { recursive: true });
      writeFileSync(join(outside, "private.md"), "private command");
      writeFileSync(join(outside, "SKILL.md"), "---\ndescription: private\n---\nprivate skill");
      symlinkSync(join(outside, "private.md"), join(root, "commands", "leak.md"));
      symlinkSync(join(outside, "SKILL.md"), join(root, "skills", "leak", "SKILL.md"));

      const inv = describePluginContent("unsafe", root);
      expect(inv.commands).toEqual([]);
      expect(inv.skills).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
