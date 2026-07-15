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
