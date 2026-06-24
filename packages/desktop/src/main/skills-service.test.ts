import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidateSkillCache } from "@cjhyy/code-shell-core";
import { listSkills } from "./skills-service.js";

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

    expect(listSkills(cwd).map((s) => s.name).sort()).toEqual(["alpha"]);
    expect(listSkills(cwd, { includeDisabled: true }).map((s) => s.name).sort()).toEqual([
      "alpha",
      "beta",
    ]);
  });

  test("honors project capabilityOverrides when filtering for mentions", () => {
    seedSettings(home, { disabledSkills: ["beta"] });
    seedSettings(cwd, { capabilityOverrides: { skills: { beta: "on" } } });

    expect(listSkills(cwd).map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
  });
});
