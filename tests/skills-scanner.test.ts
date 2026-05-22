import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  parseFrontmatter,
  quoteProblematicValues,
  coerceDescription,
} from "../packages/core/src/skills/frontmatter.js";

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

import { scanSkills, invalidateSkillCache } from "../packages/core/src/skills/scanner.js";
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

  it("does not double-process a base when project and user bases share an inode", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    const projBaseParent = join(projectRoot, ".code-shell");
    mkdirSync(userBase, { recursive: true });
    makeSkillDir(userBase, "linked-skill", "description: L", "body");

    // Symlink the entire project skills dir to the user skills dir.
    mkdirSync(projBaseParent, { recursive: true });
    symlinkSync(userBase, join(projBaseParent, "skills"));

    const skills = scanSkills(projectRoot);
    const matches = skills.filter((s) => s.name === "linked-skill");
    expect(matches).toHaveLength(1);
    // First base (project) wins — but the dedupe ensures we don't process twice.
    expect(matches[0].source).toBe("project");
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

  it("treats a changed HOME as a fresh cache entry", () => {
    const altHome = mkdtempSync(join(tmpdir(), "skills-alt-home-"));
    try {
      makeSkillDir(join(fakeHome, ".code-shell", "skills"), "from-first", "description: f", "b");
      makeSkillDir(join(altHome, ".code-shell", "skills"), "from-second", "description: g", "b");

      const first = scanSkills(projectRoot);
      expect(first.find((s) => s.name === "from-first")).toBeDefined();

      process.env.HOME = altHome;
      const second = scanSkills(projectRoot);
      expect(second.find((s) => s.name === "from-second")).toBeDefined();
      expect(second.find((s) => s.name === "from-first")).toBeUndefined();
    } finally {
      rmSync(altHome, { recursive: true, force: true });
    }
  });
});

describe("scanSkills - plugin integration", () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let projectRoot: string;

  beforeEach(() => {
    invalidateSkillCache();
    fakeHome = mkdtempSync(join(tmpdir(), "scan-plugin-home-"));
    projectRoot = mkdtempSync(join(tmpdir(), "scan-plugin-proj-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    invalidateSkillCache();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  function makePluginInstall(
    pluginKey: string,
    cacheDir: string,
    skillName: string,
    skillBody: string,
  ) {
    const skillDir = join(cacheDir, "skills", skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\ndescription: ${skillName} desc\n---\n${skillBody}`,
    );
    // Write installed_plugins.json with a single entry.
    const pluginsDir = join(fakeHome, ".code-shell", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          [pluginKey]: [
            {
              scope: "user",
              installPath: cacheDir,
              version: "abc123",
              installedAt: "t",
              lastUpdated: "t",
            },
          ],
        },
      }),
    );
  }

  it("discovers a plugin skill with <plugin>:<skill> namespace", () => {
    const cache = mkdtempSync(join(tmpdir(), "scan-plugin-cache-"));
    try {
      makePluginInstall("docs@mkt", cache, "pdf", "PDF body");
      const skills = scanSkills(projectRoot);
      const pdf = skills.find((s) => s.name === "docs:pdf");
      expect(pdf).toBeDefined();
      expect(pdf!.source).toBe("plugin");
      expect(pdf!.description).toBe("pdf desc");
      expect(pdf!.content).toBe("PDF body");
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("does not pull in a plugin skill that has no SKILL.md", () => {
    const cache = mkdtempSync(join(tmpdir(), "scan-plugin-empty-"));
    try {
      // Plugin has a "skills/" dir with a subdir but no SKILL.md inside it.
      const skillDir = join(cache, "skills", "broken");
      mkdirSync(skillDir, { recursive: true });
      const pluginsDir = join(fakeHome, ".code-shell", "plugins");
      mkdirSync(pluginsDir, { recursive: true });
      writeFileSync(
        join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "p@m": [
              {
                scope: "user",
                installPath: cache,
                version: "v",
                installedAt: "t",
                lastUpdated: "t",
              },
            ],
          },
        }),
      );
      const skills = scanSkills(projectRoot);
      expect(skills.find((s) => s.name === "p:broken")).toBeUndefined();
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("plugin skill coexists with user skill of the same un-namespaced name", () => {
    const cache = mkdtempSync(join(tmpdir(), "scan-plugin-coexist-"));
    try {
      // User-level skill named "pdf"
      makeSkillDir(join(fakeHome, ".code-shell", "skills"), "pdf", "description: u-pdf", "user body");
      // Plugin skill named "pdf" under plugin "docs"
      makePluginInstall("docs@mkt", cache, "pdf", "plugin pdf body");

      const skills = scanSkills(projectRoot);
      const userPdf = skills.find((s) => s.name === "pdf");
      const pluginPdf = skills.find((s) => s.name === "docs:pdf");
      expect(userPdf).toBeDefined();
      expect(userPdf!.source).toBe("user");
      expect(pluginPdf).toBeDefined();
      expect(pluginPdf!.source).toBe("plugin");
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("memoize invalidates when installed_plugins.json mtime changes", async () => {
    const cache = mkdtempSync(join(tmpdir(), "scan-plugin-memo-"));
    try {
      const first = scanSkills(projectRoot);
      expect(first.find((s) => s.name === "p:later")).toBeUndefined();

      // Make a plugin install AFTER the first scan and ensure mtime changes.
      // Bun's writeFileSync has 1ms granularity; sleep briefly before write.
      await new Promise((resolve) => setTimeout(resolve, 15));
      makePluginInstall("p@m", cache, "later", "Late body");
      const second = scanSkills(projectRoot);
      expect(second.find((s) => s.name === "p:later")).toBeDefined();
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("handles missing installed_plugins.json (no plugins)", () => {
    // No fakeHome plugins dir written — should still scan project/user clean.
    const skills = scanSkills(projectRoot);
    expect(skills).toEqual([]);
  });
});
