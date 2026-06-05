import { describe, test, expect } from "bun:test";
import { parseAgentDefinition, serializeAgentDefinition } from "./agent-definition.js";

// TODO §4.3 — agent role frontmatter `skills:` must be parsed (was silently
// dropped) and round-tripped through serialize. Accepts both YAML-list and
// comma-string forms (CC-lineage files use either). Same normalization is
// applied to `tools:`.

describe("parseAgentDefinition skills frontmatter", () => {
  test("parses a YAML-list skills field", () => {
    const def = parseAgentDefinition(
      `---\nname: director\ndescription: orchestrates\nskills:\n  - brainstorming\n  - writing-plans\n---\nbody`,
      "director.md",
    );
    expect(def.skills).toEqual(["brainstorming", "writing-plans"]);
  });

  test("parses a comma-separated skills string", () => {
    const def = parseAgentDefinition(
      `---\nname: director\ndescription: orchestrates\nskills: brainstorming, writing-plans\n---\nbody`,
      "director.md",
    );
    expect(def.skills).toEqual(["brainstorming", "writing-plans"]);
  });

  test("absent skills field → undefined (inherit full pool)", () => {
    const def = parseAgentDefinition(
      `---\nname: plain\ndescription: nothing special\n---\nbody`,
      "plain.md",
    );
    expect(def.skills).toBeUndefined();
  });

  test("empty skills list is preserved (no skills, not inherit-all)", () => {
    const def = parseAgentDefinition(
      `---\nname: locked\ndescription: no skills\nskills: []\n---\nbody`,
      "locked.md",
    );
    expect(def.skills).toEqual([]);
  });

  test("tools field also accepts comma-string form", () => {
    const def = parseAgentDefinition(
      `---\nname: r\ndescription: d\ntools: Read, Grep, Glob\n---\nb`,
      "r.md",
    );
    expect(def.tools).toEqual(["Read", "Grep", "Glob"]);
  });

  test("round-trips skills through serialize → parse", () => {
    const def = parseAgentDefinition(
      `---\nname: director\ndescription: orchestrates\nskills:\n  - brainstorming\n---\nthe body`,
      "director.md",
    );
    const reparsed = parseAgentDefinition(serializeAgentDefinition(def), "director.md");
    expect(reparsed.skills).toEqual(["brainstorming"]);
    expect(reparsed.name).toBe("director");
    expect(reparsed.systemPrompt).toBe("the body");
  });
});
