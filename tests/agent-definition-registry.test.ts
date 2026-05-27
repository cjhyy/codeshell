import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentDefinitionRegistry } from "../packages/core/src/agent/agent-definition-registry.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentdefs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, body: string) {
  writeFileSync(join(dir, name), body);
}

describe("AgentDefinitionRegistry", () => {
  it("loads .md files keyed by name", () => {
    write("researcher.md", "---\nname: researcher\ndescription: research\nmodel: flash\n---\nResearch.");
    write("planner.md", "---\nname: planner\ndescription: plan\n---\nPlan.");

    const reg = AgentDefinitionRegistry.loadFromDir(dir);

    expect(reg.has("researcher")).toBe(true);
    expect(reg.get("researcher")?.model).toBe("flash");
    expect(reg.list().map((d) => d.name).sort()).toEqual(["planner", "researcher"]);
    expect(reg.warnings).toHaveLength(0);
  });

  it("skips malformed files and records a warning instead of throwing", () => {
    write("good.md", "---\nname: good\ndescription: ok\n---\nBody.");
    write("bad.md", "no frontmatter here");

    const reg = AgentDefinitionRegistry.loadFromDir(dir);

    expect(reg.has("good")).toBe(true);
    expect(reg.has("bad")).toBe(false);
    expect(reg.warnings.some((w) => w.includes("bad.md"))).toBe(true);
  });

  it("ignores non-md files", () => {
    write("notes.txt", "name: nope");
    write("a.md", "---\nname: a\ndescription: d\n---\nB.");
    const reg = AgentDefinitionRegistry.loadFromDir(dir);
    expect(reg.list().map((d) => d.name)).toEqual(["a"]);
  });

  it("returns an empty registry when the dir does not exist", () => {
    const reg = AgentDefinitionRegistry.loadFromDir(join(dir, "does-not-exist"));
    expect(reg.list()).toEqual([]);
    expect(reg.warnings).toEqual([]);
  });

  it("first file with duplicate name wins and records a warning", () => {
    // Non-recursive: only top-level .md files are scanned, sorted by name.
    // a.md sorts before b.md, so "first" wins.
    write("a.md", "---\nname: dup\ndescription: first\n---\nFirst.");
    write("b.md", "---\nname: dup\ndescription: second\n---\nSecond.");
    const reg = AgentDefinitionRegistry.loadFromDir(dir);
    expect(reg.get("dup")?.description).toBe("first");
    expect(reg.warnings.some((w) => w.includes("b.md"))).toBe(true);
  });
});
