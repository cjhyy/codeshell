import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDefinitionRegistry } from "./agent-definition-registry.js";

function writeAgent(dir: string, name: string, model?: string) {
  const fm = ["---", `name: ${name}`, `description: ${name} role`];
  if (model) fm.push(`model: ${model}`);
  fm.push("---", `${name} body`);
  writeFileSync(join(dir, `${name}.md`), fm.join("\n"));
}

describe("AgentDefinitionRegistry.loadFromDirs", () => {
  let projectDir: string;
  let userDir: string;
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "proj-"));
    userDir = mkdtempSync(join(tmpdir(), "user-"));
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  it("merges both dirs; non-overlapping names coexist", () => {
    writeAgent(projectDir, "researcher");
    writeAgent(userDir, "myhelper");
    const reg = AgentDefinitionRegistry.loadFromDirs(
      [{ dir: projectDir, source: "project" }, { dir: userDir, source: "user" }],
      [],
    );
    expect(reg.list().map((d) => d.name).sort()).toEqual(["myhelper", "researcher"]);
  });

  it("user-level same name overrides project-level and marks override", () => {
    writeAgent(projectDir, "researcher", "slow");
    writeAgent(userDir, "researcher", "fast");
    const reg = AgentDefinitionRegistry.loadFromDirs(
      [{ dir: projectDir, source: "project" }, { dir: userDir, source: "user" }],
      [],
    );
    const def = reg.get("researcher")!;
    expect(def.model).toBe("fast");
    expect(def.source).toBe("user");
    expect(def.override).toBe(true);
  });

  it("disabledAgents filters a role out of list() and get()", () => {
    writeAgent(projectDir, "researcher");
    writeAgent(projectDir, "explorer");
    const reg = AgentDefinitionRegistry.loadFromDirs(
      [{ dir: projectDir, source: "project" }],
      ["explorer"],
    );
    expect(reg.has("explorer")).toBe(false);
    expect(reg.get("explorer")).toBeUndefined();
    expect(reg.list().map((d) => d.name)).toEqual(["researcher"]);
  });
});
