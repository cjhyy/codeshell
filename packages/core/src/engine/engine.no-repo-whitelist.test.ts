import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { invalidateSkillCache } from "../skills/scanner.js";

const baseLlm = { provider: "openai", model: "gpt-5", apiKey: "test-key" } as any;

/**
 * no-repo "conversation" scope inverts skill/plugin filtering to a WHITELIST:
 * when config.cwd === ~/.code-shell/no-repo, every installed skill/plugin is
 * disabled UNLESS the project capabilityOverrides marks it "on". Real project
 * cwds keep the normal denylist (default-enabled). buildToolContext() surfaces
 * the effective disabledSkills/disabledPlugins, so we assert through it.
 */
describe("Engine no-repo whitelist (default-all-off + opt-in)", () => {
  let home: string;
  let noRepo: string;
  let proj: string;
  let prevHome: string | undefined;

  function noRepoOf(h: string): string {
    return join(h, ".code-shell", "no-repo");
  }

  /** Install a user-level skill at ~/.code-shell/skills/<name>/SKILL.md. */
  function installUserSkill(name: string): void {
    const dir = join(home, ".code-shell", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test skill ${name}\n---\nbody`);
  }

  /**
   * Install a plugin <plugin>@<marketplace> with a single namespaced skill
   * <plugin>:<skill>. Returns nothing; updates installed_plugins.json.
   */
  function installPlugin(plugin: string, marketplace: string, skill: string): void {
    const installPath = join(home, ".code-shell", "plugins", "store", `${plugin}@${marketplace}`);
    const skillDir = join(installPath, "skills", skill);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: ${skill}\ndescription: plugin skill ${skill}\n---\nbody`,
    );
    const file = join(home, ".code-shell", "plugins", "installed_plugins.json");
    mkdirSync(join(home, ".code-shell", "plugins"), { recursive: true });
    // Read-modify-write a minimal V2 file.
    let data: any = { version: 2, plugins: {} };
    try {
      data = JSON.parse(require("node:fs").readFileSync(file, "utf-8"));
    } catch {
      /* fresh */
    }
    const key = `${plugin}@${marketplace}`;
    data.plugins[key] = [
      {
        scope: "user",
        installPath,
        version: "1.0.0",
        installedAt: "2026-06-11T00:00:00Z",
        lastUpdated: "2026-06-11T00:00:00Z",
      },
    ];
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  }

  function writeNoRepoOverrides(overrides: Record<string, unknown>): void {
    const dir = join(noRepo, ".code-shell");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ capabilityOverrides: overrides }));
  }

  function writeProjectOverrides(dir: string, overrides: Record<string, unknown>): void {
    const cfg = join(dir, ".code-shell");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ capabilityOverrides: overrides }));
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "norepo-home-"));
    process.env.CODE_SHELL_HOME = home;
    prevHome = process.env.HOME;
    process.env.HOME = home;
    noRepo = noRepoOf(home);
    mkdirSync(noRepo, { recursive: true });
    proj = mkdtempSync(join(tmpdir(), "norepo-proj-"));
    invalidateSkillCache();
  });

  afterEach(() => {
    delete process.env.CODE_SHELL_HOME;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
    invalidateSkillCache();
  });

  it("no-repo + no override → ALL installed skills and plugins disabled", () => {
    installUserSkill("alpha");
    installUserSkill("beta");
    installPlugin("superpowers", "market", "brainstorming");

    const engine = new Engine({ llm: baseLlm, cwd: noRepo });
    const ctx = engine.buildToolContext();

    // Every installed skill name (incl. the plugin-namespaced one) is disabled.
    expect(new Set(ctx.disabledSkills)).toEqual(
      new Set(["alpha", "beta", "superpowers:brainstorming"]),
    );
    // The plugin itself is disabled (so loadPluginHooks suppresses SessionStart).
    expect(ctx.disabledPlugins).toEqual(["superpowers"]);
  });

  it("no-repo + skill override 'on' → only that skill survives", () => {
    installUserSkill("alpha");
    installUserSkill("beta");
    writeNoRepoOverrides({ skills: { alpha: "on" } });

    const engine = new Engine({ llm: baseLlm, cwd: noRepo });
    const ctx = engine.buildToolContext();

    expect(ctx.disabledSkills).toEqual(["beta"]); // alpha allowed, beta off
  });

  it("no-repo + plugin override 'on' → only that plugin survives", () => {
    installPlugin("superpowers", "market", "brainstorming");
    installPlugin("other", "market", "thing");
    writeNoRepoOverrides({ plugins: { superpowers: "on" } });

    const engine = new Engine({ llm: baseLlm, cwd: noRepo });
    const ctx = engine.buildToolContext();

    expect(new Set(ctx.disabledPlugins)).toEqual(new Set(["other"]));
  });

  it("newly installed skill (not in override) is auto-disabled in no-repo", () => {
    installUserSkill("alpha");
    writeNoRepoOverrides({ skills: { alpha: "on" } });
    // A skill installed later with no override.
    installUserSkill("freshly-added");
    invalidateSkillCache();

    const engine = new Engine({ llm: baseLlm, cwd: noRepo });
    const ctx = engine.buildToolContext();

    expect(ctx.disabledSkills).toEqual(["freshly-added"]);
  });

  it("real project cwd is unaffected → denylist (no override ⇒ nothing disabled)", () => {
    installUserSkill("alpha");
    installPlugin("superpowers", "market", "brainstorming");

    const engine = new Engine({ llm: baseLlm, cwd: proj });
    const ctx = engine.buildToolContext();

    expect(ctx.disabledSkills).toEqual([]);
    expect(ctx.disabledPlugins).toEqual([]);
  });

  it("real project cwd still honors denylist override (skill 'off')", () => {
    installUserSkill("alpha");
    writeProjectOverrides(proj, { skills: { alpha: "off" } });

    const engine = new Engine({ llm: baseLlm, cwd: proj });
    const ctx = engine.buildToolContext();

    expect(ctx.disabledSkills).toEqual(["alpha"]);
  });

  it("sub-agent in no-repo still gets empty lists (minimal surface, branch skipped)", () => {
    installUserSkill("alpha");
    installPlugin("superpowers", "market", "brainstorming");

    const engine = new Engine({ llm: baseLlm, cwd: noRepo, isSubAgent: true } as any);
    const ctx = engine.buildToolContext();

    expect(ctx.disabledSkills).toEqual([]);
    expect(ctx.disabledPlugins).toEqual([]);
  });
});
