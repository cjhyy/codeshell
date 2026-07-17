import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const registry = readFileSync(join(import.meta.dir, "PageRegistry.ts"), "utf-8");
const sidebar = readFileSync(join(import.meta.dir, "..", "Sidebar.tsx"), "utf-8");
const view = readFileSync(join(import.meta.dir, "..", "view.ts"), "utf-8");

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

  test("nav labels and the settings double-active predicate live in the registry", () => {
    expect(registry).toContain('"sidebar.digitalHumans"');
    expect(registry).toContain('"sidebar.automation"');
    expect(registry).toContain('"sidebar.credentials"');
    expect(registry).toContain('"sidebar.settings"');
    expect(registry).toContain('mode === "settings_page" || mode === "project_config"');
  });

  test("pet entry and the action items stay outside the registry", () => {
    expect(sidebar).toContain("PetSidebarEntry");
    expect(sidebar).toContain('t("sidebar.newConversation")');
    expect(sidebar).toContain('t("sidebar.search")');
  });
});
