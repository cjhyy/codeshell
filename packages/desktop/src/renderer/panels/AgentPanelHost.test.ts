import { describe, expect, test } from "bun:test";
import { installQuickChatPanelApp } from "./apps/quickChatPanelApp";
import { resolveAgentPanelHostRequest } from "./AgentPanelHost";
import { replacePanelApps } from "./PanelRegistry";

installQuickChatPanelApp();

describe("resolveAgentPanelHostRequest", () => {
  test("lists built-in Panel Apps and opens them by stable id", async () => {
    const availability = {
      projectPath: "/repo",
      cwd: "/repo",
      engineSessionId: "session-1",
    };
    const listed = await resolveAgentPanelHostRequest(
      {
        requestId: "request-list",
        sessionId: "session-1",
        bucket: "repo::session-1",
        action: "list",
      },
      { availability, translate: (key) => key, open: () => {}, invoke: async () => null },
    );
    expect(listed.result).toMatchObject({
      ok: true,
      panels: expect.arrayContaining([
        {
          id: "quickChat",
          title: "panels.kinds.quickChat",
          source: "builtin-panel-app",
        },
      ]),
    });

    const opened: string[] = [];
    const response = await resolveAgentPanelHostRequest(
      {
        requestId: "request-open",
        sessionId: "session-1",
        bucket: "repo::session-1",
        action: "open",
        panelId: "quickChat",
      },
      {
        availability,
        translate: (key) => key,
        open: (panelId) => opened.push(panelId),
        invoke: async () => null,
      },
    );
    expect(response.result).toEqual({ ok: true, panelId: "quickChat" });
    expect(opened).toEqual(["quickChat"]);
  });

  test("rejects a stale or disabled panel id", async () => {
    const response = await resolveAgentPanelHostRequest(
      {
        requestId: "request-missing",
        sessionId: "session-1",
        bucket: "repo::session-1",
        action: "open",
        panelId: "panel-app:missing:panel",
      },
      {
        availability: {
          projectPath: "/repo",
          cwd: "/repo",
          engineSessionId: "session-1",
        },
        translate: (key) => key,
        open: () => {
          throw new Error("must not open");
        },
        invoke: async () => {
          throw new Error("must not invoke");
        },
      },
    );
    expect(response.result).toMatchObject({ ok: false, panelId: "panel-app:missing:panel" });
  });

  test("lists and invokes tools owned by a Panel App", async () => {
    replacePanelApps(
      [
        {
          id: "panel-app:design-studio",
          appId: "design-studio",
          title: "Design Studio",
          version: "0.3.0",
          icon: "palette",
          singleton: true,
          permissions: [],
          agent: {
            tools: [
              {
                name: "use_design",
                description: "Edit design",
                inputSchema: { type: "object" },
                readOnly: false,
              },
            ],
            skills: ["agent/skills/repo-design/SKILL.md"],
          },
          hostId: "host",
          revision: "revision",
        },
      ],
      "/repo",
    );
    try {
      const unrelated = await resolveAgentPanelHostRequest(
        {
          requestId: "request-other-project",
          sessionId: "session-2",
          bucket: "other::session-2",
          action: "list",
        },
        {
          availability: {
            projectPath: "/other",
            cwd: "/other",
            engineSessionId: "session-2",
          },
          translate: (key) => key,
          open: () => {},
          invoke: async () => null,
        },
      );
      expect(
        "panels" in unrelated.result
          ? unrelated.result.panels.some((panel) => panel.id === "panel-app:design-studio")
          : false,
      ).toBe(false);

      const availability = {
        projectPath: "/repo",
        cwd: "/repo",
        engineSessionId: "session-1",
      };
      const tools = await resolveAgentPanelHostRequest(
        {
          requestId: "request-tools",
          sessionId: "session-1",
          bucket: "repo::session-1",
          action: "tools",
          panelId: "panel-app:design-studio",
        },
        { availability, translate: (key) => key, open: () => {}, invoke: async () => null },
      );
      expect(tools.result).toMatchObject({
        ok: true,
        panelId: "panel-app:design-studio",
        tools: [{ name: "use_design" }],
      });
      const opened: string[] = [];
      const invoked = await resolveAgentPanelHostRequest(
        {
          requestId: "request-invoke",
          sessionId: "session-1",
          bucket: "repo::session-1",
          action: "invoke",
          panelId: "panel-app:design-studio",
          toolName: "use_design",
          arguments: { operations: [] },
        },
        {
          availability,
          translate: (key) => key,
          open: (panelId) => opened.push(panelId),
          invoke: async (_panelId, toolName) => ({ toolName, changed: true }),
        },
      );
      expect(invoked.result).toMatchObject({
        ok: true,
        toolName: "use_design",
        result: { changed: true },
      });
      expect(opened).toEqual(["panel-app:design-studio"]);
    } finally {
      replacePanelApps([], null);
    }
  });
});
