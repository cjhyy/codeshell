import { afterEach, describe, expect, spyOn, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FoldItem } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { SubagentSessionDetail } from "./SubagentSessionDetail";

let root: Root | null = null;
function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function nodes(node: any): any[] {
  return [node, ...(node.childNodes ?? []).flatMap(nodes)];
}
function marked(node: any, key: string, value?: string): any[] {
  return nodes(node).filter((item) =>
    value === undefined ? props(item)[key] !== undefined : props(item)[key] === value,
  );
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
function transcript(id: string): FoldItem[] {
  return [{ kind: "user", text: `Transcript ${id}` }];
}
function row(id: string, status = "completed", parent = "parent") {
  return {
    id,
    engineSessionId: id,
    parentSessionId: parent,
    title: `Title ${id}`,
    cwd: "/fixture",
    origin: "subagent",
    status,
    updatedAt: 1,
  };
}
function api(overrides: Record<string, unknown> = {}) {
  ensureMiniDom();
  (window as unknown as { codeshell: Record<string, unknown> }).codeshell = {
    listDiskSessions: async () => ({ sessions: [], nextCursor: null }),
    getSessionTranscript: async (id: string) => transcript(id),
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

describe("subagent detail and sibling list navigation", () => {
  test("opens the exact transcript directly, returns to scoped groups, and selects a sibling", async () => {
    const reads: string[] = [];
    const queries: { parentSessionId: string; cursor?: string }[] = [];
    let backs = 0;
    api({
      listDiskSessions: async (options: { parentSessionId: string; cursor?: string }) => {
        queries.push(options);
        return options.cursor
          ? { sessions: [row("paused", "paused"), row("cancelled", "cancelled")], nextCursor: null }
          : {
              sessions: [
                row("active", "active"),
                row("completed"),
                row("failed", "failed"),
                row("foreign", "active", "another-parent"),
              ],
              nextCursor: "page-two",
            };
      },
      getSessionTranscript: async (id: string) => {
        reads.push(id);
        return transcript(id);
      },
    });
    const container = await mount(
      <SubagentSessionDetail agentId="completed" parentSessionId="parent" onBack={() => backs++} />,
    );
    expect(text(container)).toContain("Transcript completed");
    expect(marked(container, "data-subagent-list")).toHaveLength(0);
    expect(reads).toEqual(["completed"]);
    await click(marked(container, "data-subagent-action", "back-to-list")[0]);
    expect(marked(container, "data-subagent-list")).toHaveLength(1);
    expect(
      marked(container, "data-subagent-list-status").map(
        (item) => props(item)["data-subagent-list-status"],
      ),
    ).toEqual(["active", "completed", "failed", "paused", "cancelled"]);
    expect(
      marked(container, "data-subagent-list-id")
        .map((item) => props(item)["data-subagent-list-id"])
        .sort(),
    ).toEqual(["active", "cancelled", "completed", "failed", "paused"]);
    expect(reads).toEqual(["completed"]);
    expect(queries.every((query) => query.parentSessionId === "parent")).toBe(true);
    expect(queries.some((query) => query.cursor === "page-two")).toBe(true);
    expect(backs).toBe(0);
    await click(marked(container, "data-subagent-list-id", "failed")[0]);
    expect(text(container)).toContain("Transcript failed");
    expect(marked(container, "data-subagent-list")).toHaveLength(0);
    expect(reads).toEqual(["completed", "failed"]);
    await click(marked(container, "data-subagent-action", "back-to-list")[0]);
    await click(marked(container, "data-subagent-action", "back-to-parent")[0]);
    expect(backs).toBe(1);
  });

  test("a targetless persisted view stays a chat hint without querying any child", async () => {
    const calls: string[] = [];
    api({
      listDiskSessions: async () => {
        calls.push("catalog");
        return { sessions: [row("unexpected")], nextCursor: null };
      },
      getSessionTranscript: async (id: string) => {
        calls.push(id);
        return transcript(id);
      },
    });
    const container = await mount(<SubagentSessionDetail parentSessionId="parent" />);
    expect(text(container)).toContain("从聊天消息中打开对应的子代理对话。");
    expect(marked(container, "data-subagent-list")).toHaveLength(0);
    expect(marked(container, "data-subagent-action", "back-to-list")).toHaveLength(0);
    await filesChanged();
    expect(calls).toEqual([]);
  });

  test("uses lean parent summaries until the catalog supplies authoritative status", async () => {
    const catalog = deferred<any>();
    api({ listDiskSessions: () => catalog.promise });
    const container = await mount(
      <SubagentSessionDetail
        agentId="seed"
        parentSessionId="parent"
        agents={[
          { id: "seed", description: "Seed title", done: false, startedAt: 1 },
          { id: "failed-seed", description: "Failed seed", done: true, error: "Failure" },
        ]}
      />,
    );
    await click(marked(container, "data-subagent-action", "back-to-list")[0]);
    expect(marked(container, "data-subagent-list-id", "seed")).toHaveLength(1);
    expect(marked(container, "data-subagent-list-id", "failed-seed")).toHaveLength(1);
    expect(marked(container, "data-subagent-list-status", "active")).toHaveLength(1);
    await act(async () => {
      catalog.resolve({ sessions: [row("seed", "completed")], nextCursor: null });
      await flushMicrotasks();
    });
    const completed = marked(container, "data-subagent-list-status", "completed")[0];
    expect(marked(completed, "data-subagent-list-id", "seed")).toHaveLength(1);
    expect(marked(container, "data-subagent-list-status", "active")).toHaveLength(0);
  });

  test("late transcript and catalog results cannot replace a new parent or target", async () => {
    const oldCatalog = deferred<any>();
    const oldTranscript = deferred<FoldItem[]>();
    api({
      listDiskSessions: ({ parentSessionId }: { parentSessionId: string }) =>
        parentSessionId === "old-parent"
          ? oldCatalog.promise
          : Promise.resolve({
              sessions: [row("new", "completed", "new-parent")],
              nextCursor: null,
            }),
      getSessionTranscript: (id: string) =>
        id === "old" ? oldTranscript.promise : Promise.resolve(transcript(id)),
    });
    const container = await mount(
      <SubagentSessionDetail agentId="old" parentSessionId="old-parent" />,
    );
    await rerender(<SubagentSessionDetail agentId="new" parentSessionId="new-parent" />);
    expect(text(container)).toContain("Transcript new");
    await act(async () => {
      oldTranscript.resolve(transcript("STALE"));
      oldCatalog.resolve({ sessions: [row("old", "active", "old-parent")], nextCursor: null });
      await flushMicrotasks();
    });
    expect(text(container)).not.toContain("STALE");
    await click(marked(container, "data-subagent-action", "back-to-list")[0]);
    expect(
      marked(container, "data-subagent-list-id").map(
        (item) => props(item)["data-subagent-list-id"],
      ),
    ).toEqual(["new"]);
  });

  test("a same-ID selection in another parent starts a fresh read and ignores the old response", async () => {
    const oldRead = deferred<FoldItem[]>();
    const reads: string[] = [];
    const parents: string[] = [];
    api({
      listDiskSessions: async ({ parentSessionId }: { parentSessionId: string }) => {
        parents.push(parentSessionId);
        return { sessions: [row("shared-child", "completed", parentSessionId)], nextCursor: null };
      },
      getSessionTranscript: async (id: string) => {
        reads.push(id);
        return reads.length === 1 ? oldRead.promise : transcript("Current parent content");
      },
    });
    const container = await mount(
      <SubagentSessionDetail agentId="shared-child" parentSessionId="old-parent" />,
    );
    await rerender(<SubagentSessionDetail agentId="shared-child" parentSessionId="new-parent" />);
    expect(reads).toEqual(["shared-child", "shared-child"]);
    expect(parents).toEqual(["old-parent", "new-parent"]);
    expect(text(container)).toContain("Current parent content");
    await act(async () => {
      oldRead.resolve(transcript("STALE previous parent content"));
      await flushMicrotasks();
    });
    expect(text(container)).toContain("Current parent content");
    expect(text(container)).not.toContain("STALE");
    expect(marked(container, "data-subagent-list")).toHaveLength(0);
  });

  test("a new chat navigation nonce opens the same child directly from its sibling list", async () => {
    const reads: string[] = [];
    api({
      listDiskSessions: async () => ({ sessions: [row("child")], nextCursor: null }),
      getSessionTranscript: async (id: string) => {
        reads.push(id);
        return transcript(id);
      },
    });
    const detail = (nonce: number) => (
      <SubagentSessionDetail agentId="child" parentSessionId="parent" navigationNonce={nonce} />
    );
    const container = await mount(detail(1));
    await click(marked(container, "data-subagent-action", "back-to-list")[0]);
    expect(marked(container, "data-subagent-list")).toHaveLength(1);
    expect(reads).toEqual(["child"]);
    await rerender(detail(2));
    expect(text(container)).toContain("Transcript child");
    expect(marked(container, "data-subagent-list")).toHaveLength(0);
    expect(reads).toEqual(["child", "child"]);
    expect(marked(container, "data-subagent-action", "back-to-list")).toHaveLength(1);
  });

  test("list polling only refreshes metadata and a hidden view pauses all reads", async () => {
    const reads: string[] = [];
    const queries: string[] = [];
    api({
      listDiskSessions: async ({ parentSessionId }: { parentSessionId: string }) => {
        queries.push(parentSessionId);
        return { sessions: [row("child", "active")], nextCursor: null };
      },
      getSessionTranscript: async (id: string) => {
        reads.push(id);
        return transcript(id);
      },
    });
    const timers = new Map<ReturnType<typeof setInterval>, () => void>();
    const originalSet = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
      (callback, delay, ...args) => {
        const timer = originalSet(callback, delay, ...args);
        if (delay === 3000 && typeof callback === "function")
          timers.set(timer, () => callback(...args));
        return timer;
      },
    );
    const clearSpy = spyOn(globalThis, "clearInterval").mockImplementation((timer) => {
      timers.delete(timer as ReturnType<typeof setInterval>);
      originalClear(timer);
    });
    const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const detail = (active: boolean) => (
      <SubagentSessionDetail agentId="child" parentSessionId="parent" running active={active} />
    );
    try {
      const container = await mount(detail(true));
      await click(marked(container, "data-subagent-action", "back-to-list")[0]);
      const beforeListReads = reads.length;
      const beforeListQueries = queries.length;
      await filesChanged();
      await act(async () => {
        for (const tick of [...timers.values()]) tick();
        await flushMicrotasks();
      });
      expect(reads).toHaveLength(beforeListReads);
      expect(queries.length).toBeGreaterThan(beforeListQueries);
      await rerender(detail(false));
      expect(timers.size).toBe(0);
      const beforeHidden = queries.length;
      await filesChanged();
      expect(queries).toHaveLength(beforeHidden);
      expect(reads).toHaveLength(beforeListReads);
      await rerender(detail(true));
      expect(marked(container, "data-subagent-list")).toHaveLength(1);
      expect(queries.length).toBeGreaterThan(beforeHidden);
      expect(reads).toHaveLength(beforeListReads);
    } finally {
      intervalSpy.mockRestore();
      clearSpy.mockRestore();
      if (visibility) Object.defineProperty(document, "visibilityState", visibility);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });

  test("a nested detail first returns to its siblings, then its list header returns to the parent conversation", async () => {
    const reads: string[] = [];
    const parents: string[] = [];
    let externalBacks = 0;
    api({
      listDiskSessions: async ({ parentSessionId }: { parentSessionId: string }) => {
        parents.push(parentSessionId);
        return {
          sessions: [
            row(parentSessionId === "child" ? "grandchild" : "child", "completed", parentSessionId),
          ],
          nextCursor: null,
        };
      },
      getSessionTranscript: async (id: string): Promise<FoldItem[]> => {
        reads.push(id);
        return id === "child"
          ? [
              ...transcript(id),
              {
                kind: "stream",
                event: { type: "agent_start", agentId: "grandchild", description: "Nested task" },
              },
              {
                kind: "stream",
                event: { type: "agent_end", agentId: "grandchild", description: "Nested task" },
              },
            ]
          : transcript(id);
      },
    });
    const container = await mount(
      <SubagentSessionDetail
        agentId="child"
        parentSessionId="parent"
        onBack={() => externalBacks++}
      />,
    );
    const action = nodes(container).find((item) =>
      props(item).className?.includes?.("cs-agent-transcript"),
    );
    await click(action);
    expect(text(container)).toContain("Transcript grandchild");
    expect(parents).toContain("child");
    await click(marked(container, "data-subagent-action", "back-to-list").at(-1));
    expect(marked(container, "data-subagent-list-id", "grandchild")).toHaveLength(1);
    expect(externalBacks).toBe(0);
    expect(reads).toEqual(["child", "grandchild"]);
    await click(marked(container, "data-subagent-action", "back-to-parent").at(-1));
    expect(text(container)).toContain("Transcript child");
    expect(text(container)).not.toContain("Transcript grandchild");
    expect(marked(container, "data-subagent-list")).toHaveLength(0);
    expect(externalBacks).toBe(0);
  });
});
