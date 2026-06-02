import { describe, it, expect } from "bun:test";
import { PromptComposer } from "../composer.js";

function composerWith(opts: Record<string, unknown>) {
  return new PromptComposer({ cwd: process.cwd(), model: "test-model", ...opts } as any);
}

describe("composer personalization section", () => {
  it("includes responseLanguage and userProfile when set", async () => {
    const c = composerWith({ responseLanguage: "Always reply in Simplified Chinese", userProfile: "Call me maki" });
    const sys = await c.buildSystemPrompt([]);
    expect(sys).toContain("Always reply in Simplified Chinese");
    expect(sys).toContain("Call me maki");
  });

  it("omits the section entirely when both are empty", async () => {
    const c = composerWith({});
    const sys = await c.buildSystemPrompt([]);
    expect(sys).not.toContain("User & Response Preferences");
  });

  it("includes only the field that is set", async () => {
    const c = composerWith({ userProfile: "Call me maki" });
    const sys = await c.buildSystemPrompt([]);
    expect(sys).toContain("Call me maki");
    expect(sys).not.toContain("Response language");
  });
});
