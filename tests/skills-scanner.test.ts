import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  parseFrontmatter,
  quoteProblematicValues,
  coerceDescription,
} from "../src/skills/frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses standard name + description", () => {
    const raw = "---\nname: foo\ndescription: does things\n---\nbody here";
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.name).toBe("foo");
    expect(frontmatter.description).toBe("does things");
    expect(body).toBe("body here");
  });

  it("returns empty frontmatter and full body when no delimiters", () => {
    const raw = "just markdown here";
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe("just markdown here");
  });

  it("handles multi-line description via yaml literal block (>)", () => {
    const raw = "---\ndescription: >\n  line one\n  line two\n---\nbody";
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.description).toMatch(/line one line two/);
  });

  it("recovers via quoteProblematicValues when description contains glob specials", () => {
    const raw = "---\nname: gl\ndescription: Use for **/*.{ts,tsx} patterns\n---\nbody";
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.name).toBe("gl");
    expect(frontmatter.description).toContain("**/*.{ts,tsx}");
  });

  it("returns empty frontmatter (no throw) when yaml is completely broken", () => {
    const raw = "---\n: : : invalid : : :\n  bad indent\n---\nbody";
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe("body");
  });

  it("strips the closing --- delimiter and any whitespace it eats (CC parity)", () => {
    // CC's regex `/^---\s*\n([\s\S]*?)---\s*\n?/` is greedy on the trailing
    // `\s*`, so blank lines between `---` and the body are consumed. Verified
    // against utils/frontmatterParser.ts:123 in claude-code-sourcemap. We
    // deliberately preserve this behavior rather than the test name
    // originally suggested.
    const raw = "---\nname: foo\n---\n\nbody starts here";
    const { body } = parseFrontmatter(raw);
    expect(body).toBe("body starts here");
  });
});

describe("quoteProblematicValues", () => {
  it("quotes unquoted value with glob specials", () => {
    const input = "key: foo/*.{ts,tsx}";
    const output = quoteProblematicValues(input);
    expect(output).toBe('key: "foo/*.{ts,tsx}"');
  });

  it("leaves already-quoted values alone", () => {
    const input = 'key: "already quoted"';
    expect(quoteProblematicValues(input)).toBe(input);
  });

  it("leaves plain values alone", () => {
    const input = "key: plain value";
    expect(quoteProblematicValues(input)).toBe(input);
  });

  it("escapes embedded double quotes when wrapping", () => {
    const input = 'key: has "quotes" and *';
    const output = quoteProblematicValues(input);
    expect(output).toBe('key: "has \\"quotes\\" and *"');
  });
});

describe("coerceDescription", () => {
  it("trims string descriptions", () => {
    expect(coerceDescription("  hello  ")).toBe("hello");
  });

  it("returns empty string for null/undefined", () => {
    expect(coerceDescription(null)).toBe("");
    expect(coerceDescription(undefined)).toBe("");
  });

  it("stringifies numbers and booleans", () => {
    expect(coerceDescription(42)).toBe("42");
    expect(coerceDescription(true)).toBe("true");
  });

  it("returns empty string for arrays and objects", () => {
    expect(coerceDescription(["a", "b"])).toBe("");
    expect(coerceDescription({ a: 1 })).toBe("");
  });
});

import { scanSkills, invalidateSkillCache } from "../src/skills/scanner.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeSkillDir(base: string, name: string, frontmatter: string, body: string) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
  return dir;
}

