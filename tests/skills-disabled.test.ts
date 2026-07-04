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

  it("disabledPlugins drops every skill in a plugin in one entry", () => {
    // Install a fake plugin with two skills. disabledPlugins:
    // ["fake-plugin"] should remove BOTH without listing each by name.
    const cache = mkdtempSync(join(tmpdir(), "disabled-plugin-all-"));
    try {
      for (const name of ["foo", "bar"]) {
        const dir = join(cache, "skills", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "SKILL.md"),
          `---\ndescription: ${name} desc\n---\n${name} body`,
        );
      }
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

      // Sanity: both skills are present without the filter.
      const all = scanSkills(projectRoot);
      expect(all.find((s) => s.name === "fake-plugin:foo")).toBeDefined();
      expect(all.find((s) => s.name === "fake-plugin:bar")).toBeDefined();

      invalidateSkillCache();
      const filtered = scanSkills(projectRoot, {
        disabledPlugins: ["fake-plugin"],
      });
      expect(filtered.find((s) => s.name?.startsWith("fake-plugin:"))).toBeUndefined();
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("disabledPlugins + disabledSkills compose (both filters apply)", () => {
    // fake-plugin:foo dropped by plugin filter; "other:keep" dropped by
    // skill filter; a third "other:also" survives. Validates the two
    // filters run independently.
    const cache = mkdtempSync(join(tmpdir(), "disabled-plugin-compose-"));
    try {
      // fake-plugin has one skill
      const fooDir = join(cache, "fake-plugin", "skills", "foo");
      mkdirSync(fooDir, { recursive: true });
      writeFileSync(join(fooDir, "SKILL.md"), "---\ndescription: f\n---\nfoo");
      // other-plugin has two skills: keep + also
      for (const name of ["keep", "also"]) {
        const dir = join(cache, "other", "skills", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "SKILL.md"),
          `---\ndescription: ${name}\n---\n${name}`,
        );
      }
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
                installPath: join(cache, "fake-plugin"),
                version: "v1",
                installedAt: "t",
                lastUpdated: "t",
              },
            ],
            "other@mkt": [
              {
                scope: "user",
                installPath: join(cache, "other"),
                version: "v1",
                installedAt: "t",
                lastUpdated: "t",
              },
            ],
          },
        }),
      );

      invalidateSkillCache();
      const filtered = scanSkills(projectRoot, {
        disabledSkills: ["other:keep"],
        disabledPlugins: ["fake-plugin"],
      });
      const names = filtered.map((s) => s.name);
      expect(names).not.toContain("fake-plugin:foo");
      expect(names).not.toContain("other:keep");
      expect(names).toContain("other:also");
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("disabledPlugins does NOT touch standalone (non-namespaced) skills", () => {
    // A bare "local-skill" with no colon must NOT match disabledPlugins:
    // ["local-skill"] — the plugin filter requires namespace form.
    const userBase = join(fakeHome, ".code-shell", "skills");
    makeSkill(userBase, "local-skill", "local", "body");

    const skills = scanSkills(projectRoot, {
      disabledPlugins: ["local-skill"],
    });
    expect(skills.find((s) => s.name === "local-skill")).toBeDefined();
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

  it("returns a 'disabled plugin' message distinct from per-skill disable", async () => {
    // Install a fake plugin so the skill exists on disk; ctx says the
    // plugin is in disabledPlugins. The tool should refuse with a
    // message that contains "disabled plugin" — distinct phrasing from
    // the per-skill case so callers can tell them apart.
    const cache = mkdtempSync(join(tmpdir(), "disabled-tool-plugin-"));
    try {
      const skillDir = join(cache, "skills", "foo");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\ndescription: foo\n---\nfoo body",
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

      const out = await skillTool(
        { skill: "fake-plugin:foo" },
        { cwd: fakeHome, disabledPlugins: ["fake-plugin"] } as never,
      );
      expect(out.toLowerCase()).toContain("disabled plugin");
      // Make sure it is NOT the per-skill phrasing nor not-found.
      expect(out.toLowerCase()).not.toContain("not found");
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});

describe("settings.disabledSkills — PromptComposer dynamic skills section", () => {
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

  it("omits disabled skills from the dynamic context prompt", async () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    makeSkill(userBase, "alpha", "alpha description text", "alpha body");
    makeSkill(userBase, "beta", "beta description text", "beta body");

    const composer = new PromptComposer({
      cwd: projectRoot,
      model: "test-model",
      disabledSkills: ["alpha"],
    });
    const prompt = (await composer.buildDynamicContextMessage())?.content ?? "";

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
    const prompt = (await composer.buildDynamicContextMessage())?.content ?? "";
    expect(prompt).toContain("alpha");
    expect(prompt).toContain("beta");
  });

  it("omits every skill from a disabled plugin in the dynamic context prompt", async () => {
    // Install a fake plugin with two skills; disabledPlugins:
    // ["fake-plugin"] removes both. We assert by namespace prefix so
    // the test stays robust if buildSkillListing formatting changes.
    const cache = mkdtempSync(join(tmpdir(), "disabled-comp-plugin-"));
    try {
      for (const name of ["foo", "bar"]) {
        const dir = join(cache, "skills", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "SKILL.md"),
          `---\ndescription: ${name} description\n---\n${name} body`,
        );
      }
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

      const composer = new PromptComposer({
        cwd: projectRoot,
        model: "test-model",
        disabledPlugins: ["fake-plugin"],
      });
      const prompt = (await composer.buildDynamicContextMessage())?.content ?? "";
      expect(prompt).not.toContain("fake-plugin:foo");
      expect(prompt).not.toContain("fake-plugin:bar");
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});
