import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const registry = readFileSync(join(import.meta.dir, "PageRegistry.ts"), "utf-8");
const sidebar = readFileSync(join(import.meta.dir, "..", "Sidebar.tsx"), "utf-8");
const view = readFileSync(join(import.meta.dir, "..", "view.ts"), "utf-8");
const app = readFileSync(join(import.meta.dir, "..", "App.tsx"), "utf-8");

describe("PageRegistry contract", () => {
  test("view modes are builtin enum + registry keys with legacy migrations", () => {
    expect(view).toContain("BUILTIN_VIEW_MODES");
    expect(view).toContain("isRegisteredPage");
    expect(view).toContain('"customize"');
    expect(view).toContain("settings_page");
  });

  test("the sidebar first-level nav is registry-driven, not hardcoded", () => {
    expect(sidebar).toContain("PAGE_REGISTRY");
    expect(sidebar).toContain("navEntries");
    expect(sidebar).toContain("useSyncExternalStore");
    expect(sidebar).toContain("onNavigate");
    // The four page items no longer carry per-page props or literals.
    expect(sidebar).not.toContain("onOpenDigitalHumans");
    expect(sidebar).not.toContain("onOpenAutomations");
    expect(sidebar).not.toContain("onOpenCredentials");
    expect(sidebar).not.toContain('t("sidebar.digitalHumans")');
    expect(sidebar).not.toContain('t("sidebar.credentials")');
  });

  test("nav labels live in the registry while settings stays footer-only", () => {
    expect(registry).toContain('"sidebar.digitalHumans"');
    expect(registry).toContain('"sidebar.automation"');
    expect(registry).toContain('"sidebar.credentials"');
    expect(registry).toContain('"sidebar.settings"');
    expect(registry).not.toContain('target: "settings_page"');
    expect(sidebar).toContain("SettingsMenu");
  });

  test("pet entry and the action items stay outside the registry", () => {
    expect(sidebar).toContain("PetSidebarEntry");
    expect(sidebar).toContain('t("sidebar.newConversation")');
    expect(sidebar).toContain('t("sidebar.search")');
  });

  test("App renders migrated pages through the registry, others via the legacy ternary", () => {
    expect(app).toContain("PAGE_REGISTRY");
    expect(app).toContain("runsInitialRunId");
    // Migrated branches are gone from the ternary chain…
    expect(app).not.toContain('view.viewMode === "logs"');
    expect(app).not.toContain('view.viewMode === "runs"');
    expect(app).not.toContain('import("./logs/LogsView")');
    expect(app).not.toContain('import("./runs/RunsView")');
    // …while unmigrated branches remain.
    expect(app).toContain('view.viewMode === "approvals"');
    expect(app).toContain('view.viewMode === "automation"');
    expect(app).toContain('view.viewMode === "credentials"');
    expect(app).toContain('view.viewMode === "digital_humans"');
    // Persisted registry keys survive loadView.
    expect(app).toContain("loadView((mode) => PAGE_REGISTRY.has(mode))");
  });
});
