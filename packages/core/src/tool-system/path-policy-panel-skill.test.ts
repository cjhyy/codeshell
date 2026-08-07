import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath } from "./path-policy.js";

describe("installed Panel App Skill path policy", () => {
  let home: string;
  let workspace: string;
  let outside: string;
  let previousHome: string | undefined;
  let appRoot: string;
  let skillRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cs-panel-skill-home-"));
    workspace = mkdtempSync(join(tmpdir(), "cs-panel-skill-workspace-"));
    outside = mkdtempSync(join(tmpdir(), "cs-panel-skill-outside-"));
    previousHome = process.env.HOME;
    process.env.HOME = home;

    const panelAppsRoot = join(home, ".code-shell", "panel-apps");
    appRoot = join(panelAppsRoot, "job-hunt-hq");
    skillRoot = join(appRoot, "agent", "skills", "job-intelligence");
    mkdirSync(join(skillRoot, "references"), { recursive: true });
    mkdirSync(join(appRoot, ".codeshell-panel"), { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      "---\nname: job-intelligence\ndescription: source research\n---\n",
    );
    writeFileSync(join(skillRoot, "references", "source-quality.md"), "source rules\n");
    writeFileSync(join(skillRoot, "references", "token.txt"), "credential-shaped\n");
    writeFileSync(
      join(appRoot, ".codeshell-panel", "panel.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: "job-hunt-hq",
        agent: { skills: ["agent/skills/job-intelligence/SKILL.md"] },
      }),
    );
    writeFileSync(
      join(panelAppsRoot, "installed.json"),
      JSON.stringify({ version: 1, apps: [{ id: "job-hunt-hq" }] }),
    );
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("declared Skill references are readable without a second approval", () => {
    expect(
      classifyPath(join(skillRoot, "references", "source-quality.md"), {
        workspaceRoot: workspace,
        operation: "read",
      }),
    ).toMatchObject({ decision: "allow", reason: "registered Skill resource read" });
  });

  test("credential-shaped files and writes retain the sensitive-path boundary", () => {
    expect(
      classifyPath(join(skillRoot, "references", "token.txt"), {
        workspaceRoot: workspace,
        operation: "read",
      }).decision,
    ).toBe("ask");
    expect(
      classifyPath(join(skillRoot, "references", "source-quality.md"), {
        workspaceRoot: workspace,
        operation: "write",
      }).decision,
    ).not.toBe("allow");
  });

  test("undeclared Skill trees and symlink escapes are not trusted", () => {
    const undeclared = join(appRoot, "agent", "skills", "undeclared");
    mkdirSync(join(undeclared, "references"), { recursive: true });
    writeFileSync(
      join(undeclared, "SKILL.md"),
      "---\nname: undeclared\ndescription: hidden\n---\n",
    );
    writeFileSync(join(undeclared, "references", "notes.md"), "not declared\n");
    expect(
      classifyPath(join(undeclared, "references", "notes.md"), {
        workspaceRoot: workspace,
        operation: "read",
      }).decision,
    ).toBe("ask");

    const escaped = join(outside, "escaped.md");
    writeFileSync(escaped, "outside\n");
    symlinkSync(escaped, join(skillRoot, "references", "escaped.md"));
    expect(
      classifyPath(join(skillRoot, "references", "escaped.md"), {
        workspaceRoot: workspace,
        operation: "read",
      }).decision,
    ).toBe("ask");
  });

  test("an app directory without an installed registry entry is not trusted", () => {
    writeFileSync(
      join(home, ".code-shell", "panel-apps", "installed.json"),
      JSON.stringify({ version: 1, apps: [] }),
    );
    expect(
      classifyPath(join(skillRoot, "references", "source-quality.md"), {
        workspaceRoot: workspace,
        operation: "read",
      }).decision,
    ).toBe("ask");
  });
});
