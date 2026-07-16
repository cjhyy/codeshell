import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "SettingsPage.tsx"), "utf-8");

describe("SettingsPage scope contract", () => {
  test("scope is page state with a header switcher, not a hardcoded user constant", () => {
    expect(source).not.toContain('const scope = "user" as const');
    expect(source).toContain("SettingsScope");
    expect(source).toContain("scopeOptions");
  });

  test("modules declare supported scopes and the nav filters by the active scope", () => {
    expect(source).toContain("scopes:");
    expect(source).toContain("moduleSupportsScope");
  });

  test("project scope forwards the selected project path to sections", () => {
    expect(source).toContain("scopeProjectPath");
  });

  test("opening with an initial project preselects project scope", () => {
    expect(source).toContain("initialProjectPath");
  });

  test("instructions module: global compat toggles in user scope, project files in project scope", () => {
    expect(source).toContain('active === "instructions"');
    expect(source).toContain("ProjectInstructionsSection");
    expect(source).toContain("InstructionFilesSection");
  });

  test("project scope opens on a project overview that links to the scoped modules", () => {
    expect(source).toContain('"project-overview"');
    expect(source).toContain("ProjectOverviewSection");
  });

  test("data sources module bridges the global catalog and per-project bindings", () => {
    const module = readFileSync(join(import.meta.dir, "DataSourcesModule.tsx"), "utf-8");
    expect(source).toContain("<DataSourcesModule");
    expect(module).toContain("DataSourceCatalogSection");
    expect(module).toContain("DataSourcesSection");
  });
});
