import { afterEach, describe, expect, spyOn, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FoldItem } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { MessageStream } from "../MessageStream";
import { BackgroundShellPanel } from "../panels/BackgroundShellPanel";
import { MessageRow } from "../cc-room/CCConversationView";
import { SubagentSessionDetail } from "./SubagentSessionDetail";
import { foldTranscript, foldTranscriptIncremental } from "../automation/foldTranscript";
import { subagentIdForTool, type SubagentSelection } from "./SubagentNavigation";
import type { AgentMessage, Message, ToolMessage } from "../types";

let root: Root | null = null;
function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

function nodes(node: any, tag: string): any[] {
  return [
    ...(node.tagName === tag ? [node] : []),
    ...(node.childNodes ?? []).flatMap((child: any) => nodes(child, tag)),
  ];
}
function text(node: any): string {
  if (node.nodeType === 3) return node.nodeValue ?? node.textContent ?? "";
  return node.childNodes?.length ? node.childNodes.map(text).join("") : (node.textContent ?? "");
}
async function click(node: any) {
  expect(node).toBeDefined();
  await act(async () => {
    props(node).onClick({ stopPropagation() {} });
    await flushMicrotasks();
  });
}
async function mount(element: React.ReactNode) {
  ensureMiniDom();
  const container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
    await flushMicrotasks();
  });
  return container;
}
async function rerender(element: React.ReactNode) {
  await act(async () => {
    root!.render(element);
    await flushMicrotasks();
  });
}
async function filesChanged() {
  await act(async () => {
    window.dispatchEvent(new Event("codeshell:files-changed"));
    await flushMicrotasks();
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function transcript(label: string): FoldItem[] {
  return [
    { kind: "user", text: label },
    {
      kind: "stream",
      event: {
        type: "tool_use_start",
        toolCall: {
          id: "navigate",
          toolName: "browser_navigate",
          args: { url: "https://example.test/doc" },
        },
      },
    },
    {
      kind: "stream",
      event: {
        type: "tool_result",
        result: {
          id: "navigate",
          toolName: "browser_navigate",
          result: "Permission denied: browser login unavailable",
          error: "Permission denied",
        },
      },
    },
  ];
}
function agent(id: string, description: string): AgentMessage {
  return {
    kind: "agent",
    id,
    description,
    done: true,
    startedAt: 1,
    toolCalls: [],
    toolCount: 0,
    textBuffer: "",
  };
}
function tool(overrides: Partial<ToolMessage> = {}): ToolMessage {
  return {
    kind: "tool",
    id: "spawn",
    toolName: "Agent",
    args: JSON.stringify({ description: "Read document" }),
    status: "succeeded",
    startedAt: 0,
    ...overrides,
  };
}
function api(overrides: Record<string, unknown> = {}) {
  ensureMiniDom();
  (window as unknown as { codeshell: Record<string, unknown> }).codeshell = {
    listDiskSessions: async () => ({ sessions: [], nextCursor: null }),
    getSessionTranscript: async () => transcript("Read the document"),
    ...overrides,
  };
}
afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
});

describe("subagent full transcript navigation", () => {
  test("background agents retain their status without a transcript navigation entry", async () => {
    const reads: string[] = [];
    const queries: unknown[] = [];
    api({
      listBackgroundWork: async () => ({
        items: [
          {
            kind: "subagent",
            agentId: "child-a",
            description: "Read document",
            status: "failed",
            startedAt: 1,
            sourceSession: { sessionId: "other-parent", shortId: "other", current: false },
          },
        ],
      }),
      getSessionTranscript: async (id: string) => {
        reads.push(id);
        return transcript("Child request");
      },
      listDiskSessions: async (opts: unknown) => {
        queries.push(opts);
        return { sessions: [], nextCursor: null };
      },
    });
    const container = await mount(<BackgroundShellPanel sessionId="viewed-parent" />);
    const row = nodes(container, "LI").find((node) => text(node).includes("Read document"));
    expect(row).toBeDefined();
    expect(text(row)).toContain("失败");
    expect(nodes(row, "BUTTON")).toHaveLength(0);
    expect(nodes(container, "BUTTON").some((node) => text(node) === "完整对话")).toBe(false);
    await filesChanged();
    expect(reads).toEqual([]);
    expect(queries).toEqual([]);
    expect(text(container)).not.toContain("Child request");
  });

  test("Agent tool cards open the child and return through its list to the parent stream", async () => {
    const reads: string[] = [];
    api({
      getSessionTranscript: async (id: string) => {
        reads.push(id);
        return transcript("Child request");
      },
    });
    const container = await mount(
      <MessageStream
        engineSessionId="parent-a"
        messages={[tool({ result: "agent_id: child-a (internal — do not show to user)" })]}
      />,
    );
    for (let i = 0; i < 4; i++) {
      const view = nodes(container, "BUTTON").find((node) => text(node) === "完整对话");
      if (view) {
        await click(view);
        break;
      }
      await click(
        nodes(container, "BUTTON").find((node) => props(node)["aria-expanded"] === false),
      );
    }
    expect(reads).toEqual(["child-a"]);
    expect(text(container)).toContain("Child request");
    await click(
      nodes(container, "BUTTON").find((node) => props(node)["aria-label"] === "返回子代理列表"),
    );
    expect(text(container)).not.toContain("Child request");
    expect(reads).toEqual(["child-a"]);
    expect(
      nodes(container, "SECTION").some((node) => props(node)["data-subagent-list"] !== undefined),
    ).toBe(true);
    await click(
      nodes(container, "BUTTON").find((node) => props(node)["aria-label"] === "返回上级对话"),
    );
    expect(text(container)).not.toContain("Child request");
  });

  test("an Agent tool without a definite child never opens a generic child list", async () => {
    const reads: string[] = [];
    const queries: unknown[] = [];
    api({
      getSessionTranscript: async (id: string) => {
        reads.push(id);
        return transcript("Unexpected child transcript");
      },
      listDiskSessions: async (options: unknown) => {
        queries.push(options);
        return { sessions: [], nextCursor: null };
      },
    });
    const container = await mount(
      <MessageStream
        engineSessionId="parent"
        messages={[tool(), agent("one", "Read document"), agent("two", "Read document")]}
      />,
    );
    const findTool = () =>
      nodes(container, "DIV").find(
        (node) =>
          props(node)["data-message-kind"] === "tool" && props(node)["data-tool-name"] === "Agent",
      );
    for (let attempt = 0; !findTool() && attempt < 4; attempt++) {
      await click(
        nodes(container, "BUTTON").find((node) => props(node)["aria-expanded"] === false),
      );
    }
    const launch = findTool();
    expect(launch).toBeDefined();
    await click(nodes(launch, "BUTTON").find((node) => props(node)["aria-expanded"] === false));
    expect(nodes(launch, "BUTTON").some((node) => text(node) === "完整对话")).toBe(false);
    expect(reads).toEqual([]);
    expect(queries).toEqual([]);
  });

  test("an external subagent opener preserves the parent stream and its subsequent output", async () => {
    const reads: string[] = [];
    const selections: SubagentSelection[] = [];
    api({
      getSessionTranscript: async (id: string) => {
        reads.push(id);
        return transcript("Child request");
      },
    });
    const messages: Message[] = [
      { kind: "user", id: "parent-request", text: "Continue the parent task" },
      tool({ result: "agent_id: child-a (internal — do not show to user)" }),
    ];
    const open = (selection: SubagentSelection) => selections.push(selection);
    const container = await mount(
      <MessageStream engineSessionId="parent-a" messages={messages} onViewSubagent={open} />,
    );
    const stream = nodes(container, "DIV").find(
      (node) => props(node).className === "cs-chat-transcript w-full min-w-0",
    );
    expect(stream).toBeDefined();
    for (let i = 0; i < 4; i++) {
      const view = nodes(container, "BUTTON").find((node) => text(node) === "完整对话");
      if (view) {
        await click(view);
        break;
      }
      await click(
        nodes(container, "BUTTON").find((node) => props(node)["aria-expanded"] === false),
      );
    }
    expect(selections).toEqual([
      {
        agentId: "child-a",
        parentSessionId: "parent-a",
        label: "Read document",
        running: true,
        agents: [],
      },
    ]);
    expect(reads).toEqual([]);
    expect(text(container)).toContain("Continue the parent task");
    expect(nodes(container, "DIV")).toContain(stream);
    await rerender(
      <MessageStream
        engineSessionId="parent-a"
        messages={[
          ...messages,
          { kind: "assistant", id: "parent-output", text: "Parent keeps working", done: false },
        ]}
        onViewSubagent={open}
      />,
    );
    expect(text(container)).toContain("Continue the parent task");
    expect(text(container)).toContain("Parent keeps working");
    expect(nodes(container, "DIV")).toContain(stream);
    expect(reads).toEqual([]);
  });

  test("inactive dock details defer reads and keep their internal list navigation", async () => {
    const reads: string[] = [];
    const queries: string[] = [];
    api({
      listDiskSessions: async ({ parentSessionId }: { parentSessionId: string }) => {
        queries.push(parentSessionId);
        return { sessions: [], nextCursor: null };
      },
      getSessionTranscript: async (id: string) => {
        reads.push(id);
        return transcript(`Child request ${reads.length}`);
      },
    });
    const detail = (active: boolean) => (
      <SubagentSessionDetail agentId="child" parentSessionId="parent" active={active} />
    );
    const container = await mount(detail(false));
    await filesChanged();
    expect(reads).toEqual([]);
    expect(queries).toEqual([]);
    expect(
      nodes(container, "BUTTON").some((node) => props(node)["aria-label"] === "返回子代理列表"),
    ).toBe(true);
    expect(
      props(nodes(container, "BUTTON").find((node) => props(node)["aria-label"] === "刷新对话"))
        .disabled,
    ).toBe(true);
    await rerender(detail(true));
    expect(reads).toEqual(["child"]);
    expect(queries).toEqual(["parent"]);
    expect(text(container)).toContain("Child request 1");
    await rerender(detail(false));
    await filesChanged();
    expect(reads).toHaveLength(1);
    expect(queries).toHaveLength(1);
    await rerender(detail(true));
    expect(reads).toEqual(["child", "child"]);
    expect(queries).toEqual(["parent", "parent"]);
    expect(text(container)).toContain("Child request 2");
  });

  test("hiding invalidates old transcript and catalog responses across reopening", async () => {
    const oldTranscript = deferred<FoldItem[]>();
    const oldCatalog = deferred<Awaited<ReturnType<typeof window.codeshell.listDiskSessions>>>();
    let reads = 0;
    let queries = 0;
    api({
      listDiskSessions: async () => {
        queries += 1;
        return queries === 1
          ? oldCatalog.promise
          : {
              sessions: [
                {
                  id: "child",
                  engineSessionId: "child",
                  title: "Current child title",
                  cwd: "/repo",
                  origin: "subagent",
                  updatedAt: 1,
                },
              ],
              nextCursor: null,
            };
      },
      getSessionTranscript: async () => {
        reads += 1;
        return reads === 1 ? oldTranscript.promise : transcript("Current child transcript");
      },
    });
    const detail = (active: boolean) => (
      <SubagentSessionDetail agentId="child" parentSessionId="parent" active={active} />
    );
    const container = await mount(detail(true));
    await rerender(detail(false));
    await rerender(detail(true));
    expect(text(container)).toContain("Current child title");
    expect(text(container)).toContain("Current child transcript");
    await act(async () => {
      oldTranscript.resolve(transcript("Stale child transcript"));
      oldCatalog.resolve({
        sessions: [
          {
            id: "child",
            engineSessionId: "child",
            title: "Stale child title",
            cwd: "/repo",
            origin: "subagent",
            updatedAt: 1,
          },
        ],
        nextCursor: null,
      });
      await flushMicrotasks();
    });
    expect(text(container)).toContain("Current child title");
    expect(text(container)).toContain("Current child transcript");
    expect(text(container)).not.toContain("Stale child");
  });

  test("an explicit child stays targeted across sibling catalogs and prop switches", async () => {
    const reads: string[] = [];
    api({
      listDiskSessions: async () => ({
        sessions: ["one", "two"].map((id) => ({
          id,
          engineSessionId: id,
          title: `Title ${id}`,
          cwd: "/repo",
          origin: "subagent",
          updatedAt: 1,
        })),
        nextCursor: null,
      }),
      getSessionTranscript: async (id: string) => {
        reads.push(id);
        return transcript(`Transcript ${id}`);
      },
    });
    const container = await mount(<SubagentSessionDetail agentId="one" parentSessionId="parent" />);
    expect(text(container)).toContain("Title one");
    expect(text(container)).toContain("Transcript one");
    expect(nodes(container, "BUTTON").some((node) => props(node).role === "combobox")).toBe(false);
    await rerender(<SubagentSessionDetail agentId="two" parentSessionId="parent" />);
    expect(text(container)).toContain("Title two");
    expect(text(container)).toContain("Transcript two");
    expect(text(container)).not.toContain("Transcript one");
    expect(nodes(container, "BUTTON").some((node) => props(node).role === "combobox")).toBe(false);
    expect(reads).toEqual(["one", "two"]);
  });

  test("hidden dock visibility pauses polling and change events for nested child details", async () => {
    const reads: string[] = [];
    api({
      getSessionTranscript: async (id: string): Promise<FoldItem[]> => {
        reads.push(id);
        return id === "child"
          ? [
              {
                kind: "stream",
                event: { type: "agent_start", agentId: "grandchild", description: "Nested task" },
              },
            ]
          : transcript("Grandchild request");
      },
    });
    const scheduled = new Map<ReturnType<typeof setInterval>, () => void>();
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
      (callback, interval, ...args) => {
        const timer = originalSetInterval(callback, interval, ...args);
        if (interval === 3000 && typeof callback === "function")
          scheduled.set(timer, () => callback(...args));
        return timer;
      },
    );
    const clearSpy = spyOn(globalThis, "clearInterval").mockImplementation((timer) => {
      scheduled.delete(timer as ReturnType<typeof setInterval>);
      originalClearInterval(timer);
    });
    const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const detail = (active: boolean) => (
      <SubagentSessionDetail agentId="child" parentSessionId="parent" running active={active} />
    );
    try {
      const container = await mount(detail(true));
      await click(
        nodes(container, "BUTTON").find(
          (node) => props(node)["aria-controls"] === "agent-body-grandchild",
        ),
      );
      await click(nodes(container, "BUTTON").find((node) => text(node) === "完整对话"));
      expect(text(container)).toContain("Grandchild request");
      expect(scheduled.size).toBe(2);
      await act(async () => {
        for (const tick of [...scheduled.values()]) tick();
        await flushMicrotasks();
      });
      expect(reads).toEqual(["child", "grandchild", "child", "grandchild"]);
      await rerender(detail(false));
      expect(scheduled.size).toBe(0);
      await filesChanged();
      expect(reads).toHaveLength(4);
      await rerender(detail(true));
      expect(scheduled.size).toBe(2);
      expect(text(container)).toContain("Grandchild request");
      expect(reads).toHaveLength(6);
      expect(reads.slice(4).sort()).toEqual(["child", "grandchild"]);
      await rerender(detail(false));
      expect(scheduled.size).toBe(0);
    } finally {
      intervalSpy.mockRestore();
      clearSpy.mockRestore();
      if (visibility) Object.defineProperty(document, "visibilityState", visibility);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });

  test("a missing child target stays empty and asks to open the conversation from chat", async () => {
    const queries: unknown[] = [];
    const reads: string[] = [];
    api({
      listDiskSessions: async (options: unknown) => {
        queries.push(options);
        return {
          sessions: [
            {
              id: "only-child",
              engineSessionId: "only-child",
              title: "Only child",
              cwd: "/repo",
              origin: "subagent",
              updatedAt: 1,
            },
          ],
          nextCursor: null,
        };
      },
      getSessionTranscript: async (id: string) => {
        reads.push(id);
        return transcript("Unexpected auto-selected child");
      },
    });
    const container = await mount(
      <SubagentSessionDetail parentSessionId="parent" onBack={() => undefined} />,
    );
    expect(text(container)).toContain("从聊天消息中打开对应的子代理对话。");
    expect(nodes(container, "BUTTON").some((node) => props(node).role === "combobox")).toBe(false);
    expect(
      props(nodes(container, "BUTTON").find((node) => props(node)["aria-label"] === "刷新对话"))
        .disabled,
    ).toBe(true);
    await filesChanged();
    expect(queries).toEqual([]);
    expect(reads).toEqual([]);
  });

  test("explicit child metadata follows pagination and stale transcript reads are ignored", async () => {
    let resolveA!: (items: FoldItem[]) => void;
    const queries: any[] = [];
    const reads: string[] = [];
    api({
      listDiskSessions: async (opts: any) => {
        queries.push(opts);
        const id = opts.cursor ? "child-b" : "child-a";
        return {
          sessions: [
            { id, engineSessionId: id, title: id, cwd: "/repo", origin: "subagent", updatedAt: 1 },
          ],
          nextCursor: opts.cursor ? null : "page-2",
        };
      },
      getSessionTranscript: (id: string) => {
        reads.push(id);
        return id === "child-a"
          ? new Promise<FoldItem[]>((resolve) => {
              resolveA = resolve;
            })
          : Promise.resolve(transcript("B transcript"));
      },
    });
    const container = await mount(
      <SubagentSessionDetail agentId="child-a" parentSessionId="parent" />,
    );
    expect(queries.map((query) => query.parentSessionId)).toEqual(["parent", "parent"]);
    expect(nodes(container, "BUTTON").some((node) => props(node).role === "combobox")).toBe(false);
    await rerender(<SubagentSessionDetail agentId="child-b" parentSessionId="parent" />);
    expect(reads).toEqual(["child-a", "child-b"]);
    expect(text(container)).toContain("B transcript");
    await act(async () => {
      resolveA(transcript("Stale A transcript"));
      await flushMicrotasks();
    });
    expect(text(container)).not.toContain("Stale A transcript");
  });

  test("nested child details query the child as parent without adding a main session", async () => {
    const parents: string[] = [];
    const reads: string[] = [];
    api({
      listDiskSessions: async (opts: { parentSessionId: string }) => {
        parents.push(opts.parentSessionId);
        return { sessions: [], nextCursor: null };
      },
      getSessionTranscript: async (id: string): Promise<FoldItem[]> => {
        reads.push(id);
        return id === "child"
          ? [
              {
                kind: "stream",
                event: { type: "agent_start", agentId: "grandchild", description: "Nested task" },
              },
              {
                kind: "stream",
                event: { type: "agent_end", agentId: "grandchild", description: "Nested task" },
              },
            ]
          : transcript("Grandchild request");
      },
    });
    const container = await mount(
      <SubagentSessionDetail agentId="child" parentSessionId="parent" onBack={() => undefined} />,
    );
    await click(
      nodes(container, "BUTTON").find(
        (node) => props(node)["aria-controls"] === "agent-body-grandchild",
      ),
    );
    await click(nodes(container, "BUTTON").find((node) => text(node) === "完整对话"));
    expect(reads).toEqual(["child", "grandchild"]);
    expect(parents).toEqual(["parent", "child"]);
    expect(text(container)).toContain("Grandchild request");
  });

  test("refresh recovers child metadata and retains a transcript read error", async () => {
    let listed = false;
    let failTranscript = true;
    api({
      listDiskSessions: async () => {
        const rows = listed
          ? [
              {
                id: "child",
                engineSessionId: "child",
                title: "Child",
                cwd: "/repo",
                updatedAt: 1,
                origin: "subagent",
                status: "failed",
              },
            ]
          : [];
        listed = true;
        return { sessions: rows, nextCursor: null };
      },
      getSessionTranscript: async () => {
        if (failTranscript) throw new Error("Disk unavailable");
        return transcript("Recovered transcript");
      },
    });
    const container = await mount(
      <SubagentSessionDetail agentId="child" parentSessionId="parent" onBack={() => undefined} />,
    );
    await click(
      nodes(container, "BUTTON").find((node) => props(node)["aria-label"] === "刷新对话"),
    );
    expect(text(container)).toContain("Disk unavailable");
    failTranscript = false;
    await click(
      nodes(container, "BUTTON").find((node) => props(node)["aria-label"] === "刷新对话"),
    );
    expect(text(container)).toContain("Recovered transcript");
    expect(text(container)).not.toContain("Disk unavailable");
  });

  test("background refreshes of an unchanged child transcript do not re-render", async () => {
    let items = transcript("Polled child request");
    let reads = 0;
    let catalogReads = 0;
    api({
      listDiskSessions: async () => {
        catalogReads += 1;
        return { sessions: [], nextCursor: null };
      },
      getSessionTranscript: async () => {
        reads += 1;
        return items;
      },
    });
    let commits = 0;
    const container = await mount(
      <React.Profiler id="detail" onRender={() => (commits += 1)}>
        <SubagentSessionDetail agentId="child" parentSessionId="parent" />
      </React.Profiler>,
    );
    expect(text(container)).toContain("Polled child request");
    const readsBefore = reads;
    const catalogsBefore = catalogReads;
    commits = 0;
    await filesChanged();
    await filesChanged();
    expect(reads).toBe(readsBefore + 2);
    expect(catalogReads).toBe(catalogsBefore + 2);
    expect(commits).toBe(0);

    // A grown transcript renders the appended message.
    items = [...items, { kind: "user", text: "Follow-up request" }];
    await filesChanged();
    expect(commits).toBeGreaterThan(0);
    expect(text(container)).toContain("Polled child request");
    expect(text(container)).toContain("Follow-up request");
  });

  test("incremental folds reuse the previous fold and its unchanged messages", () => {
    const items = transcript("First request");
    const first = foldTranscriptIncremental(null, items);
    // Fold ids embed a clock, so compare everything else.
    const withoutIds = (messages: Message[]) => messages.map(({ id: _id, ...rest }) => rest);
    expect(withoutIds(first.value.messages)).toEqual(withoutIds(foldTranscript(items).messages));
    // Unchanged input: the very same fold, so callers can skip their update.
    expect(foldTranscriptIncremental(first, [...items])).toBe(first);

    const grown: FoldItem[] = [...items, { kind: "user", text: "Second request" }];
    const second = foldTranscriptIncremental(first, grown);
    expect(second.count).toBe(grown.length);
    expect(withoutIds(second.value.messages)).toEqual(withoutIds(foldTranscript(grown).messages));
    expect(second.value.messages.at(-1)).toMatchObject({ kind: "user", text: "Second request" });
    // Earlier messages keep their object identity (and ids) across the poll.
    first.value.messages.forEach((message, index) => {
      expect(second.value.messages[index]).toBe(message);
    });

    // A rewritten prefix is folded from scratch.
    const rewritten: FoldItem[] = [{ kind: "user", text: "Other request" }, ...grown.slice(1)];
    const third = foldTranscriptIncremental(second, rewritten);
    expect(third.value.messages[0]).not.toBe(second.value.messages[0]);
    expect(third.value.messages[0]).toMatchObject({ kind: "user", text: "Other request" });
  });

  test("CC subagent pills are keyboard-accessible buttons carrying the selected agent", async () => {
    const selected: string[] = [];
    const item = {
      kind: "subagent" as const,
      id: "row",
      agentId: "child",
      label: "Read document",
      status: "completed",
    };
    const container = await mount(
      <MessageRow
        item={item}
        onViewSubagent={(agent) =>
          selected.push(agent.kind === "subagent" ? agent.agentId : agent.id)
        }
      />,
    );
    await click(nodes(container, "BUTTON")[0]);
    expect(selected).toEqual(["child"]);
  });

  test("foreground association never guesses between repeated task descriptions", () => {
    expect(subagentIdForTool(tool(), [agent("one", "Read document")])).toBe("one");
    expect(
      subagentIdForTool(tool(), [agent("one", "Read document"), agent("two", "Read document")]),
    ).toBeUndefined();
    expect(subagentIdForTool(tool({ args: JSON.stringify({ agent_id: "exact-child" }) }))).toBe(
      "exact-child",
    );
  });
});

test("a status-only update preserves the open grandchild transcript", async () => {
  api({
    getSessionTranscript: async (id: string): Promise<FoldItem[]> =>
      id === "child"
        ? [
            {
              kind: "stream",
              event: { type: "agent_start", agentId: "grandchild", description: "Nested task" },
            },
            {
              kind: "stream",
              event: { type: "agent_end", agentId: "grandchild", description: "Nested task" },
            },
          ]
        : transcript("Grandchild request"),
  });
  const container = await mount(
    <SubagentSessionDetail
      agentId="child"
      parentSessionId="parent"
      running
      onBack={() => undefined}
    />,
  );
  await click(
    nodes(container, "BUTTON").find(
      (node) => props(node)["aria-controls"] === "agent-body-grandchild",
    ),
  );
  await click(nodes(container, "BUTTON").find((node) => text(node) === "完整对话"));
  expect(text(container)).toContain("Grandchild request");
  await act(async () => {
    root!.render(
      <SubagentSessionDetail
        agentId="child"
        parentSessionId="parent"
        running={false}
        onBack={() => undefined}
      />,
    );
    await flushMicrotasks();
  });
  expect(text(container)).toContain("Grandchild request");
});
