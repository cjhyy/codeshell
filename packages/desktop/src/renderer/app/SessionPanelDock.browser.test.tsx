import { afterEach, beforeEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { ToastProvider } from "../ui/ToastProvider";
import { SessionPanelDock } from "./SessionPanelDock";
import { emptyPanelBucketState } from "./appUtils";

function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function elements(node: any, tag: string): any[] {
  return [
    ...(node.tagName === tag ? [node] : []),
    ...(node.childNodes ?? []).flatMap((child: any) => elements(child, tag)),
  ];
}
function textOf(node: any): string {
  return (node.nodeValue ?? node.textContent ?? "") + (node.childNodes ?? []).map(textOf).join("");
}
let root: Root;
let container: HTMLElement;
let activeBucket: string;
let localPanelsReady: boolean;
let projectPath: string;
let projectPresent: boolean;
let engineSuffix: string;
let panelByBucket: React.ComponentProps<typeof SessionPanelDock>["panelByBucket"];
const a = "project::session-a";
const b = "project::session-b";
const openListeners = new Set<(input: { url: string; bucket: string }) => void>();
const workspaceListeners = new Set<(input: { sessionId: string }) => void>();
let requests: number;
const grants = new Map<string, any>();
async function render() {
  const noop = () => {};
  await act(async () => {
    root.render(
      <ToastProvider>
        <SessionPanelDock
          panelBuckets={Object.keys(panelByBucket)}
          panelByBucket={panelByBucket}
          activeBucket={activeBucket}
          isChatView
          localPanelsReady={localPanelsReady}
          projects={
            projectPresent ? [{ id: "project", name: "Project", path: projectPath } as any] : []
          }
          updatePanelBucket={(bucket, next) => {
            panelByBucket = { ...panelByBucket, [bucket]: next(panelByBucket[bucket]!) };
          }}
          onRevealConsumed={noop}
          onOpenCliSessionConsumed={noop}
          panelWidth={480}
          beginPanelResize={noop}
          onAttachImage={noop}
          anchorsByBucket={{}}
          removeAnchor={noop}
          updateAnchorComment={noop}
          resolveEngineSessionIdForBucket={(bucket) => `${bucket.split("::")[1]}${engineSuffix}`}
          quickChatSessions={{}}
          transcripts={{}}
          busyKeys={new Set()}
          approvalForBucket={() => null}
          noRepoCwd={null}
          permissionOverrides={{}}
          defaultPermissionMode="default"
          modelOverrides={{}}
          defaultSessionModelKey={null}
          defaultActiveModelKey={null}
          quickChatDrafts={{}}
          quickChatAttachments={{}}
          quickChatImageComposer={() => undefined as any}
          modelOptions={[]}
          imageDetail={undefined}
          setQuickChatPermission={noop}
          setQuickChatModel={noop}
          ensureQuickChatSession={noop}
          cleanupQuickChatPanelSession={noop}
          restartQuickChatSession={noop}
          setQuickChatDraft={noop}
          setQuickChatAttachmentState={noop}
          sendQuickChat={noop}
          stop={noop}
          handleAskUserAnswer={noop}
          decideEnvelope={noop}
        />
      </ToastProvider>,
    );
    await flushMicrotasks();
  });
}
beforeEach(() => {
  ensureMiniDom();
  activeBucket = a;
  localPanelsReady = true;
  projectPath = "/repo";
  projectPresent = true;
  engineSuffix = "";
  panelByBucket = {
    [a]: {
      ...emptyPanelBucketState(),
      open: true,
      tabs: [{ id: "browser-a", kind: "browser" }],
      activeId: "browser-a",
      openUrl: { url: "https://example.test/a", nonce: 1 },
    },
  };
  openListeners.clear();
  workspaceListeners.clear();
  grants.clear();
  requests = 0;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem() {} },
  });
  Object.assign(window, {
    codeshell: {
      getSessionWorkspace: async () => {
        requests++;
        return { root: "/repo", kind: "main" };
      },
      onWorkspaceChanged(callback: any) {
        workspaceListeners.add(callback);
        return () => workspaceListeners.delete(callback);
      },
      probeLocalhostPorts: async () => [],
      registerBrowserSessionBucket() {},
      registerBrowserGuest() {},
      onBrowserOpenTab(callback: any) {
        openListeners.add(callback);
        return () => openListeners.delete(callback);
      },
      getBuiltInBrowserRuntimeHandoff: async (id: string) =>
        grants.get(id) ?? { sessionId: id, granted: false },
      getChromeBrowserRuntimeStatus: async () => {
        throw Error("unavailable");
      },
      grantBuiltInBrowserToRuntime: async (input: any) => {
        const result = {
          sessionId: input.sessionId,
          guestId: input.guestId,
          granted: true,
          title: "Selected A",
          url: "https://example.test/a",
        };
        grants.set(input.sessionId, result);
        return result;
      },
    },
  });
  container = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    await flushMicrotasks();
  });
});
test("retains actual browser tabs and selected target through another session and workspace refresh", async () => {
  await render();
  const view = elements(container, "WEBVIEW")[0];
  expect(view).toBeDefined();
  Object.assign(view, {
    canGoBack: () => false,
    canGoForward: () => false,
    getWebContentsId: () => 42,
  });
  await act(async () => {
    view.dispatchEvent(new Event("dom-ready"));
    await flushMicrotasks();
  });
  const select = elements(container, "BUTTON").find((node) => textOf(node) === "用于当前对话");
  await act(async () => {
    props(select).onClick();
    await flushMicrotasks();
  });
  await act(async () => {
    openListeners.forEach((cb) => cb({ url: "https://example.test/b", bucket: a }));
    await flushMicrotasks();
  });
  expect(elements(container, "WEBVIEW")).toHaveLength(2);
  activeBucket = b;
  panelByBucket = {
    ...panelByBucket,
    [b]: {
      ...emptyPanelBucketState(),
      open: true,
      tabs: [{ id: "browser-b", kind: "browser" }],
      activeId: "browser-b",
    },
  };
  await render();
  await act(async () => {
    workspaceListeners.forEach((cb) => cb({ sessionId: "session-a" }));
    await flushMicrotasks();
  });
  activeBucket = a;
  await render();
  expect(requests).toBe(3);
  expect(elements(container, "WEBVIEW")).toHaveLength(2);
  expect(elements(container, "WEBVIEW")[0]).toBe(view);
  expect(textOf(container)).toContain("当前对话使用：Selected A");
});

