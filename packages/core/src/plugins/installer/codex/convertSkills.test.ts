import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyCodexSkills } from "./convertSkills.js";

describe("copyCodexSkills", () => {
  let src: string, dest: string;
  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), "cs-skill-src-"));
    dest = mkdtempSync(join(tmpdir(), "cs-skill-dest-"));
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  test("copies skills/<name>/SKILL.md into dest", () => {
    mkdirSync(join(src, "skills", "foo"), { recursive: true });
    writeFileSync(join(src, "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: d\n---\nbody");
    copyCodexSkills(src, dest);
    expect(existsSync(join(dest, "skills", "foo", "SKILL.md"))).toBe(true);
  });

  test("no-op when source has no skills dir", () => {
    copyCodexSkills(src, dest);
    expect(existsSync(join(dest, "skills"))).toBe(false);
  });

  test("throws when a SKILL.md lacks frontmatter", () => {
    mkdirSync(join(src, "skills", "bad"), { recursive: true });
    writeFileSync(join(src, "skills", "bad", "SKILL.md"), "no frontmatter here");
    expect(() => copyCodexSkills(src, dest)).toThrow(/frontmatter/);
  });
});
