import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PromptComposer } from "./composer.js";
import { invalidateSkillCache } from "../skills/index.js";

/**
 * Skills + git status are volatile (a skill install or a file edit changes
 * them) and must NOT live in the cached system prefix. They ride in a trailing
 * <system-reminder> user message instead, so a change there never invalidates
 * the cached system prompt. These tests pin that placement.
 */
describe("PromptComposer dynamic context (skills out of system prefix)", () => {
  let cwd: string, prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    cwd = mkdtempSync(join(tmpdir(), "cs-dyn-"));
    // Empty user skills dir so only the project skill below is found.
    process.env.HOME = mkdtempSync(join(tmpdir(), "cs-home-"));
    const skillDir = join(cwd, ".code-shell", "skills", "demo-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: a demo skill for testing\n---\nbody",
    );
    invalidateSkillCache();
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    invalidateSkillCache();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("keeps the skills listing OUT of the system prompt", async () => {
    const composer = new PromptComposer({ cwd, model: "test-model" });
    const prompt = await composer.buildSystemPrompt([]);
    expect(prompt).not.toContain("demo-skill");
    expect(prompt).not.toContain("Available Skills");
  });

  it("puts the skills listing INTO a trailing user-role <system-reminder> message", async () => {
    const composer = new PromptComposer({ cwd, model: "test-model" });
    const msg = await composer.buildDynamicContextMessage();
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe("user");
    expect(msg!.content).toContain("demo-skill");
    expect(msg!.content).toContain("<system-reminder>");
    expect(msg!.content).toContain("</system-reminder>");
  });

  it("puts volatile goal-tool guidance in the trailing dynamic-context message", async () => {
    const withoutGoal = await new PromptComposer({
      cwd,
      model: "test-model",
      goalToolState: { hasGoal: false },
    }).buildDynamicContextMessage();
    expect(withoutGoal!.role).toBe("user");
    expect(withoutGoal!.content).toContain("当前没有 active goal");
    expect(withoutGoal!.content).toContain("不要调用 complete_goal/cancel_goal");

    const withGoal = await new PromptComposer({
      cwd,
      model: "test-model",
      goalToolState: { hasGoal: true },
    }).buildDynamicContextMessage();
    expect(withGoal!.content).toContain("当前存在 active goal");
    expect(withGoal!.content).toContain("complete_goal");
    expect(withGoal!.content).toContain("cancel_goal");
  });

  it("returns a trailing dynamic message with goal guidance even when it is the only dynamic context", async () => {
    const bare = mkdtempSync(join(tmpdir(), "cs-goal-only-"));
    invalidateSkillCache();
    try {
      const msg = await new PromptComposer({
        cwd: bare,
        model: "test-model",
        goalToolState: { hasGoal: false },
      }).buildDynamicContextMessage();
      expect(msg).not.toBeNull();
      expect(msg!.role).toBe("user");
      expect(msg!.content).toContain("当前没有 active goal");
      expect(msg!.content).not.toContain("demo-skill");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("returns null when there are no skills and no git status", async () => {
    // A cwd with no skills and not a git repo → nothing dynamic to inject.
    const bare = mkdtempSync(join(tmpdir(), "cs-bare-"));
    invalidateSkillCache();
    try {
      const composer = new PromptComposer({ cwd: bare, model: "test-model" });
      const msg = await composer.buildDynamicContextMessage();
      expect(msg).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  // Cache fix: memory mutates constantly (extraction / recall usage++ / approve),
  // so it must ride the trailing message, NOT the cacheable prefix.
  it("puts memory in the trailing dynamic message, never the system prefix", async () => {
    const prevCsHome = process.env.CODE_SHELL_HOME;
    const csHome = mkdtempSync(join(tmpdir(), "cs-memhome-"));
    process.env.CODE_SHELL_HOME = csHome;
    const bare = mkdtempSync(join(tmpdir(), "cs-mem-bare-"));
    invalidateSkillCache();
    try {
      // Seed a global memory under csHome/memory/user.
      const udir = join(csHome, "memory", "user");
      mkdirSync(udir, { recursive: true });
      writeFileSync(
        join(udir, "pref.md"),
        "---\nname: my-global-pref\ndescription: a durable global preference\ntype: user\n---\nbody",
      );
      const composer = new PromptComposer({ cwd: bare, model: "test-model" });
      const sysPrompt = await composer.buildSystemPrompt([]);
      const userCtx = composer.buildUserContextMessage();
      const dyn = await composer.buildDynamicContextMessage();
      // Not in the cacheable prefix:
      expect(sysPrompt).not.toContain("my-global-pref");
      expect(userCtx?.content ?? "").not.toContain("my-global-pref");
      // In the trailing dynamic message:
      expect(dyn?.content ?? "").toContain("my-global-pref");
    } finally {
      if (prevCsHome === undefined) delete process.env.CODE_SHELL_HOME;
      else process.env.CODE_SHELL_HOME = prevCsHome;
      rmSync(csHome, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
