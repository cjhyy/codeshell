import { describe, expect, test } from "bun:test";
import type { PanelAppDescriptor } from "../shared/panel-apps";
import {
  isPanelAppAvailable,
  summarizePanelApp,
  type PanelAppPolicy,
} from "./panel-app-policy";

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
    disabledApps: new Set(),
    globalDisabledApps: new Set(),
    projectOverrides: {},
    ...input,
  };
}

describe("Panel App policy", () => {
  test("Panel App availability is independent from agent plugins", () => {
    const current = policy({ disabledApps: new Set([app.appId]) });
    expect(isPanelAppAvailable(app, current)).toBe(false);
    expect(summarizePanelApp(app, current)).toMatchObject({
      kind: "panel-app",
      enabled: false,
      disabledByPolicy: true,
    });
  });

  test("global baseline and effective project state remain distinct", () => {
    const current = policy({
      globalDisabledApps: new Set([app.appId]),
      projectOverrides: { [app.appId]: "on" },
    });
    expect(isPanelAppAvailable(app, current)).toBe(true);
    expect(summarizePanelApp(app, current)).toMatchObject({
      enabled: true,
      globalEnabled: false,
      projectOverride: "on",
    });
  });
});
