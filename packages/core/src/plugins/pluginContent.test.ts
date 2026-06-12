import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
      // hooks/MCP come from the installed-plugins registry — this fixture
      // isn't registered, so this plugin contributes none.
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
      expect(inv).toEqual({ skills: [], commands: [], agents: [], hooks: [], mcpServers: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
