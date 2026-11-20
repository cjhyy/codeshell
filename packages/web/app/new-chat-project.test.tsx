import { expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom } from "../src/test-utils/renderHook.js";
import { initialChatState } from "../src/lib/streamReducer.js";
import type { RemoteApp } from "../src/hooks/useRemoteApp.js";
import { DesktopChatControls } from "./DesktopControls.js";
import { ProjectSessionNavigation } from "./ProjectSessionNavigation.js";
import type { SessionSummary } from "./protocol.js";

function reactProps(node: unknown): Record<string, any> {
  const key = Object.keys(node as object).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as Record<string, any>)[key] : {};
}
function elementsByTag(node: any, tag: string): any[] {
  return [
    ...(node.tagName === tag ? [node] : []),
    ...(node.childNodes ?? []).flatMap((child: any) => elementsByTag(child, tag)),
  ];
}

const projects = [
  { id: "p-1", name: "codeshell", path: "/repo/codeshell" },
  { id: "p-2", name: "panels", path: "/repo/panels" },
];

function app(patch: Partial<RemoteApp> = {}): RemoteApp {
  return {
    status: "online",
    chat: initialChatState(),
    sessions: [],
    projects,
    permissionMode: "default",
    loading: { sessions: false, sessionHistory: false, roomHistory: false, ccSessions: false },
    ...patch,
  } as unknown as RemoteApp;
}

test("a new conversation shows a project picker; one with turns does not", () => {
  const fresh = renderToStaticMarkup(<DesktopChatControls app={app()} projectId="p-1" />);
  expect(fresh).toContain("desktop-new-chat-project");
  expect(fresh).toContain("codeshell");
  const started = renderToStaticMarkup(
    <DesktopChatControls
      app={app({
        chat: {
          ...initialChatState(),
          items: [{ id: "m1", kind: "user", text: "hi" }],
        } as RemoteApp["chat"],
      })}
      projectId="p-1"
    />,
  );
  expect(started).not.toContain("desktop-new-chat-project");
  // Adapters that do not pass the workspace keep the previous controls.
  expect(renderToStaticMarkup(<DesktopChatControls app={app()} />)).not.toContain(
    "desktop-new-chat-project",
  );
});

test("each project heading starts a conversation in that project", async () => {
  ensureMiniDom();
  const started: Array<[string | null, string | null]> = [];
  const row = (sessionId: string, cwd: string) =>
    ({
      sessionId,
      cwd,
      title: sessionId,
      startedAt: 1,
      lastActiveAt: 1,
      status: "completed",
      turnCount: 1,
    }) as SessionSummary;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ProjectSessionNavigation
        sessions={[row("a", "/repo/codeshell"), row("b", "")]}
        projects={projects}
        activeId=""
        renderSession={(session) => <li key={session.sessionId}>{session.sessionId}</li>}
        onNewSession={(target, cwd) => started.push([target, cwd])}
      />,
    );
  });
  const buttons = elementsByTag(container, "BUTTON").filter((button) =>
    String(reactProps(button)["aria-label"] ?? "").includes("中新建对话"),
  );
  expect(buttons).toHaveLength(2);
  await act(async () => {
    for (const button of buttons) reactProps(button).onClick();
  });
  expect(started).toEqual([
    ["p-1", "/repo/codeshell"],
    [null, null],
  ]);
  await act(async () => root.unmount());
});
