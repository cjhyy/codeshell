import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanSkills, invalidateSkillCache } from "./scanner.js";

// TODO §4.3 — sub-agent skill isolation (per-agent allowlist). scanSkills must
// honor a `skillAllowlist`: only allowlisted skills survive, and the empty
// array means "no skills at all" (distinct from undefined = inherit all).

function writeSkill(root: string, name: string): void {
  const dir = join(root, ".code-shell", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: the ${name} skill\n---\nbody of ${name}\n`,
  );
}

describe("scanSkills skillAllowlist (sub-agent isolation)", () => {
  let cwd: string;
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "cs-skills-cwd-"));
    // Point HOME at an empty dir so user-level skills don't bleed into the
    // assertions (scanner reads $HOME/.code-shell/skills).
    home = mkdtempSync(join(tmpdir(), "cs-skills-home-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    writeSkill(cwd, "alpha");
    writeSkill(cwd, "beta");
    writeSkill(cwd, "gamma");
    invalidateSkillCache();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    invalidateSkillCache();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("undefined allowlist → full pool inherited", () => {
    const names = scanSkills(cwd).map((s) => s.name).sort();
    expect(names).toEqual(["alpha", "beta", "gamma"]);
  });

  test("allowlist keeps only listed skills", () => {
    const names = scanSkills(cwd, { skillAllowlist: ["alpha", "gamma"] })
      .map((s) => s.name)
      .sort();
    expect(names).toEqual(["alpha", "gamma"]);
  });

  test("empty allowlist → no skills (distinct from undefined)", () => {
    expect(scanSkills(cwd, { skillAllowlist: [] })).toHaveLength(0);
  });

  test("allowlist intersects with disabledSkills (must be allowed AND not disabled)", () => {
    const names = scanSkills(cwd, {
      skillAllowlist: ["alpha", "beta"],
      disabledSkills: ["beta"],
    }).map((s) => s.name);
    expect(names).toEqual(["alpha"]);
  });

  test("allowlist entry that doesn't exist is simply absent (no crash)", () => {
    const names = scanSkills(cwd, { skillAllowlist: ["alpha", "nonexistent"] }).map(
      (s) => s.name,
    );
    expect(names).toEqual(["alpha"]);
  });
});
