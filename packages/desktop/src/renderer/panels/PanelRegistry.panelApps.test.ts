import { afterEach, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import type { PanelRenderContext } from "./PanelRegistry";
import type { PanelAppDescriptor } from "../../shared/panel-apps";
import { getEnabledPanelEntries, getPanelEntry, replacePanelApps } from "./PanelRegistry";

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

  // A non-git project resolves to itself rather than up to a repo root, so the
  // dock's projectPath and the policy's canonical path can be different strings
  // for a worktree/subdirectory. The service reports both; a session must match
  // on either.
  test("either the requested or the canonical project path enables the app", () => {
    replacePanelApps([descriptor("studio")], "/repo/wt", {
      studio: ["/repo/wt", "/repo"],
    });
    expect(enabledKeys("/repo/wt")).toEqual(["panel-app:studio"]);
    expect(enabledKeys("/repo")).toEqual(["panel-app:studio"]);
    expect(enabledKeys("/elsewhere")).toEqual([]);
  });
});

test("one dock key resolves project-specific page descriptors, titles and Agent tools", () => {
  const one = {
    ...descriptor("studio"),
    title: "Studio One",
    hostId: "one",
    revision: "one",
    projectPaths: ["/one", "/one/worktree"],
    agent: {
      tools: [
        { name: "old_tool", description: "old", inputSchema: { type: "object" }, readOnly: true },
      ],
      skills: [],
    },
  };
  const two = {
    ...descriptor("studio"),
    title: "Studio Two",
    hostId: "two",
    revision: "two",
    projectPaths: ["/two"],
    agent: {
      tools: [
        { name: "new_tool", description: "new", inputSchema: { type: "object" }, readOnly: true },
      ],
      skills: [],
    },
  };
  replacePanelApps([one, two], "/one", { studio: ["/one", "/one/worktree", "/two"] });
  for (const [projectPath, selected] of [
    ["/one", one],
    ["/one/worktree", one],
    ["/two", two],
  ] as const) {
    expect(enabledKeys(projectPath)).toEqual(["panel-app:studio"]);
    const context = { projectPath, cwd: projectPath, engineSessionId: null };
    const entry = getPanelEntry("panel-app:studio", context)!;
    expect(entry.title).toEqual({ kind: "literal", value: selected.title });
    expect(entry.agentTools?.[0]?.name).toBe(selected.agent.tools[0]!.name);
    const rendered = getPanelEntry("panel-app:studio")!.render(
      context as PanelRenderContext,
    ) as ReactElement<{ descriptor: PanelAppDescriptor }>;
    expect(rendered.props.descriptor.hostId).toBe(selected.hostId);
  }
  expect(
    getPanelEntry("panel-app:studio", {
      projectPath: "/other",
      cwd: "/other",
      engineSessionId: null,
    }),
  ).toBeUndefined();
  expect(getPanelEntry("panel-app:studio")!.agentTools).toBeUndefined();
});

test("ambiguous variants and omitted authoritative bindings never choose the first version", () => {
  const one = { ...descriptor("studio"), projectPaths: ["/one"] };
  replacePanelApps([one, { ...one, hostId: "another" }], "/one", { studio: ["/one"] });
  expect(enabledKeys("/one")).toEqual([]);
  replacePanelApps([one], "/one", {});
  expect(enabledKeys("/one")).toEqual([]);
});
