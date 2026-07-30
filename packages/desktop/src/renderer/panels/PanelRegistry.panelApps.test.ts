import { afterEach, describe, expect, test } from "bun:test";
import type { PanelAppDescriptor } from "../../shared/panel-apps";
import { getEnabledPanelEntries, replacePanelApps } from "./PanelRegistry";

const descriptor = (appId: string): PanelAppDescriptor => ({
  id: `panel-app:${appId}`,
  appId,
  title: appId,
  version: "0.1.0",
  icon: "palette",
  singleton: true,
  permissions: [],
  hostId: "host",
  revision: "rev",
});

function enabledKeys(projectPath: string | null): string[] {
  return getEnabledPanelEntries({ projectPath, cwd: projectPath ?? "", engineSessionId: null })
    .map((entry) => entry.key)
    .filter((key) => key.startsWith("panel-app:"));
}

afterEach(() => {
  replacePanelApps([], null);
});

describe("replacePanelApps project scoping", () => {
  // Panel buckets are per project and the Extensions screen binds any project,
  // so an app bound only to a non-active project must still register. Keying
  // off one "active" project is what left those docks empty.
  test("an app is enabled in every project that binds it", () => {
    replacePanelApps([descriptor("studio")], "/a", { studio: ["/a", "/b"] });
    expect(enabledKeys("/a")).toEqual(["panel-app:studio"]);
    expect(enabledKeys("/b")).toEqual(["panel-app:studio"]);
    expect(enabledKeys("/c")).toEqual([]);
  });

  test("an app bound only to a non-active project is still enabled there", () => {
    replacePanelApps([descriptor("studio")], "/active", { studio: ["/other"] });
    expect(enabledKeys("/other")).toEqual(["panel-app:studio"]);
    // The active project does not bind it, so it must stay hidden there.
    expect(enabledKeys("/active")).toEqual([]);
  });

  test("apps are scoped independently of each other", () => {
    replacePanelApps([descriptor("studio"), descriptor("quant")], "/a", {
      studio: ["/a"],
      quant: ["/b"],
    });
    expect(enabledKeys("/a")).toEqual(["panel-app:studio"]);
    expect(enabledKeys("/b")).toEqual(["panel-app:quant"]);
  });

  test("no project means no panel apps", () => {
    replacePanelApps([descriptor("studio")], "/a", { studio: ["/a"] });
    expect(enabledKeys(null)).toEqual([]);
  });

  test("the legacy single-project form still scopes to that project", () => {
    replacePanelApps([descriptor("studio")], "/a");
    expect(enabledKeys("/a")).toEqual(["panel-app:studio"]);
    expect(enabledKeys("/b")).toEqual([]);
  });

  test("an empty binding map disables every app", () => {
    replacePanelApps([descriptor("studio")], "/a", {});
    expect(enabledKeys("/a")).toEqual([]);
  });
});
