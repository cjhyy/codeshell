import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { skillTool } from "../src/tool-system/builtin/skill.js";
import { invalidateSkillCache } from "../src/skills/scanner.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("skillTool", () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    invalidateSkillCache();
    fakeHome = mkdtempSync(join(tmpdir(), "skills-tool-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    originalCwd = process.cwd();
  });

  afterEach(() => {
    invalidateSkillCache();
    process.chdir(originalCwd);
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it("returns the SKILL.md body when the skill exists", async () => {
    const dir = join(fakeHome, ".code-shell", "skills", "hello");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\ndescription: greets\n---\nHello there");

    const out = await skillTool({ skill: "hello" });
    expect(out).toContain("Hello there");
  });

  it("substitutes $ARGUMENTS in the body", async () => {
    const dir = join(fakeHome, ".code-shell", "skills", "echo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\ndescription: e\n---\nrun: $ARGUMENTS");

    const out = await skillTool({ skill: "echo", args: "world" });
    expect(out).toContain("run: world");
  });

  it("substitutes {args} as a legacy alias", async () => {
    const dir = join(fakeHome, ".code-shell", "skills", "legacy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\ndescription: l\n---\nuse {args}");

    const out = await skillTool({ skill: "legacy", args: "ok" });
    expect(out).toContain("use ok");
  });

  it("returns an error string when the skill is missing", async () => {
    const out = await skillTool({ skill: "nope" });
    expect(out.toLowerCase()).toContain("not found");
  });

  it("returns an error string when skill name is empty", async () => {
    const out = await skillTool({ skill: "" });
    expect(out.toLowerCase()).toContain("required");
  });

  it("prepends a base-directory header pointing at the skill dir", async () => {
    const dir = join(fakeHome, ".code-shell", "skills", "withbase");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\ndescription: d\n---\nhello");

    const out = await skillTool({ skill: "withbase" });
    expect(out).toContain("Base directory for this skill:");
    expect(out).toContain(dir);
    expect(out).toContain("hello");
  });

  it("substitutes ${CODESHELL_SKILL_DIR} in the body", async () => {
    const dir = join(fakeHome, ".code-shell", "skills", "varsub");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\ndescription: d\n---\nrun ${CODESHELL_SKILL_DIR}/scripts/foo.py",
    );
    const out = await skillTool({ skill: "varsub" });
    expect(out).toContain(`run ${dir}/scripts/foo.py`);
    expect(out).not.toContain("${CODESHELL_SKILL_DIR}");
  });

  it("substitutes ${CLAUDE_SKILL_DIR} for CC-compatible SKILL.md", async () => {
    const dir = join(fakeHome, ".code-shell", "skills", "ccvar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\ndescription: d\n---\ncd ${CLAUDE_SKILL_DIR} && ls",
    );
    const out = await skillTool({ skill: "ccvar" });
    expect(out).toContain(`cd ${dir} && ls`);
    expect(out).not.toContain("${CLAUDE_SKILL_DIR}");
  });
});
