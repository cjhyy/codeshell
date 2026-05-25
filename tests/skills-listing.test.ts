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

  it("groups skills by namespace, user/project first then plugins A-Z", () => {
    const out = buildSkillListing([
      skill({ name: "superpowers:debugging", source: "plugin" }),
      skill({ name: "local-tool", source: "user" }),
      skill({ name: "document-skills:pdf", source: "plugin" }),
      skill({ name: "superpowers:brainstorming", source: "plugin" }),
    ]);
    // Each namespace gets its own ## heading with a count.
    expect(out).toContain("## 用户 / 项目 (1)");
    expect(out).toContain("## document-skills (1)");
    expect(out).toContain("## superpowers (2)");
    // User/project comes before any plugin group.
    expect(out.indexOf("## 用户 / 项目")).toBeLessThan(out.indexOf("## document-skills"));
    // Plugin groups are alphabetical (document-skills < superpowers).
    expect(out.indexOf("## document-skills")).toBeLessThan(out.indexOf("## superpowers"));
    // Skills inside a group are sorted by name.
    const sp = out.slice(out.indexOf("## superpowers"));
    expect(sp.indexOf("brainstorming")).toBeLessThan(sp.indexOf("debugging"));
  });
});
