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
    mkdirSync(join(appRoot, "app"), { recursive: true });
    writeFileSync(join(appRoot, "app", "app.js"), "export const ready = true;\n");
    writeFileSync(join(appRoot, "README.md"), "# Job Hunt HQ\n");
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

  test("installed Panel App package and Skill resources are readable without approval", () => {
    for (const path of [
      appRoot,
      join(appRoot, "README.md"),
      join(appRoot, "app", "app.js"),
      join(appRoot, ".codeshell-panel", "panel.json"),
      join(skillRoot, "references", "source-quality.md"),
    ]) {
      expect(
        classifyPath(path, {
          workspaceRoot: workspace,
          operation: "read",
        }),
      ).toMatchObject({ decision: "allow", reason: "installed Panel App resource read" });
    }
  });

  test("user Skill references remain readable without a second approval", () => {
    const userSkillRoot = join(home, ".code-shell", "skills", "personal-notes");
    mkdirSync(join(userSkillRoot, "references"), { recursive: true });
    writeFileSync(
      join(userSkillRoot, "SKILL.md"),
      "---\nname: personal-notes\ndescription: notes\n---\n",
    );
    writeFileSync(join(userSkillRoot, "references", "guide.md"), "guide\n");
    expect(
      classifyPath(join(userSkillRoot, "references", "guide.md"), {
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

  test("all installed app code is readable but symlink escapes are not trusted", () => {
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
    ).toBe("allow");

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

  test("an unregistered sibling app is not trusted", () => {
    const unregistered = join(home, ".code-shell", "panel-apps", "hidden-app");
    mkdirSync(join(unregistered, ".codeshell-panel"), { recursive: true });
    writeFileSync(
      join(unregistered, ".codeshell-panel", "panel.json"),
      JSON.stringify({ schemaVersion: 2, id: "hidden-app" }),
    );
    writeFileSync(join(unregistered, "README.md"), "hidden\n");
    expect(
      classifyPath(join(unregistered, "README.md"), {
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
