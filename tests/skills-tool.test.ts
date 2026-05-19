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
});
