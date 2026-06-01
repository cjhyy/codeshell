import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentDefinitionsForCwd } from "./engine.js";

/**
 * Regression for the spec §7.2 precedence reversal: a project's in-tree agent
 * must override a same-named user agent (the old behavior was user-wins).
 * Pins the dir ORDER passed by loadAgentDefinitionsForCwd, guarding against a
 * silent revert. The assertion holds regardless of whether homedir() honors a
 * mutated HOME on this runtime: project is passed LAST either way.
 */
function writeAgent(dir: string, name: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}\n`,
    "utf-8",
  );
}

describe("loadAgentDefinitionsForCwd precedence (project > user)", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("project agent shadows same-named user agent", () => {
    const prevHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "cs-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "cs-cwd-"));
    cleanup.push(home, cwd);
    process.env.HOME = home;
    try {
      writeAgent(join(home, ".code-shell", "agents"), "dup", "USER");
      writeAgent(join(cwd, ".code-shell", "agents"), "dup", "PROJECT");
      const reg = loadAgentDefinitionsForCwd(cwd, [], []);
      const def = reg.get("dup")!;
      expect(def.systemPrompt).toBe("PROJECT");
      expect(def.source).toBe("project");
    } finally {
      process.env.HOME = prevHome;
    }
  });

  test("project agent loads when no user agent exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cs-cwd-"));
    cleanup.push(cwd);
    writeAgent(join(cwd, ".code-shell", "agents"), "solo", "PROJECT");
    const reg = loadAgentDefinitionsForCwd(cwd, [], []);
    expect(reg.get("solo")?.source).toBe("project");
  });
});
