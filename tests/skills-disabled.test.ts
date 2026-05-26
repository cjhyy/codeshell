/**
 * settings.disabledSkills end-to-end coverage.
 *
 * The UI's per-skill disable toggle writes settings.disabledSkills into
 * ~/.code-shell/settings.json. Before the fix, nothing consumed it:
 * scanSkills returned every skill, the system prompt listed every skill,
 * and the skill builtin tool accepted every name. These tests pin the
 * three consumption points so the regression can't return silently.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanSkills, invalidateSkillCache } from "../packages/core/src/skills/scanner.js";
import { skillTool } from "../packages/core/src/tool-system/builtin/skill.js";
import { PromptComposer } from "../packages/core/src/prompt/composer.js";

function makeSkill(base: string, name: string, description: string, body: string) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\ndescription: ${description}\n---\n${body}`,
  );
}

describe("settings.disabledSkills — scanner", () => {
  let projectRoot: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    invalidateSkillCache();
    projectRoot = mkdtempSync(join(tmpdir(), "disabled-skills-proj-"));
    fakeHome = mkdtempSync(join(tmpdir(), "disabled-skills-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    invalidateSkillCache();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it("filters out a disabled user skill", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    makeSkill(userBase, "alpha", "first", "alpha body");
    makeSkill(userBase, "beta", "second", "beta body");

    const skills = scanSkills(projectRoot, { disabledSkills: ["alpha"] });
    const names = skills.map((s) => s.name);
    expect(names).toContain("beta");
    expect(names).not.toContain("alpha");
  });

  it("filters plugin skills by their fully namespaced name", () => {
    // Mirror tests/skills-scanner.test.ts plugin fixture: write an
    // installed_plugins.json that points at a plugin install dir with a
    // skills/ tree. The filter takes the full "<plugin>:<skill>" name —
    // un-prefixed "foo" must NOT trip the filter.
    const cache = mkdtempSync(join(tmpdir(), "disabled-plugin-cache-"));
    try {
      const skillDir = join(cache, "skills", "foo");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\ndescription: foo desc\n---\nfoo body",
      );

      const pluginsDir = join(fakeHome, ".code-shell", "plugins");
      mkdirSync(pluginsDir, { recursive: true });
      writeFileSync(
        join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "fake-plugin@mkt": [
              {
                scope: "user",
                installPath: cache,
                version: "v1",
                installedAt: "t",
                lastUpdated: "t",
              },
            ],
          },
        }),
      );

      // Sanity: with no filter the namespaced skill is present.
      const all = scanSkills(projectRoot);
      expect(all.find((s) => s.name === "fake-plugin:foo")).toBeDefined();

      // With the namespaced name disabled, it is filtered.
      invalidateSkillCache();
      const filtered = scanSkills(projectRoot, {
        disabledSkills: ["fake-plugin:foo"],
      });
      expect(filtered.find((s) => s.name === "fake-plugin:foo")).toBeUndefined();

      // The bare "foo" form must NOT be treated as a match — namespace
      // matters. (Defends against a "clever" prefix-strip refactor.)
      invalidateSkillCache();
      const stillThere = scanSkills(projectRoot, { disabledSkills: ["foo"] });
      expect(stillThere.find((s) => s.name === "fake-plugin:foo")).toBeDefined();
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("scanSkills(cwd) without opts returns every skill (regression guard)", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    makeSkill(userBase, "one", "1", "b");
    makeSkill(userBase, "two", "2", "b");

    const skills = scanSkills(projectRoot);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["one", "two"]);
  });

  it("empty disabledSkills array is a no-op", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    makeSkill(userBase, "solo", "desc", "body");

    const skills = scanSkills(projectRoot, { disabledSkills: [] });
    expect(skills.find((s) => s.name === "solo")).toBeDefined();
  });
});

describe("settings.disabledSkills — skillTool", () => {
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    invalidateSkillCache();
    fakeHome = mkdtempSync(join(tmpdir(), "disabled-tool-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    invalidateSkillCache();
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it("returns a 'disabled' message when the LLM invokes a disabled skill", async () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    makeSkill(userBase, "alpha", "first", "alpha body");

    const out = await skillTool(
      { skill: "alpha" },
      { cwd: fakeHome, disabledSkills: ["alpha"] } as never,
    );
    expect(out.toLowerCase()).toContain("disabled");
    // Must distinguish from "not found".
    expect(out.toLowerCase()).not.toContain("not found");
  });

  it("still returns a 'not found' message for unknown skills", async () => {
    const out = await skillTool(
      { skill: "nope" },
      { cwd: fakeHome, disabledSkills: ["alpha"] } as never,
    );
    expect(out.toLowerCase()).toContain("not found");
  });

  it("loads body normally when the requested skill is not in the disabled list", async () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    makeSkill(userBase, "alpha", "first", "alpha body");
    makeSkill(userBase, "beta", "second", "beta body");

    const out = await skillTool(
      { skill: "beta" },
      { cwd: fakeHome, disabledSkills: ["alpha"] } as never,
    );
    expect(out).toContain("beta body");
  });
});

describe("settings.disabledSkills — PromptComposer skills section", () => {
  let projectRoot: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    invalidateSkillCache();
    projectRoot = mkdtempSync(join(tmpdir(), "disabled-comp-proj-"));
    fakeHome = mkdtempSync(join(tmpdir(), "disabled-comp-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    invalidateSkillCache();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it("omits disabled skills from the assembled system prompt", async () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    makeSkill(userBase, "alpha", "alpha description text", "alpha body");
    makeSkill(userBase, "beta", "beta description text", "beta body");

    const composer = new PromptComposer({
      cwd: projectRoot,
      model: "test-model",
      disabledSkills: ["alpha"],
    });
    const prompt = await composer.buildSystemPrompt([]);

    // The exact format of the listing is owned by buildSkillListing; we
    // only assert that the disabled name (and its description) does not
    // show up anywhere in the assembled prompt while the enabled one does.
    expect(prompt).toContain("beta");
    expect(prompt).not.toContain("alpha description text");
    expect(prompt.includes("alpha")).toBe(false);
  });

  it("includes every skill when disabledSkills is undefined (regression guard)", async () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    makeSkill(userBase, "alpha", "alpha description text", "alpha body");
    makeSkill(userBase, "beta", "beta description text", "beta body");

    const composer = new PromptComposer({
      cwd: projectRoot,
      model: "test-model",
    });
    const prompt = await composer.buildSystemPrompt([]);
    expect(prompt).toContain("alpha");
    expect(prompt).toContain("beta");
  });
});
