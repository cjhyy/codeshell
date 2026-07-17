import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const rendererRoot = join(import.meta.dir, "..");
const appSource = readFileSync(join(rendererRoot, "App.tsx"), "utf8");
const sidebarSource = readFileSync(join(rendererRoot, "Sidebar.tsx"), "utf8");
const viewSource = readFileSync(join(rendererRoot, "view.ts"), "utf8");

describe("project config navigation", () => {
  test("persists project_config as a valid first-class view", () => {
    expect(viewSource).toContain('"project_config",');
  });

  test("opens from every project's sidebar menu, including non-git projects", () => {
    expect(sidebarSource).toContain("onOpenProjectConfig: (id: string) => void");
    expect(sidebarSource).toContain("onOpenProjectConfig(project.id)");
    expect(sidebarSource).toContain('t("projectConfig.open")');
  });

  test("opens the settings center preselected to the project's scope", () => {
    expect(appSource).toContain('view.viewMode === "project_config"');
    expect(appSource).toContain("initialProjectPath={activeProject.path}");
    expect(appSource).toContain('setViewMode("project_config")');
  });
});
