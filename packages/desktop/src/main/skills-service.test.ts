import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidateSkillCache } from "@cjhyy/code-shell-core";
import { listSkills, uninstallListedSkill, uninstallSkill } from "./skills-service.js";

function writeSkill(root: string, name: string): void {
  const dir = join(root, ".code-shell", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n${name} body\n`,
    "utf8",
  );
}

function seedSettings(root: string, data: unknown): void {
  mkdirSync(join(root, ".code-shell"), { recursive: true });
  writeFileSync(join(root, ".code-shell", "settings.json"), JSON.stringify(data), "utf8");
}

describe("skills-service listSkills", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-desktop-skills-home-"));
    cwd = mkdtempSync(join(tmpdir(), "cs-desktop-skills-cwd-"));
    process.env.HOME = home;
    invalidateSkillCache();
    writeSkill(cwd, "alpha");
    writeSkill(cwd, "beta");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    invalidateSkillCache();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("defaults to repo-effective enabled skills but can include disabled for management UI", () => {
    seedSettings(home, { disabledSkills: ["beta"] });

    expect(
      listSkills(cwd)
        .map((s) => s.name)
        .sort(),
    ).toEqual(["alpha"]);
    expect(
      listSkills(cwd, { includeDisabled: true })
        .map((s) => s.name)
        .sort(),
    ).toEqual(["alpha", "beta"]);
  });

  test("honors project capabilityOverrides when filtering for mentions", () => {
    seedSettings(home, { disabledSkills: ["beta"] });
    seedSettings(cwd, { capabilityOverrides: { skills: { beta: "on" } } });

    expect(
      listSkills(cwd)
        .map((s) => s.name)
        .sort(),
    ).toEqual(["alpha", "beta"]);
  });

  test("uninstalls a listed project skill by scope and skill name", async () => {
    await uninstallSkill({ scope: "project", cwd, skillName: "alpha" });

    expect(existsSync(join(cwd, ".code-shell", "skills", "alpha"))).toBe(false);
    expect(existsSync(join(cwd, ".code-shell", "skills", "beta", "SKILL.md"))).toBe(true);
  });

  test("legacy path uninstall refuses paths not returned by listSkills", async () => {
    const outside = mkdtempSync(join(tmpdir(), "cs-desktop-skills-out-"));
    try {
      const file = join(outside, "SKILL.md");
      writeFileSync(file, "---\nname: owned\ndescription: owned\n---\n", "utf8");
      await expect(uninstallListedSkill(file, "project", cwd)).rejects.toThrow(/unlisted skill/);
      expect(existsSync(file)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("refuses to uninstall a symlinked skill directory", async () => {
    const outside = mkdtempSync(join(tmpdir(), "cs-desktop-skills-symlink-target-"));
    try {
      writeSkill(outside, "linked");
      symlinkSync(
        join(outside, ".code-shell", "skills", "linked"),
        join(cwd, ".code-shell", "skills", "linked"),
      );
      invalidateSkillCache();

      await expect(uninstallSkill({ scope: "project", cwd, skillName: "linked" })).rejects.toThrow(
        /unsafe skill directory/,
      );
      expect(existsSync(join(outside, ".code-shell", "skills", "linked", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
