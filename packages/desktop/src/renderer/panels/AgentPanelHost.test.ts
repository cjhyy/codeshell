import { describe, expect, test } from "bun:test";
import { installQuickChatPanelPlugin } from "./plugins/quickChatPlugin";
import { resolveAgentPanelHostRequest } from "./AgentPanelHost";

installQuickChatPanelPlugin();

describe("resolveAgentPanelHostRequest", () => {
  test("lists code-backed panels and opens them by stable id", () => {
    const availability = { cwd: "/repo", engineSessionId: "session-1" };
    const listed = resolveAgentPanelHostRequest(
      {
        requestId: "request-list",
        sessionId: "session-1",
        bucket: "repo::session-1",
        action: "list",
      },
      { availability, translate: (key) => key, open: () => {} },
    );
    expect(listed.result).toMatchObject({
      ok: true,
      panels: expect.arrayContaining([
        { id: "quickChat", title: "panels.kinds.quickChat", source: "code" },
      ]),
    });

    const opened: string[] = [];
    const response = resolveAgentPanelHostRequest(
      {
        requestId: "request-open",
        sessionId: "session-1",
        bucket: "repo::session-1",
        action: "open",
        panelId: "quickChat",
      },
      { availability, translate: (key) => key, open: (panelId) => opened.push(panelId) },
    );
    expect(response.result).toEqual({ ok: true, panelId: "quickChat" });
    expect(opened).toEqual(["quickChat"]);
  });

  test("rejects a stale or disabled panel id", () => {
    const response = resolveAgentPanelHostRequest(
      {
        requestId: "request-missing",
        sessionId: "session-1",
        bucket: "repo::session-1",
        action: "open",
        panelId: "plugin:missing@local:panel",
      },
      {
        availability: { cwd: "/repo", engineSessionId: "session-1" },
        translate: (key) => key,
        open: () => {
          throw new Error("must not open");
        },
      },
    );
    expect(response.result).toMatchObject({ ok: false, panelId: "plugin:missing@local:panel" });
  });
});
