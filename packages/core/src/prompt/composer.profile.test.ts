import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptComposer } from "./composer.js";

const cwd = mkdtempSync(join(tmpdir(), "cs-composer-profile-"));

describe("composer profile main instruction", () => {
  test("injects the section between preset behavior and append_system", async () => {
    const composer = new PromptComposer({
      cwd,
      model: "test-model",
      profileMainInstruction: "你是制片人，按三阶段调度。",
      appendSystemPrompt: "APPEND-MARKER",
    });
    const prompt = await composer.buildSystemPrompt([]);
    const main = prompt.indexOf("你是制片人");
    const append = prompt.indexOf("APPEND-MARKER");
    expect(main).toBeGreaterThan(-1);
    expect(append).toBeGreaterThan(main);
    expect(prompt).toContain("# Digital-Human Main Instruction");
  });

  test("absent instruction adds no section", async () => {
    const composer = new PromptComposer({ cwd, model: "test-model" });
    const prompt = await composer.buildSystemPrompt([]);
    expect(prompt).not.toContain("Digital-Human Main Instruction");
  });
});

describe("composer declared-skill gap notice", () => {
  test("names the digital human's declared skills that are not installed", async () => {
    const composer = new PromptComposer({
      cwd,
      model: "test-model",
      profileMainInstruction: "先读 /hyperframes 选工作流。",
      // Names that cannot collide with whatever the developer has installed
      // user-wide — scanSkills reads the real ~/.code-shell/skills too.
      profileDeclaredSkills: ["cs-absent-skill-a", "cs-absent-skill-b"],
    });
    const message = await composer.buildDynamicContextMessage();
    const text = typeof message?.content === "string" ? message.content : "";
    // A session bound to video-director called /hyperframes, got "Skill not
    // found", then flailed with Glob before giving up. Say it up front instead.
    expect(text).toContain("cs-absent-skill-a");
    expect(text).toContain("cs-absent-skill-b");
    expect(text).toMatch(/not installed/i);
  });

  test("says nothing when every declared skill is available", async () => {
    const composer = new PromptComposer({
      cwd,
      model: "test-model",
      profileDeclaredSkills: [],
    });
    const message = await composer.buildDynamicContextMessage();
    const text = typeof message?.content === "string" ? message.content : "";
    expect(text).not.toMatch(/not installed/i);
  });

  test("no declaration means no notice", async () => {
    const composer = new PromptComposer({ cwd, model: "test-model" });
    const message = await composer.buildDynamicContextMessage();
    const text = typeof message?.content === "string" ? message.content : "";
    expect(text).not.toMatch(/not installed/i);
  });
});

describe("composer session brief", () => {
  test("injects the standing brief as its own system section", async () => {
    const composer = new PromptComposer({
      cwd,
      model: "test-model",
      sessionBrief: "你是「视频出品小队」的团长。成员：video-engineer — `s-abc`。",
      appendSystemPrompt: "APPEND-MARKER",
    });
    const prompt = await composer.buildSystemPrompt([]);
    // Belongs in the prompt, not the composer draft: it is configuration for the
    // agent, and a draft is lost the moment the user edits or sends.
    expect(prompt).toContain("视频出品小队");
    expect(prompt).toContain("s-abc");
    expect(prompt).toContain("# Session Brief");
    // Ordering: after the digital human's own instruction, before append.
    expect(prompt.indexOf("# Session Brief")).toBeLessThan(prompt.indexOf("APPEND-MARKER"));
  });

  test("sits after the digital-human main instruction", async () => {
    const composer = new PromptComposer({
      cwd,
      model: "test-model",
      profileMainInstruction: "你是短片导演。",
      sessionBrief: "本团队目标：做一条介绍视频。",
    });
    const prompt = await composer.buildSystemPrompt([]);
    expect(prompt.indexOf("你是短片导演")).toBeLessThan(prompt.indexOf("本团队目标"));
  });

  test("absent brief adds no section", async () => {
    const composer = new PromptComposer({ cwd, model: "test-model" });
    const prompt = await composer.buildSystemPrompt([]);
    expect(prompt).not.toContain("# Session Brief");
  });
});
