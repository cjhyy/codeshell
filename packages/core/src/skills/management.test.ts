import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
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
import { invalidateSkillCache, scanSkills } from "./scanner.js";

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
    await expect(stageSkillDirectory(broken, root)).rejects.toThrow("缺少 SKILL.md");
    expect(readSkillBundle(installed.targetDir).revision).toBe(before.revision);
    const replacement = source();
    writeFileSync(join(replacement, "SKILL.md"), markdown("demo", "Updated safely."));
    const stage = await stageSkillDirectory(replacement, root);
    commitSkillDirectory(stage, root, "demo", before.revision);
    expect(readFileSync(installed.filePath, "utf8")).toContain("Updated safely.");
    expect(existsSync(stage)).toBe(false);
  });

  test("private stages stay undiscoverable and independent with a read-only root parent", async () => {
    const cwd = fixture();
    const input = source();
    const root = skillRoot("project", cwd, true);
    const parent = dirname(root);
    chmodSync(parent, 0o555);
    try {
      const installed = await installSkillFromDirectory(input, "project", cwd, "demo");
      const first = await stageSkillDirectory(input, root);
      const second = await stageSkillDirectory(input, root);
      for (const stage of [first, second]) {
        const rel = relative(realpathSync(root), realpathSync(stage));
        expect(rel === ".." || rel.startsWith(`..${sep}`)).toBe(false);
        expect(statSync(stage).mode & 0o777).toBe(0o700);
      }
      invalidateSkillCache();
      expect(
        scanSkills(realpathSync(cwd))
          .filter((skill) => skill.filePath.startsWith(`${root}${sep}`))
          .map((skill) => skill.name),
      ).toEqual(["demo"]);
      rmSync(first, { recursive: true });
      expect(readSkillBundle(second).content).toBe(markdown());
      commitSkillDirectory(second, root, "demo", readSkillBundle(installed.targetDir).revision);
      removeOwnedSkill(installed.filePath, [root], readSkillBundle(installed.targetDir).revision);
      expect(readdirSync(root)).toEqual([".skill-mutation"]);
      expect(readdirSync(join(root, ".skill-mutation"))).toEqual([]);
      expect(statSync(parent).mode & 0o777).toBe(0o555);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  for (const failSwap of [false, true]) {
    test(`replacement ${failSwap ? "rollback" : "commit"} never renames outside its managed root`, async () => {
      const cwd = fixture();
      const input = source();
      const installed = await installSkillFromDirectory(input, "project", cwd, "demo");
      const sibling = await installSkillFromDirectory(input, "project", cwd, "sibling");
      const root = skillRoot("project", cwd);
      const previous = readSkillBundle(installed.targetDir);
      const replacement = source();
      writeFileSync(join(replacement, "SKILL.md"), markdown("demo", "Replacement."));
      const stage = await stageSkillDirectory(replacement, root);
      const rename = nodeFs.renameSync;
      const moves: Array<[string, string]> = [];
      const observed = spyOn(nodeFs, "renameSync").mockImplementation((from, to) => {
        // Observe real transaction paths instead of trusting chmod: privileged
        // test runners could otherwise write a forbidden parent and pass.
        for (const path of [from, to]) {
          const canonical = join(realpathSync(dirname(String(path))), basename(String(path)));
          const rel = relative(realpathSync(root), canonical);
          expect(rel === ".." || rel.startsWith(`..${sep}`)).toBe(false);
        }
        moves.push([String(from), String(to)]);
        if (failSwap && from === stage) throw new Error("injected stage rename failure");
        rename(from, to);
      });
      try {
        if (failSwap) {
          expect(() => commitSkillDirectory(stage, root, "demo", previous.revision)).toThrow(
            "injected stage rename failure",
          );
        } else {
          commitSkillDirectory(stage, root, "demo", previous.revision);
        }
      } finally {
        observed.mockRestore();
      }
      expect(moves).toHaveLength(failSwap ? 3 : 2);
      expect(readFileSync(installed.filePath, "utf8")).toBe(
        failSwap ? markdown() : markdown("demo", "Replacement."),
      );
      expect(readFileSync(sibling.filePath, "utf8")).toBe(markdown());
      expect(existsSync(stage)).toBe(failSwap);
      if (failSwap) rmSync(stage, { recursive: true });
      expect(readdirSync(root).sort()).toEqual([".skill-mutation", "demo", "sibling"]);
      expect(readdirSync(join(root, ".skill-mutation"))).toEqual([]);
    });
  }

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
