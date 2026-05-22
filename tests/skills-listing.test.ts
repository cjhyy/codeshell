import { describe, it, expect } from "bun:test";
import { buildSkillListing } from "../packages/core/src/tool-system/builtin/skill-prompt.js";
import type { SkillDefinition } from "../packages/core/src/skills/scanner.js";

function skill(over: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "x",
    description: "desc",
    content: "body",
    filePath: "/tmp/x/SKILL.md",
    source: "user",
    ...over,
  };
}

describe("buildSkillListing", () => {
  it("returns empty string for empty input", () => {
    expect(buildSkillListing([])).toBe("");
  });

  it("renders skills as `- name: description` lines under a header", () => {
    const out = buildSkillListing([
      skill({ name: "pdf", description: "handle PDFs" }),
      skill({ name: "deploy", description: "deploy stuff" }),
    ]);
    expect(out).toContain("# Available Skills");
    expect(out).toContain("- pdf: handle PDFs");
    expect(out).toContain("- deploy: deploy stuff");
  });

  it("renders skill with no description as `- name:`", () => {
    const out = buildSkillListing([skill({ name: "bare", description: "" })]);
    expect(out).toContain("- bare:");
  });
});
