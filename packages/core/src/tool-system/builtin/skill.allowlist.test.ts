import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { skillTool } from "./skill.js";
import { invalidateSkillCache } from "../../skills/scanner.js";
import type { ToolContext } from "../context.js";

// TODO §4.3 — the Skill tool must refuse to invoke a skill outside the
// sub-agent's allowlist, with a message distinct from "not found", and must
// happily invoke an allowlisted one.

function writeSkill(root: string, name: string): void {
  const dir = join(root, ".code-shell", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: the ${name} skill\n---\nbody of ${name}\n`,
  );
}

describe("skillTool honors ctx.skillAllowlist", () => {
  let cwd: string;
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "cs-skilltool-cwd-"));
    home = mkdtempSync(join(tmpdir(), "cs-skilltool-home-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    writeSkill(cwd, "allowed");
    writeSkill(cwd, "forbidden");
    invalidateSkillCache();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    invalidateSkillCache();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("invokes an allowlisted skill", async () => {
    const ctx = { cwd, skillAllowlist: ["allowed"] } as unknown as ToolContext;
    const out = await skillTool({ skill: "allowed" }, ctx);
    expect(out).toContain("body of allowed");
  });

  test("refuses a skill outside the allowlist with a role-specific message", async () => {
    const ctx = { cwd, skillAllowlist: ["allowed"] } as unknown as ToolContext;
    const out = await skillTool({ skill: "forbidden" }, ctx);
    expect(out).toContain("not available to this sub-agent");
    expect(out).not.toContain("not found"); // distinct from missing
  });

  test("empty allowlist refuses every skill", async () => {
    const ctx = { cwd, skillAllowlist: [] } as unknown as ToolContext;
    const out = await skillTool({ skill: "allowed" }, ctx);
    expect(out).toContain("not available to this sub-agent");
  });

  test("no allowlist (undefined) → normal behavior, skill invokes", async () => {
    const ctx = { cwd } as unknown as ToolContext;
    const out = await skillTool({ skill: "forbidden" }, ctx);
    expect(out).toContain("body of forbidden");
  });
});
