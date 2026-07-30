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

function writePanelAppSkill(home: string): void {
  const appRoot = join(home, ".code-shell", "panel-apps", "design");
  const skillDir = join(appRoot, "agent", "skills", "repo-design");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: repo-design\ndescription: edit repository designs\n---\nuse design tools\n",
  );
  mkdirSync(join(appRoot, ".codeshell-panel"), { recursive: true });
  writeFileSync(
    join(appRoot, ".codeshell-panel", "panel.json"),
    JSON.stringify({
      schemaVersion: 2,
      id: "design",
      version: "1.0.0",
      title: { default: "Design" },
      entry: "app/index.html",
      permissions: [],
      agent: {
        tools: [],
        skills: ["agent/skills/repo-design/SKILL.md"],
      },
    }),
  );
  writeFileSync(
    join(home, ".code-shell", "panel-apps", "installed.json"),
    JSON.stringify({ version: 1, apps: [{ id: "design" }] }),
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
    const names = scanSkills(cwd)
      .map((s) => s.name)
      .sort();
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
    const names = scanSkills(cwd, { skillAllowlist: ["alpha", "nonexistent"] }).map((s) => s.name);
    expect(names).toEqual(["alpha"]);
  });

  test("loads namespaced Panel App skills only after explicit project binding", () => {
    writePanelAppSkill(home);
    invalidateSkillCache();
    expect(scanSkills(cwd).map((skill) => skill.name)).not.toContain("design:repo-design");
    expect(scanSkills(cwd, { includeDisabledPanelApps: true })).toContainEqual(
      expect.objectContaining({
        name: "design:repo-design",
        source: "panel-app",
        description: "edit repository designs",
      }),
    );

    mkdirSync(join(cwd, ".code-shell"), { recursive: true });
    writeFileSync(
      join(cwd, ".code-shell", "settings.json"),
      JSON.stringify({ panelAppBindings: ["design"] }),
    );
    expect(scanSkills(cwd).map((skill) => skill.name)).toContain("design:repo-design");

    mkdirSync(join(home, ".code-shell"), { recursive: true });
    writeFileSync(
      join(home, ".code-shell", "settings.json"),
      JSON.stringify({ disabledPanelApps: ["design"] }),
    );
    expect(scanSkills(cwd).map((skill) => skill.name)).not.toContain("design:repo-design");
  });
});
