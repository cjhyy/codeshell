import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { scanSkills } from "../src/skills/scanner.js";
import { matchSkillsByInput, matchSkillsByTool, buildSkillListing } from "../src/skills/matcher.js";
import type { SkillDefinition } from "../src/skills/scanner.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "test-skill",
    description: "A test skill",
    triggers: { keywords: ["test", "check"], tools: ["Bash"] },
    whenToUse: "when testing",
    content: "skill content here",
    filePath: "/tmp/test.md",
    ...overrides,
  };
}

describe("scanSkills", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "skills-test-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("finds SKILL.md files in .code-shell/skills/", () => {
    const skillsDir = join(tmpDir, ".code-shell", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, "my-skill.md"),
      `---\nname: my-skill\ndescription: does things\ntriggers:\n  keywords: [deploy, release]\nwhen_to_use: when deploying\n---\n\nDeploy instructions here.`,
    );

    const skills = scanSkills(tmpDir);
    const mine = skills.find((s) => s.name === "my-skill");
    expect(mine).toBeDefined();
    expect(mine!.description).toBe("does things");
    expect(mine!.triggers.keywords).toContain("deploy");
    expect(mine!.content).toContain("Deploy instructions");
  });

  it("returns only built-in skills for dir with no user/project skills", () => {
    // Built-in skills are always scanned; user/project dirs add to them.
    const skills = scanSkills(tmpDir);
    expect(skills.every((s) => s.filePath.includes("skills-builtin"))).toBe(true);
  });

  it("skips files without frontmatter", () => {
    const skillsDir = join(tmpDir, ".code-shell", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "bad.md"), "no frontmatter here");
    // Note: the built-in skills directory is still scanned, so we only assert
    // that this malformed file did not produce a skill of its own.
    const skills = scanSkills(tmpDir);
    expect(skills.find((s) => s.filePath.endsWith("bad.md"))).toBeUndefined();
  });

  it("discovers the built-in codeshell-help skill shipped with the package", () => {
    // No project-level skills set up — only the package built-in should appear.
    const skills = scanSkills(tmpDir);
    const help = skills.find((s) => s.name === "codeshell-help");
    expect(help).toBeDefined();
    expect(help!.description).toMatch(/code-shell/i);
    expect(help!.filePath).toContain("skills-builtin");
  });
});

describe("matchSkillsByInput", () => {
  const skills = [
    makeSkill({ name: "deploy", triggers: { keywords: ["deploy", "release"] } }),
    makeSkill({ name: "test", triggers: { keywords: ["test", "unit test"] } }),
    makeSkill({ name: "lint", triggers: { keywords: ["lint", "eslint"] } }),
  ];

  it("matches by keyword", () => {
    const results = matchSkillsByInput(skills, "please deploy to production");
    expect(results).toHaveLength(1);
    expect(results[0].skill.name).toBe("deploy");
    expect(results[0].matchedBy).toBe("keyword");
  });

  it("matches multiple skills", () => {
    const results = matchSkillsByInput(skills, "test and lint the code");
    expect(results).toHaveLength(2);
  });

  it("returns empty for no matches", () => {
    expect(matchSkillsByInput(skills, "refactor the database")).toHaveLength(0);
  });
});

describe("matchSkillsByTool", () => {
  const skills = [
    makeSkill({ name: "bash-helper", triggers: { tools: ["Bash"] } }),
    makeSkill({ name: "read-helper", triggers: { tools: ["Read"] } }),
  ];

  it("matches by tool name", () => {
    const results = matchSkillsByTool(skills, "Bash");
    expect(results).toHaveLength(1);
    expect(results[0].skill.name).toBe("bash-helper");
  });
});

describe("buildSkillListing", () => {
  it("formats skills for system prompt", () => {
    const skills = [
      makeSkill({ name: "deploy", description: "Deploy to prod" }),
      makeSkill({ name: "test", description: "Run tests" }),
    ];
    const listing = buildSkillListing(skills);
    expect(listing).toContain("Available Skills");
    expect(listing).toContain("**deploy**");
    expect(listing).toContain("Deploy to prod");
  });

  it("returns empty for no skills", () => {
    expect(buildSkillListing([])).toBe("");
  });
});
