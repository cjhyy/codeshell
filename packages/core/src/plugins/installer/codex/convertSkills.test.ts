import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  test("copies skills/<name>/SKILL.md into dest", async () => {
    mkdirSync(join(src, "skills", "foo"), { recursive: true });
    writeFileSync(
      join(src, "skills", "foo", "SKILL.md"),
      "---\nname: foo\ndescription: d\n---\nbody",
    );
    await copyCodexSkills(src, dest);
    expect(existsSync(join(dest, "skills", "foo", "SKILL.md"))).toBe(true);
  });

  test("no-op when source has no skills dir", async () => {
    await copyCodexSkills(src, dest);
    expect(existsSync(join(dest, "skills"))).toBe(false);
  });

  test("throws when a SKILL.md lacks frontmatter", async () => {
    mkdirSync(join(src, "skills", "bad"), { recursive: true });
    writeFileSync(join(src, "skills", "bad", "SKILL.md"), "no frontmatter here");
    await expect(copyCodexSkills(src, dest)).rejects.toThrow(/frontmatter/);
  });

  test("rejects a SKILL.md symlink even when its target is readable", async () => {
    if (process.platform === "win32") return;
    const outside = mkdtempSync(join(tmpdir(), "cs-skill-outside-"));
    try {
      mkdirSync(join(src, "skills", "leak"), { recursive: true });
      writeFileSync(
        join(outside, "SKILL.md"),
        "---\nname: leak\ndescription: private\n---\nprivate body",
      );
      symlinkSync(join(outside, "SKILL.md"), join(src, "skills", "leak", "SKILL.md"));
      await expect(copyCodexSkills(src, dest)).rejects.toThrow(
        "skill source must not contain symbolic links",
      );
      expect(existsSync(join(dest, "skills", "leak", "SKILL.md"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects a skills directory symlink", async () => {
    if (process.platform === "win32") return;
    const outside = mkdtempSync(join(tmpdir(), "cs-skills-dir-outside-"));
    try {
      mkdirSync(join(outside, "leak"), { recursive: true });
      writeFileSync(
        join(outside, "leak", "SKILL.md"),
        "---\nname: leak\ndescription: private\n---\nprivate body",
      );
      symlinkSync(outside, join(src, "skills"));
      await expect(copyCodexSkills(src, dest)).rejects.toThrow(
        "skills directory must not be a symbolic link",
      );
      expect(existsSync(join(dest, "skills"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
