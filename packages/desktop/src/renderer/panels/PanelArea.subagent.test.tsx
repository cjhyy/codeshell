import { afterEach, expect, test } from "bun:test";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MessageStream } from "../MessageStream";
import type { SubagentSelection } from "../subagents/SubagentNavigation";
import type { AgentMessage } from "../types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PanelArea, type OpenTab } from "./PanelArea";

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
async function click(node: any) {
  expect(node).toBeDefined();
  await act(async () => {
    props(node).onClick({ stopPropagation() {}, currentTarget: node });
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
function agent(id: string): AgentMessage {
  return {
    kind: "agent",
    id,
    name: id,
    description: `Task ${id}`,
    done: true,
    startedAt: 1,
    toolCalls: [],
    toolCount: 0,
    textBuffer: "",
  };
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

test("child conversations open in a retained dock tab while the parent stream and draft stay mounted", async () => {
  ensureMiniDom();
  descriptor = Object.getOwnPropertyDescriptor(window, "codeshell");
  const reads: string[] = [];
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: {
      listDiskSessions: async () => ({ sessions: [], nextCursor: null }),
      getSessionTranscript: async (id: string) => {
        reads.push(id);
        return [{ kind: "user", text: `Transcript ${id}` }];
      },
    },
  });
  const container = document.createElement("div");
  root = createRoot(container);
  function Harness() {
    const [selection, setSelection] = useState<SubagentSelection>();
    const [nonce, setNonce] = useState(0);
    const [open, setOpen] = useState(false);
    const [tabs, setTabs] = useState<OpenTab[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    return (
      <div className="flex">
        <main>
          <MessageStream
            engineSessionId="parent"
            messages={[
              { kind: "user", id: "parent-message", text: "Parent conversation" },
              agent("first"),
              agent("second"),
            ]}
            onViewSubagent={(next) => {
              setSelection(next);
              setNonce((value) => value + 1);
              setOpen(true);
            }}
          />
          <textarea defaultValue="Unsent draft" />
        </main>
        {selection && (
          <PanelArea
            projectPath={null}
            engineSessionId="parent"
            bucket="project::parent"
            hidden={!open}
            onClose={() => setOpen(false)}
            tabs={tabs}
            setTabs={setTabs}
            activeId={activeId}
            setActiveId={setActiveId}
            requestNonce={nonce}
            requestKind="subagent"
            subagentSelection={selection}
            width={480}
            onResizeStart={() => undefined}
          />
        )}
      </div>
    );
  }
  await act(async () => {
    root!.render(<Harness />);
    await flushMicrotasks();
  });
  const main = nodes(container, "MAIN")[0];
  const parentStream = nodes(main, "DIV").find((node) =>
    props(node).className?.includes("cs-chat-transcript"),
  );
  expect(Boolean(parentStream)).toBe(true);
  const draft = nodes(main, "TEXTAREA")[0];
  async function openAgent(id: string) {
    const findHeader = () =>
      nodes(main, "BUTTON").find((node) => props(node)["aria-controls"] === `agent-body-${id}`);
    for (let attempt = 0; !findHeader() && attempt < 6; attempt++) {
      await click(nodes(main, "BUTTON").find((node) => props(node)["aria-expanded"] === false));
    }
    const header = findHeader();
    expect(header).toBeDefined();
    if (props(header)["aria-expanded"] === false) await click(header);
    const body = nodes(main, "DIV").find((node) => props(node).id === `agent-body-${id}`);
    await click(nodes(body, "BUTTON").find((node) => text(node) === "完整对话"));
  }
  await openAgent("first");
  expect(reads).toContain("first");
  expect(text(main)).toContain("Parent conversation");
  expect(nodes(main, "TEXTAREA")[0]).toBe(draft);
  expect(nodes(main, "DIV").includes(parentStream)).toBe(true);
  let tab = nodes(container, "BUTTON").find((node) => props(node).role === "tab");
  const tabId = props(tab).id;
  expect(text(tab)).toContain("first");
  expect(nodes(container, "DIV").filter((node) => props(node).role === "tabpanel")).toHaveLength(1);
  expect(text(nodes(container, "DIV").find((node) => props(node).role === "tabpanel"))).toContain(
    "Transcript first",
  );
  expect(text(main)).not.toContain("Transcript first");

  await openAgent("second");
  tab = nodes(container, "BUTTON").find((node) => props(node).role === "tab");
  expect(props(tab).id).toBe(tabId);
  expect(text(tab)).toContain("second");
  expect(text(container)).toContain("Transcript second");
  expect(text(container)).not.toContain("Transcript first");
  expect(nodes(main, "TEXTAREA")[0]).toBe(draft);

  await click(
    nodes(container, "BUTTON").find((node) => props(node)["aria-label"]?.startsWith("关闭标签:")),
  );
  expect(text(main)).toContain("Parent conversation");
  expect(nodes(main, "DIV").includes(parentStream)).toBe(true);
  expect(nodes(main, "TEXTAREA")[0]).toBe(draft);
  expect(nodes(container, "DIV").filter((node) => props(node).role === "tabpanel")).toHaveLength(0);
});
