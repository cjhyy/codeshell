import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertOwnedSkillDirectory,
  commitSkillDirectory,
  editSkillMarkdown,
  installSkillFromDirectory,
  readSkillBundle,
  removeOwnedSkill,
  skillRoot,
  stageSkillDirectory,
  validateSkillMarkdown,
} from "./management.js";

const directories: string[] = [];
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "core-skill-management-"));
  directories.push(dir);
  return dir;
};
const markdown = (name = "demo", body = "Original instructions.") =>
  `---\nname: ${name}\ndescription: A test skill\n---\n${body}\n`;
const source = () => {
  const dir = fixture();
  writeFileSync(join(dir, "SKILL.md"), markdown());
  return dir;
};
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("shared Skill management", () => {
  test("validates complete frontmatter without silently dropping malformed YAML", () => {
    expect(validateSkillMarkdown(markdown())).toBe(markdown());
    expect(validateSkillMarkdown("Plain instructions.")).toBe("Plain instructions.");
    expect(() => validateSkillMarkdown("---\nname: demo\nMissing close")).toThrow("---");
    expect(() => validateSkillMarkdown("---\nname: demo\nname: duplicate\n---\nBody")).toThrow(
      "YAML",
    );
    expect(() => validateSkillMarkdown("---\n- not\n- mapping\n---\nBody")).toThrow();
    expect(() => validateSkillMarkdown("---\nname: [a,b]\n---\nBody")).toThrow();
    expect(() => validateSkillMarkdown("x".repeat(2 * 1024 * 1024 + 1))).toThrow("2 MiB");
  });

  test("installs the complete bundle privately and preserves executable scripts", async () => {
    const cwd = fixture();
    const input = source();
    mkdirSync(join(input, "scripts"));
    mkdirSync(join(input, "assets"));
    writeFileSync(join(input, "scripts", "run.sh"), "#!/bin/sh\nprintf done\n");
    chmodSync(join(input, "scripts", "run.sh"), 0o755);
    writeFileSync(join(input, "assets", "data.json"), '{"fixture":true}');
    const installed = await installSkillFromDirectory(input, "project", cwd, "demo");
    expect(readFileSync(installed.filePath, "utf8")).toBe(markdown());
    expect(readFileSync(join(installed.targetDir, "assets", "data.json"), "utf8")).toBe(
      '{"fixture":true}',
    );
    expect(statSync(join(installed.targetDir, "scripts", "run.sh")).mode & 0o777).toBe(0o700);
    expect(statSync(installed.filePath).mode & 0o777).toBe(0o600);
    expect(readSkillBundle(installed.targetDir).files).toHaveLength(3);
    await expect(installSkillFromDirectory(input, "project", cwd, "demo")).rejects.toThrow(
      "已存在",
    );
    expect(readFileSync(installed.filePath, "utf8")).toBe(markdown());
  });

  test("rejects linked state roots and linked bundle files without touching their targets", async () => {
    const cwd = fixture();
    const outside = fixture();
    const input = source();
    symlinkSync(outside, join(cwd, ".code-shell"));
    await expect(installSkillFromDirectory(input, "project", cwd, "demo")).rejects.toThrow(
      "符号链接",
    );
    expect(existsSync(join(outside, "skills"))).toBe(false);
    rmSync(join(cwd, ".code-shell"));
    writeFileSync(join(outside, "private.txt"), "do not change");
    symlinkSync(join(outside, "private.txt"), join(input, "secret.txt"));
    await expect(installSkillFromDirectory(input, "project", cwd, "demo")).rejects.toThrow(
      "符号链接",
    );
    expect(readFileSync(join(outside, "private.txt"), "utf8")).toBe("do not change");
    expect(existsSync(join(cwd, ".code-shell", "skills", "demo"))).toBe(false);
  });

  test("refuses linked Skill directories and linked SKILL.md when editing or removing", async () => {
    const cwd = fixture();
    const input = source();
    const root = skillRoot("project", cwd, true);
    symlinkSync(input, join(root, "linked"));
    expect(() => assertOwnedSkillDirectory(join(root, "linked", "SKILL.md"), [root])).toThrow(
      "符号链接",
    );
    mkdirSync(join(root, "linked-file"));
    symlinkSync(join(input, "SKILL.md"), join(root, "linked-file", "SKILL.md"));
    expect(() => assertOwnedSkillDirectory(join(root, "linked-file", "SKILL.md"), [root])).toThrow(
      "unsafe",
    );
    expect(readFileSync(join(input, "SKILL.md"), "utf8")).toBe(markdown());
  });

  test("edits only the chosen markdown and rejects stale revisions including changed assets", async () => {
    const cwd = fixture();
    const input = source();
    writeFileSync(join(input, "data.txt"), "version 1");
    const installed = await installSkillFromDirectory(input, "project", cwd, "demo");
    const root = skillRoot("project", cwd);
    const before = readSkillBundle(installed.targetDir);
    const changed = editSkillMarkdown(
      installed.filePath,
      [root],
      markdown("demo", "New instructions."),
      before.revision,
    );
    expect(changed.revision).not.toBe(before.revision);
    expect(readFileSync(join(installed.targetDir, "data.txt"), "utf8")).toBe("version 1");
    expect(() =>
      editSkillMarkdown(installed.filePath, [root], markdown(), before.revision),
    ).toThrow("变化");
    writeFileSync(join(installed.targetDir, "data.txt"), "version 2");
    expect(() => removeOwnedSkill(installed.filePath, [root], changed.revision)).toThrow("变化");
    expect(existsSync(installed.filePath)).toBe(true);
  });

  test("stages replacements completely before an atomic swap and keeps the old version on invalid downloads", async () => {
    const cwd = fixture();
    const input = source();
    const installed = await installSkillFromDirectory(input, "project", cwd, "demo");
    const before = readSkillBundle(installed.targetDir);
    const root = skillRoot("project", cwd);
    const broken = fixture();
    writeFileSync(join(broken, "data.txt"), "missing markdown");
    await expect(stageSkillDirectory(broken, join(cwd, ".code-shell"))).rejects.toThrow(
      "缺少 SKILL.md",
    );
    expect(readSkillBundle(installed.targetDir).revision).toBe(before.revision);
    const replacement = source();
    writeFileSync(join(replacement, "SKILL.md"), markdown("demo", "Updated safely."));
    const stage = await stageSkillDirectory(replacement, join(cwd, ".code-shell"));
    commitSkillDirectory(stage, root, "demo", before.revision);
    expect(readFileSync(installed.filePath, "utf8")).toContain("Updated safely.");
    expect(existsSync(stage)).toBe(false);
  });

  test("removes only the selected owned skill after matching its full revision", async () => {
    const cwd = fixture();
    const input = source();
    const first = await installSkillFromDirectory(input, "project", cwd, "first");
    const second = await installSkillFromDirectory(input, "project", cwd, "second");
    const root = skillRoot("project", cwd);
    removeOwnedSkill(first.filePath, [root], readSkillBundle(first.targetDir).revision);
    expect(existsSync(first.targetDir)).toBe(false);
    expect(existsSync(second.filePath)).toBe(true);
    expect(() =>
      removeOwnedSkill(join(input, "SKILL.md"), [root], readSkillBundle(input).revision),
    ).toThrow();
    expect(existsSync(join(input, "SKILL.md"))).toBe(true);
  });
});