describe("scanSkills - directory layout", () => {
  let projectRoot: string;
  let originalHome: string | undefined;
  let fakeHome: string;

  beforeEach(() => {
    invalidateSkillCache();
    projectRoot = mkdtempSync(join(tmpdir(), "skills-proj-"));
    fakeHome = mkdtempSync(join(tmpdir(), "skills-home-"));
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

  it("discovers <user>/<name>/SKILL.md", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    makeSkillDir(userBase, "pdf", "name: pdf\ndescription: handle PDFs", "PDF body");
    const skills = scanSkills(projectRoot);
    const pdf = skills.find((s) => s.name === "pdf");
    expect(pdf).toBeDefined();
    expect(pdf!.description).toBe("handle PDFs");
    expect(pdf!.source).toBe("user");
    expect(pdf!.content).toBe("PDF body");
  });

  it("discovers <project>/<name>/SKILL.md", () => {
    const projBase = join(projectRoot, ".code-shell", "skills");
    makeSkillDir(projBase, "deploy", "name: deploy\ndescription: deployment helper", "deploy body");
    const skills = scanSkills(projectRoot);
    const dep = skills.find((s) => s.name === "deploy");
    expect(dep).toBeDefined();
    expect(dep!.source).toBe("project");
  });

  it("project skill shadows user skill of the same name", () => {
    makeSkillDir(join(fakeHome, ".code-shell", "skills"), "shared", "description: from user", "user body");
    makeSkillDir(join(projectRoot, ".code-shell", "skills"), "shared", "description: from project", "project body");
    const skills = scanSkills(projectRoot);
    const matches = skills.filter((s) => s.name === "shared");
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe("project");
    expect(matches[0].description).toBe("from project");
  });

  it("skips subdirectory missing SKILL.md", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    mkdirSync(join(userBase, "empty"), { recursive: true });
    const skills = scanSkills(projectRoot);
    expect(skills.find((s) => s.name === "empty")).toBeUndefined();
  });

  it("ignores flat .md files in base dir (subdir-only)", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    mkdirSync(userBase, { recursive: true });
    writeFileSync(join(userBase, "loose.md"), "---\nname: loose\n---\nbody");
    const skills = scanSkills(projectRoot);
    expect(skills.find((s) => s.name === "loose")).toBeUndefined();
  });

  it("follows symlinked directories", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    mkdirSync(userBase, { recursive: true });
    const realDir = mkdtempSync(join(tmpdir(), "real-skill-"));
    writeFileSync(join(realDir, "SKILL.md"), "---\ndescription: linked\n---\nbody");
    symlinkSync(realDir, join(userBase, "linked"));
    const skills = scanSkills(projectRoot);
    expect(skills.find((s) => s.name === "linked")).toBeDefined();
    rmSync(realDir, { recursive: true, force: true });
  });

  it("returns [] when no base dirs exist", () => {
    const skills = scanSkills(projectRoot);
    expect(skills).toEqual([]);
  });

  it("uses directory name as authoritative skill name (frontmatter.name mismatched)", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    makeSkillDir(userBase, "actual-name", "name: different-name\ndescription: x", "body");
    const skills = scanSkills(projectRoot);
    expect(skills.find((s) => s.name === "actual-name")).toBeDefined();
    expect(skills.find((s) => s.name === "different-name")).toBeUndefined();
  });

  it("registers skill with empty description when frontmatter is missing", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    mkdirSync(join(userBase, "raw"), { recursive: true });
    writeFileSync(join(userBase, "raw", "SKILL.md"), "no frontmatter just body");
    const skills = scanSkills(projectRoot);
    const raw = skills.find((s) => s.name === "raw");
    expect(raw).toBeDefined();
    expect(raw!.description).toBe("");
    expect(raw!.content).toBe("no frontmatter just body");
  });
});

describe("scanSkills - memoization", () => {
  let projectRoot: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    invalidateSkillCache();
    projectRoot = mkdtempSync(join(tmpdir(), "skills-memo-"));
    fakeHome = mkdtempSync(join(tmpdir(), "skills-memo-home-"));
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

  it("returns the same array reference on the second call for the same cwd", () => {
    makeSkillDir(join(fakeHome, ".code-shell", "skills"), "cached", "description: c", "b");
    const a = scanSkills(projectRoot);
    const b = scanSkills(projectRoot);
    expect(a).toBe(b);
  });

  it("invalidateSkillCache forces a re-scan that picks up new skills", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    makeSkillDir(userBase, "first", "description: 1", "b");
    const before = scanSkills(projectRoot);
    expect(before.find((s) => s.name === "second")).toBeUndefined();

    makeSkillDir(userBase, "second", "description: 2", "b");
    const stillCached = scanSkills(projectRoot);
    expect(stillCached.find((s) => s.name === "second")).toBeUndefined();

    invalidateSkillCache();
    const fresh = scanSkills(projectRoot);
    expect(fresh.find((s) => s.name === "second")).toBeDefined();
  });
});
