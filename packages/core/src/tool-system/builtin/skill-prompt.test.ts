import { describe, expect, test } from "bun:test";
import { estimateStringTokens } from "../../context/token-counter.js";
import type { SkillDefinition } from "../../skills/scanner.js";
import {
  buildSkillListing,
  rankSkillsForDiscovery,
  searchSkillMetadata,
  skillListingBudget,
} from "./skill-prompt.js";

function skill(
  name: string,
  description = "",
  source: SkillDefinition["source"] = "plugin",
): SkillDefinition {
  return {
    name,
    description,
    source,
    content: "PRIVATE_BODY",
    filePath: "/private/skill/SKILL.md",
  };
}

describe("bounded skill discovery", () => {
  test("hundreds of long multilingual descriptions stay within the estimated budget", () => {
    const skills = Array.from({ length: 300 }, (_, i) =>
      skill(`plugin:skill-${i}`, `${"文档处理 ".repeat(400)}${"code {function();} ".repeat(400)}`),
    );
    for (const context of [0, 2_000, 12_800, 64_000, 128_000, 1_000_000]) {
      const options = { maxContextTokens: context, task: "处理文档" };
      const listing = buildSkillListing(skills, options);
      expect(estimateStringTokens(listing)).toBeLessThanOrEqual(skillListingBudget(options));
      expect(listing).not.toContain("PRIVATE_BODY");
      expect(listing).not.toContain("/private/");
    }
  });

  test("priority is explicit, project, profile, recent, task, then defaults", () => {
    const skills = [
      skill("default"),
      skill("query", "处理文档"),
      skill("recent"),
      skill("profile"),
      skill("project", "", "project"),
      skill("explicit"),
    ];
    const ranked = rankSkillsForDiscovery(skills, {
      preferredSkills: ["explicit"],
      declaredSkills: ["profile"],
      recentSkills: ["recent"],
      task: "需要处理文档",
    });
    expect(ranked.map((s) => s.name)).toEqual([
      "explicit",
      "project",
      "profile",
      "recent",
      "query",
      "default",
    ]);
    const listing = buildSkillListing(
      [...skills, ...Array.from({ length: 40 }, (_, i) => skill(`other:skill-${i}`))],
      { maxTokens: 85, preferredSkills: ["explicit"] },
    );
    expect(listing).toContain("explicit");
    expect(listing).toContain("omitted");
  });

  test("names remain discoverable when descriptions must degrade", () => {
    const skills = Array.from({ length: 20 }, (_, i) =>
      skill(`plug:s${i}`, `Very long description ${"x".repeat(4_000)}`),
    );
    const listing = buildSkillListing(skills, { maxTokens: 200 });
    for (const s of skills) expect(listing).toContain(`- ${s.name}`);
    expect(listing).not.toContain("20 more skills omitted");
    expect(estimateStringTokens(listing)).toBeLessThanOrEqual(200);
  });

  test("output is deterministic without mutating the scanner's array", () => {
    const skills = [
      skill("z:two", "description"),
      skill("a:one", "description"),
      skill("local", "project", "project"),
    ];
    const original = [...skills];
    expect(buildSkillListing(skills)).toBe(buildSkillListing([...skills].reverse()));
    expect(skills).toEqual(original);
    expect(buildSkillListing([], { maxTokens: 100 })).toBe("");
    expect(buildSkillListing(skills, { maxTokens: 1 })).toBe("");
    expect(skillListingBudget({ maxContextTokens: 1_000_000 })).toBe(2_048);
  });

  test("metadata search pages exact names, matches Chinese, and never loads bodies", () => {
    const skills = Array.from({ length: 25 }, (_, i) =>
      skill(`docs:skill-${i.toString().padStart(2, "0")}`, `处理文档 ${"x".repeat(10_000)}`),
    );
    const first = JSON.parse(searchSkillMetadata(skills, "中文文档", 0, 10));
    const second = JSON.parse(searchSkillMetadata(skills, "中文文档", first.nextOffset, 10));
    expect(first.total).toBe(25);
    expect(first.results).toHaveLength(10);
    expect(second.results).toHaveLength(10);
    expect(new Set([...first.results, ...second.results].map((s) => s.name)).size).toBe(20);
    const serialized = searchSkillMetadata(skills, "", 20, 10);
    expect(JSON.parse(serialized).nextOffset).toBeNull();
    expect(serialized).not.toContain("PRIVATE_BODY");
    expect(serialized).not.toContain("filePath");
    expect(serialized.length).toBeLessThan(6_300);
    expect(JSON.parse(searchSkillMetadata(skills, "nonexistent")).results).toEqual([]);
  });
});
