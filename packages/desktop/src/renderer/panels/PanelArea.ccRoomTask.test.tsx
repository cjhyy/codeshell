import { afterEach, expect, test } from "bun:test";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { OpenCliSessionRequest } from "../cc-room/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import type { OpenTab } from "./PanelArea";

// App integration suites mock the canonical PanelArea module. Keep this
// interaction test on the real dock regardless of the shared shard's order.
const { PanelArea } = await import("./PanelArea?cc-room-task-dock-test");

let root: Root | undefined;
let descriptor: PropertyDescriptor | undefined;

function nodes(node: any, tag: string): any[] {
  return [
    ...(node.tagName === tag ? [node] : []),
    ...Array.from(node.childNodes ?? []).flatMap((child) => nodes(child, tag)),
  ];
}
function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function text(node: any): string {
  if (node.nodeType === 3) return node.nodeValue ?? node.textContent ?? "";
  return node.childNodes?.length
    ? Array.from(node.childNodes).map(text).join("")
    : (node.textContent ?? "");
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = undefined;
  if (descriptor) Object.defineProperty(window, "codeshell", descriptor);
  else Reflect.deleteProperty(window, "codeshell");
});

test("a DriveAgent task link binds one CC Room tab and leaves the session list reachable", async () => {
  ensureMiniDom();
  descriptor = Object.getOwnPropertyDescriptor(window, "codeshell");
  const pending = () => new Promise<never>(() => undefined);
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: {
      listBackgroundWork: pending,
      ccRoom: { probe: pending, codexProbe: pending },
    },
  });
  const container = document.createElement("div");
  root = createRoot(container);
  let tabs: OpenTab[] = [];
  let setTabs!: React.Dispatch<React.SetStateAction<OpenTab[]>>;
  let request!: (next: OpenCliSessionRequest) => void;
  function Harness() {
    const [state, setState] = useState<{ nonce: number; cli?: OpenCliSessionRequest }>({
      nonce: 0,
    });
    const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    tabs = openTabs;
    setTabs = setOpenTabs;
    request = (cli) => setState((prev) => ({ nonce: prev.nonce + 1, cli }));
    return (
      <PanelArea
        projectPath="/repo"
        engineSessionId="parent"
        bucket="project::parent"
        hidden={false}
        onClose={() => undefined}
        tabs={openTabs}
        setTabs={setOpenTabs}
        activeId={activeId}
        setActiveId={setActiveId}
        requestNonce={state.nonce}
        requestKind={state.cli ? "ccRoom" : null}
        openCliSession={state.cli}
        width={480}
        onResizeStart={() => undefined}
      />
    );
  }
  const body = (tabId: string) =>
    nodes(container, "DIV").find((node) => String(props(node).id ?? "").endsWith(`-body-${tabId}`));
  const job = (jobId: string, nonce: number): OpenCliSessionRequest => ({
    nonce,
    jobId,
    sourceSessionId: "parent",
    title: `DriveAgent(claude): ${jobId}`,
    cliKind: "claude-code",
    cwd: "/repo",
  });
  async function step(fn: () => void) {
    await act(async () => {
      fn();
      await flushMicrotasks();
      await flushMicrotasks();
    });
  }

  await step(() => root!.render(<Harness />));
  await step(() => request(job("job-1", 1)));
  expect(tabs).toEqual([{ id: expect.any(String), kind: "ccRoom", cliTask: "parent:job-1" }]);
  const taskTab = tabs[0]!.id;
  expect(text(body(taskTab))).toContain("返回主会话");
  expect(text(container)).toContain("DriveAgent(claude): job-1");

  // A CC Room tab the user adds next to the task shows the session list.
  await step(() => setTabs((prev) => [...prev, { id: "ccRoom-list", kind: "ccRoom" }]));
  expect(text(body("ccRoom-list"))).toContain("正在检测 Claude Code CLI");
  expect(text(body("ccRoom-list"))).not.toContain("返回主会话");

  // Another task link reuses the task tab instead of taking over the list.
  await step(() => request(job("job-2", 2)));
  expect(tabs.map((tab) => [tab.id, tab.cliTask])).toEqual([
    [taskTab, "parent:job-2"],
    ["ccRoom-list", undefined],
  ]);
  expect(text(container)).toContain("DriveAgent(claude): job-2");
  expect(text(body("ccRoom-list"))).toContain("正在检测 Claude Code CLI");

  // The task page's own button turns its tab back into the list.
  const allSessions = nodes(body(taskTab), "BUTTON").find(
    (node) => text(node) === "全部 Claude Code 会话",
  );
  await step(() => props(allSessions).onClick());
  expect(tabs[0]).toEqual({ id: taskTab, kind: "ccRoom" });
  expect(text(body(taskTab))).toContain("正在检测 Claude Code CLI");
  expect(text(container)).not.toContain("DriveAgent(claude): job-2");
});
