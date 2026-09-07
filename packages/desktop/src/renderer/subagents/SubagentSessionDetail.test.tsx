import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FoldItem } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { MessageStream } from "../MessageStream";
import { BackgroundShellPanel } from "../panels/BackgroundShellPanel";
import { MessageRow } from "../cc-room/CCConversationView";
import { SubagentSessionDetail } from "./SubagentSessionDetail";
import { subagentIdForTool } from "./SubagentNavigation";
import type { AgentMessage, ToolMessage } from "../types";

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
  test("a background agent reads its own transcript and uses its actual source parent", async () => {
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
    await click(
      nodes(container, "BUTTON").find((node) =>
        props(node)["aria-label"]?.includes("Read document"),
      ),
    );
    expect(reads).toEqual(["child-a"]);
    expect(queries).toEqual([{ parentSessionId: "other-parent", limit: 100, cursor: undefined }]);
    expect(text(container)).toContain("Child request");
    // Expand the persisted normal tool card, so the exact denial remains reviewable.
    for (let i = 0; i < 4; i++) {
      const button = nodes(container, "BUTTON").find(
        (node) => props(node)["aria-expanded"] === false,
      );
      if (!button) break;
      await click(button);
    }
    expect(text(container)).toContain("Permission denied");
    await click(
      nodes(container, "BUTTON").find((node) => props(node)["aria-label"]?.includes("返回")),
    );
    expect(text(container)).toContain("Read document");
  });

  test("Agent tool cards open the child and returning restores the parent stream", async () => {
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
      nodes(container, "BUTTON").find((node) => props(node)["aria-label"] === "返回上级对话"),
    );
    expect(text(container)).not.toContain("Child request");
  });

  test("child picker scopes by parent, follows pagination, and ignores stale transcript reads", async () => {
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
      <SubagentSessionDetail parentSessionId="parent" onBack={() => undefined} />,
    );
    expect(queries.map((query) => query.parentSessionId)).toEqual(["parent", "parent"]);
    const select = nodes(container, "SELECT")[0];
    await act(async () => {
      props(select).onChange({ target: { value: "child-a" } });
      await flushMicrotasks();
    });
    await act(async () => {
      props(select).onChange({ target: { value: "child-b" } });
      await flushMicrotasks();
    });
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
      <SubagentSessionDetail parentSessionId="parent" onBack={() => undefined} />,
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
