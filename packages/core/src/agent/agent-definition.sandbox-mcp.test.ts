import { describe, expect, it } from "bun:test";
import { parseAgentDefinition, serializeAgentDefinition } from "./agent-definition.js";

describe("agent definition sandbox and MCP frontmatter", () => {
  it("parses the existing sandbox mode and MCP name-list shapes", () => {
    const parsed = parseAgentDefinition(
      `---
name: isolated
description: isolated role
sandbox: bwrap
mcp:
  - github
  - docs
---
work safely`,
      "isolated.md",
    );

    expect(parsed.sandbox).toBe("bwrap");
    expect(parsed.mcp).toEqual(["github", "docs"]);
  });

  it("accepts comma-separated MCP names and preserves an empty list", () => {
    const listed = parseAgentDefinition(
      `---\nname: listed\ndescription: listed role\nmcp: github, docs\n---\nbody`,
      "listed.md",
    );
    const empty = parseAgentDefinition(
      `---\nname: empty\ndescription: no MCP\nmcp: []\n---\nbody`,
      "empty.md",
    );

    expect(listed.mcp).toEqual(["github", "docs"]);
    expect(empty.mcp).toEqual([]);
  });

  it("leaves absent fields undefined so the child inherits the parent", () => {
    const parsed = parseAgentDefinition(
      `---\nname: inherited\ndescription: inherits\n---\nbody`,
      "inherited.md",
    );

    expect(parsed.sandbox).toBeUndefined();
    expect(parsed.mcp).toBeUndefined();
  });

  it("round-trips sandbox and an empty MCP allowlist", () => {
    const serialized = serializeAgentDefinition({
      name: "locked",
      description: "locked role",
      sandbox: "seatbelt",
      mcp: [],
      systemPrompt: "body",
    });
    const reparsed = parseAgentDefinition(serialized, "locked.md");

    expect(reparsed.sandbox).toBe("seatbelt");
    expect(reparsed.mcp).toEqual([]);
    expect(reparsed.systemPrompt).toBe("body");
  });
});
