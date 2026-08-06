import { describe, it, expect } from "bun:test";
import { buildAppendSystemPrompt, AUTOMATION_PROMPT_NOTE } from "./EngineRunner.js";

describe("buildAppendSystemPrompt", () => {
  it("prepends the automation note for automation runs", () => {
    const out = buildAppendSystemPrompt("host-append", { source: "automation" });
    expect(out!.startsWith(AUTOMATION_PROMPT_NOTE)).toBe(true);
    expect(out).toContain("host-append");
  });

  it("returns host append unchanged for a non-automation source", () => {
    expect(buildAppendSystemPrompt("host-append", { source: "user" })).toBe("host-append");
  });

  it("returns undefined host append unchanged when metadata has no source", () => {
    expect(buildAppendSystemPrompt(undefined, {})).toBeUndefined();
  });

  it("uses just the note when there is no host append", () => {
    expect(buildAppendSystemPrompt(undefined, { source: "automation" })).toBe(
      AUTOMATION_PROMPT_NOTE,
    );
  });

  it("requires memory bookkeeping before a complete final assistant result", () => {
    expect(AUTOMATION_PROMPT_NOTE).toContain("first call UpdateAutomationMemory exactly once");
    expect(AUTOMATION_PROMPT_NOTE).toContain(
      "complete requested output as the final assistant message",
    );
    expect(AUTOMATION_PROMPT_NOTE).toContain(
      "Do not replace the requested output with a completion acknowledgement",
    );
  });
});
