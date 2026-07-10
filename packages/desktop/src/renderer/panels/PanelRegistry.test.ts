import { describe, expect, it } from "bun:test";
import type { PanelTab } from "../view";
import {
  getEnabledPanelEntries,
  getPanelEntry,
  PANEL_REGISTRY,
  type PanelRenderContext,
} from "./PanelRegistry";

const PANEL_KEYS: PanelTab[] = [
  "files",
  "browser",
  "review",
  "terminal",
  "shells",
  "ccRoom",
  "quickChat",
];

describe("PanelRegistry", () => {
  it("registers every built-in panel in display order", () => {
    expect([...PANEL_REGISTRY.keys()]).toEqual(PANEL_KEYS);

    for (const key of PANEL_KEYS) {
      const entry = getPanelEntry(key);
      expect(entry.key).toBe(key);
      expect(entry.label).toBe(`panels.kinds.${key}`);
      expect(entry.icon).toBeDefined();
      expect(entry.render).toBeFunction();
    }
  });

  it("keeps every existing panel enabled without an active session", () => {
    const entries = getEnabledPanelEntries({ cwd: null, engineSessionId: null });
    expect(entries.map((entry) => entry.key)).toEqual(PANEL_KEYS);
  });

  it("routes quick chat rendering through its registered host callback", () => {
    const context: PanelRenderContext = {
      cwd: "/repo",
      engineSessionId: "session-1",
      tabId: "quickChat-7",
      bucket: "repo::session-1",
      visible: true,
    };
    let received: unknown;

    const rendered = getPanelEntry("quickChat").render({
      ...context,
      renderQuickChatPanel: (args) => {
        received = args;
        return "quick-chat-body";
      },
    });

    expect(rendered).toBe("quick-chat-body");
    expect(received).toEqual({
      ownerBucket: "repo::session-1",
      tabId: "quickChat-7",
      cwd: "/repo",
    });
  });
});
