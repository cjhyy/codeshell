import { describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { PAGE_REGISTRY, PageRegistry, type PageEntry } from "./PageRegistry";

describe("PageRegistry", () => {
  it("pins the builtin sidebar nav in the historical order", () => {
    // Exactly today's Sidebar.tsx order: 数字人 → 自动化 → 凭证 → 设置.
    expect(PAGE_REGISTRY.navEntries().map((entry) => entry.key)).toEqual([
      "digital_humans",
      "automation",
      "credentials",
      "settings_page",
    ]);
  });

  it("reuses the existing sidebar i18n labels", () => {
    const titles = PAGE_REGISTRY.navEntries().map((entry) => entry.title);
    expect(titles).toEqual([
      { kind: "i18n", key: "sidebar.digitalHumans" },
      { kind: "i18n", key: "sidebar.automation" },
      { kind: "i18n", key: "sidebar.credentials" },
      { kind: "i18n", key: "sidebar.settings" },
    ]);
  });

  it("replicates the hardcoded active-state predicates exactly", () => {
    const automation = PAGE_REGISTRY.get("automation")!;
    // Preserved quirk: the automation item highlights on the runs view.
    expect(automation.nav!.isActive("runs")).toBe(true);
    expect(automation.nav!.isActive("automation")).toBe(false);
    expect(automation.nav!.target).toBe("automation");

    const settings = PAGE_REGISTRY.get("settings_page")!;
    expect(settings.nav!.isActive("settings_page")).toBe(true);
    expect(settings.nav!.isActive("project_config")).toBe(true);
    expect(settings.nav!.isActive("chat")).toBe(false);
  });

  it("marks unmigrated builtins as legacy-rendered", () => {
    for (const key of ["digital_humans", "automation", "credentials", "settings_page"]) {
      expect(PAGE_REGISTRY.get(key)!.render).toBeNull();
    }
  });

  it("supports dynamic registration, duplicate rejection, and idempotent disposal", () => {
    const registry = new PageRegistry();
    const entry: PageEntry = {
      key: "page:demo@local:report",
      owner: { kind: "builtin" },
      title: { kind: "literal", value: "Report" },
      icon: PAGE_REGISTRY.get("credentials")!.icon,
      nav: { order: 1_000, target: "page:demo@local:report", isActive: () => false },
      render: () => null,
    };
    const dispose = registry.register(entry);
    expect(registry.get(entry.key)).toBe(entry);
    expect(registry.has(entry.key)).toBe(true);
    expect(() => registry.register(entry)).toThrow(/duplicate page key/);
    dispose();
    dispose();
    expect(registry.get(entry.key)).toBeUndefined();
  });

  it("bumps the snapshot revision and notifies subscribers on changes", () => {
    const registry = new PageRegistry();
    let notified = 0;
    const unsubscribe = registry.subscribe(() => {
      notified += 1;
    });
    const before = registry.snapshot();
    const dispose = registry.register({
      key: "page:demo@local:one",
      owner: { kind: "builtin" },
      title: { kind: "literal", value: "One" },
      icon: PAGE_REGISTRY.get("credentials")!.icon,
      render: () => null,
    });
    expect(registry.snapshot()).toBeGreaterThan(before);
    expect(notified).toBe(1);
    dispose();
    expect(notified).toBe(2);
    unsubscribe();
  });
});

describe("migrated builtin pages", () => {
  it("registers logs and runs as render-only pages (no nav item)", () => {
    const logs = PAGE_REGISTRY.get("logs")!;
    const runs = PAGE_REGISTRY.get("runs")!;
    expect(logs.nav).toBeUndefined();
    expect(runs.nav).toBeUndefined();
    expect(logs.render).toBeFunction();
    expect(runs.render).toBeFunction();
    // The sidebar nav must not grow.
    expect(PAGE_REGISTRY.navEntries().map((entry) => entry.key)).toEqual([
      "digital_humans",
      "automation",
      "credentials",
      "settings_page",
    ]);
  });

  it("threads the runs deep-link through the render context", () => {
    const element = PAGE_REGISTRY.get("runs")!.render!({
      runsInitialRunId: "run-42",
    }) as ReactElement<{ initialRunId?: string | null }>;
    expect(element.props.initialRunId).toBe("run-42");
  });
});