test("keeps selected guests hidden while pending or cloud and admits only the newly resolved bucket", async () => {
  await render();
  const original = elements(container, "WEBVIEW")[0];
  localPanelsReady = false;
  activeBucket = b;
  panelByBucket = {
    ...panelByBucket,
    [b]: {
      ...emptyPanelBucketState(),
      open: true,
      tabs: [{ id: "browser-b", kind: "browser" }],
      activeId: "browser-b",
      openUrl: { url: "https://example.test/b", nonce: 2 },
    },
  };
  await render();
  expect(elements(container, "WEBVIEW")).toEqual([original]);
  const surfaces = elements(container, "DIV").filter(
    (node) => props(node)["data-theme-surface"] === "panel",
  );
  expect(surfaces).toHaveLength(1);
  expect(props(surfaces[0])["aria-hidden"]).toBe(true);
  expect(requests).toBe(1);
  localPanelsReady = true;
  await render();
  expect(elements(container, "WEBVIEW")).toHaveLength(2);
  expect(elements(container, "WEBVIEW")[0]).toBe(original);
  expect(requests).toBe(2);
  localPanelsReady = false;
  await render();
  expect(elements(container, "WEBVIEW")).toHaveLength(2);
  activeBucket = a;
  localPanelsReady = true;
  await render();
  expect(elements(container, "WEBVIEW")[0]).toBe(original);
});

test("does not reuse admission when the session or project identity changes during resolution", async () => {
  await render();
  const original = elements(container, "WEBVIEW")[0];
  localPanelsReady = false;
  engineSuffix = "-replacement";
  await render();
  expect(elements(container, "WEBVIEW")).toHaveLength(0);
  localPanelsReady = true;
  await render();
  expect(elements(container, "WEBVIEW")[0]).not.toBe(original);
  localPanelsReady = false;
  projectPath = "/repo-replacement";
  await render();
  expect(elements(container, "WEBVIEW")).toHaveLength(0);
});

test("does not mount any saved body before the initial local runtime resolves", async () => {
  localPanelsReady = false;
  await render();
  expect(elements(container, "WEBVIEW")).toHaveLength(0);
  expect(requests).toBe(0);
  localPanelsReady = true;
  await render();
  expect(elements(container, "WEBVIEW")).toHaveLength(1);
  expect(requests).toBe(1);
});

test("forgets removed projects and buckets instead of restoring their old admission", async () => {
  await render();
  projectPresent = false;
  await render();
  expect(elements(container, "WEBVIEW")).toHaveLength(0);
  localPanelsReady = false;
  projectPresent = true;
  await render();
  expect(elements(container, "WEBVIEW")).toHaveLength(0);
  localPanelsReady = true;
  await render();
  expect(elements(container, "WEBVIEW")).toHaveLength(1);
  const previous = panelByBucket;
  panelByBucket = {};
  await render();
  localPanelsReady = false;
  panelByBucket = previous;
  await render();
  expect(elements(container, "WEBVIEW")).toHaveLength(0);
});

test("replaces an existing guest when its engine or project identity changes while ready", async () => {
  await render();
  const original = elements(container, "WEBVIEW")[0];
  engineSuffix = "-replacement";
  await render();
  const replacement = elements(container, "WEBVIEW")[0];
  expect(replacement).toBeDefined();
  expect(replacement).not.toBe(original);
  projectPath = "/repo-replacement";
  await render();
  expect(elements(container, "WEBVIEW")[0]).not.toBe(replacement);
});
