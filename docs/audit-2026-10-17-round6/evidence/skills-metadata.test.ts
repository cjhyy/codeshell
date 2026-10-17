import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseFrontmatter } from "../../../packages/core/src/skills/frontmatter.ts";
import { validateSkillMarkdown } from "../../../packages/core/src/skills/management.ts";
import { invalidateSkillCache, scanSkills } from "../../../packages/core/src/skills/scanner.ts";
import { readSkillSnapshot } from "../../../packages/core/src/skills/snapshot.ts";
import { skillTool } from "../../../packages/core/src/tool-system/builtin/skill.ts";
import { parseAgentDefinition } from "../../../packages/core/src/agent/agent-definition.ts";
import { AgentDefinitionRegistry } from "../../../packages/core/src/agent/agent-definition-registry.ts";

const ownedRoots: string[] = [];
const previousHome = process.env.HOME;
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "round6-skills-metadata-"));
  ownedRoots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  process.env.HOME = home;
  invalidateSkillCache();
  return root;
}
function writeSkill(cwd: string, name: string, markdown: string): void {
  const dir = join(cwd, ".code-shell", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), markdown);
}
afterEach(() => {
  process.env.HOME = previousHome;
  invalidateSkillCache();
  for (const root of ownedRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("round6 ordinary Skill metadata characterization", () => {
  test("valid inline YAML triple-dash metadata is cut at an embedded delimiter", async () => {
    const cwd = project();
    const yaml = "name: probe\ndescription: Draft---review templates";
    const markdown = `---\n${yaml}\n---\n# Steps\nUse the template.\n`;
    const expectedBody = "# Steps\nUse the template.\n";
    const actualBody = "review templates\n---\n# Steps\nUse the template.\n";
    expect(parseYaml(yaml)).toEqual({ name: "probe", description: "Draft---review templates" });
    expect(validateSkillMarkdown(markdown)).toBe(markdown);
    expect(parseFrontmatter(markdown)).toEqual({ frontmatter: { name: "probe", description: "Draft" }, body: actualBody });
    writeSkill(cwd, "probe", markdown);
    const scanned = scanSkills(cwd);
    expect(scanned).toHaveLength(1);
    expect(scanned[0]).toMatchObject({ name: "probe", description: "Draft", content: actualBody });
    const snapshot = readSkillSnapshot("probe", cwd)!;
    expect(snapshot.markdown).toBe(markdown);
    expect(snapshot.revisionKind).toBe("bundle");
    expect(snapshot.frontmatter).toEqual({ name: "probe", description: "Draft" });
    expect(snapshot.body).toBe(actualBody);
    expect(snapshot.body).not.toBe(expectedBody);
    expect(JSON.parse(await skillTool({ query: "review" }, { cwd } as any))).toEqual({ results: [], total: 0, nextOffset: null });
    const invoked = await skillTool({ skill: "probe" }, { cwd } as any);
    expect(invoked).toContain(`\n\n${actualBody}`);
    console.log(JSON.stringify({ case: "inline-triple-dash", expected: { description: "Draft---review templates", body: expectedBody }, actual: { description: scanned[0]!.description, body: snapshot.body, reviewSearchTotal: 0 } }));
  });

  test("valid block-scalar YAML with an indented rule is cut inside description", () => {
    const yaml = "name: block-probe\ndescription: |\n  First\n  ---\n  Second";
    const markdown = `---\n${yaml}\n---\n# Body\n`;
    expect(parseYaml(yaml)).toEqual({ name: "block-probe", description: "First\n---\nSecond\n" });
    expect(validateSkillMarkdown(markdown)).toBe(markdown);
    expect(parseFrontmatter(markdown)).toEqual({ frontmatter: { name: "block-probe", description: "First\n" }, body: "Second\n---\n# Body\n" });
  });

  test("ordinary LF and CRLF Skills without embedded triple dashes preserve metadata and body", () => {
    for (const newline of ["\n", "\r\n"]) {
      const markdown = ["---", "name: normal", "description: Draft review templates", "---", "# Steps", "Use the template.", ""].join(newline);
      expect(validateSkillMarkdown(markdown)).toBe(markdown);
      expect(parseFrontmatter(markdown)).toEqual({ frontmatter: { name: "normal", description: "Draft review templates" }, body: ["# Steps", "Use the template.", ""].join(newline) });
    }
  });
});

describe("round6 ordinary agent Markdown characterization", () => {
  test("LF agent loads but its otherwise identical CRLF text is rejected", () => {
    const lines = ["---", "name: researcher", "description: Research current source", "model: quick", "---", "Cite source lines."];
    const lf = lines.join("\n");
    const crlf = lines.join("\r\n");
    expect(parseAgentDefinition(lf, "researcher-lf.md")).toEqual({ name: "researcher", description: "Research current source", model: "quick", systemPrompt: "Cite source lines." });
    expect(parseYaml(lines.slice(1, 4).join("\r\n"))).toEqual({ name: "researcher", description: "Research current source", model: "quick" });
    expect(() => parseAgentDefinition(crlf, "researcher-crlf.md")).toThrow("researcher-crlf.md: missing YAML frontmatter");
  });

  test("actual registry omits CRLF role and keeps LF sibling with a missing-frontmatter warning", () => {
    const cwd = project();
    const dir = join(cwd, ".code-shell", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "researcher-crlf.md"), ["---", "name: researcher", "description: Research source", "---", "Cite source lines."].join("\r\n"));
    writeFileSync(join(dir, "planner-lf.md"), ["---", "name: planner", "description: Plan work", "---", "Write a plan."].join("\n"));
    const registry = AgentDefinitionRegistry.loadFromDirs([{ dir, source: "project" }], []);
    expect(registry.list().map((def) => def.name)).toEqual(["planner"]);
    expect(registry.get("researcher")).toBeUndefined();
    expect(registry.warnings).toHaveLength(1);
    expect(registry.warnings[0]).toContain("researcher-crlf.md: researcher-crlf.md: missing YAML frontmatter");
    console.log(JSON.stringify({ case: "crlf-agent-registry", expectedNames: ["planner", "researcher"], actualNames: registry.list().map((def) => def.name), warnings: registry.warnings }));
  });
});
