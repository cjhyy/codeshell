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

  // Reads are never gated, so the old registry-backed read exceptions are
  // gone; the app tree lives under ~/.code-shell, so writes still ask.
  test("installed and unregistered app files, Skill references and credentials are readable", () => {
    const escaped = join(outside, "credentials.json");
    writeFileSync(escaped, "outside\n");
    symlinkSync(escaped, join(skillRoot, "references", "escaped.md"));
    for (const path of [
      appRoot,
      join(appRoot, "README.md"),
      join(appRoot, ".codeshell-panel", "panel.json"),
      join(skillRoot, "references", "source-quality.md"),
      join(skillRoot, "references", "token.txt"),
      join(skillRoot, "references", "escaped.md"),
      join(home, ".code-shell", "panel-apps", "hidden-app", "README.md"),
    ]) {
      expect(classifyPath(path, { workspaceRoot: workspace, operation: "read" }).decision).toBe(
        "allow",
      );
    }
  });

  test("writes into the installed app tree ask", () => {
    for (const path of [
      join(appRoot, "app", "app.js"),
      join(skillRoot, "references", "source-quality.md"),
    ]) {
      expect(classifyPath(path, { workspaceRoot: workspace, operation: "write" }).decision).toBe(
        "ask",
      );
    }
  });
});
