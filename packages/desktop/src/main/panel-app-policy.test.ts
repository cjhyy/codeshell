import { describe, expect, test } from "bun:test";
import type { PanelAppDescriptor } from "../shared/panel-apps";
import { isPanelAppAvailable, summarizePanelApp, type PanelAppPolicy } from "./panel-app-policy";

const app: PanelAppDescriptor = {
  id: "panel-app:design-studio",
  appId: "design-studio",
  title: "Design Studio",
  version: "0.1.0",
  icon: "palette",
  singleton: true,
  permissions: ["context.workspace"],
  hostId: "host",
  revision: "revision",
};

function policy(input: Partial<PanelAppPolicy> = {}): PanelAppPolicy {
  return {
    globalDisabledApps: new Set(),
    boundApps: new Set(),
    projectOverrides: {},
    ...input,
  };
}

describe("Panel App policy", () => {
  test("a legacy global denylist entry still vetoes a bound project", () => {
    const current = policy({
      boundApps: new Set([app.appId]),
      globalDisabledApps: new Set([app.appId]),
    });
    expect(isPanelAppAvailable(app, current)).toBe(false);
    // The denylist has no UI anymore, so `projectBound` stays true while
    // `enabled` reports the vetoed effective state; the Extensions list turns
    // that difference into the "blocked by the global deny list" badge.
    expect(summarizePanelApp(app, current)).toMatchObject({
      kind: "panel-app",
      enabled: false,
      projectBound: true,
    });
  });

  test("a bound project is enabled and keeps its legacy override marker", () => {
    const current = policy({
      boundApps: new Set([app.appId]),
      projectOverrides: { [app.appId]: "on" },
    });
    expect(isPanelAppAvailable(app, current)).toBe(true);
    expect(summarizePanelApp(app, current)).toMatchObject({
      enabled: true,
      projectBound: true,
      projectOverride: "on",
    });
  });

  test("installed apps stay unavailable until this project binds them", () => {
    const current = policy();
    expect(isPanelAppAvailable(app, current)).toBe(false);
    expect(summarizePanelApp(app, current)).toMatchObject({
      enabled: false,
      projectBound: false,
    });
  });
});
