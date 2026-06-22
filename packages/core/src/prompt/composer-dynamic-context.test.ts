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
});
