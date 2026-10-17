import { expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import {
  INITIAL_STATE,
  applyStreamEvent,
  type FilesChangedSummaryMessage,
  type Message,
  type MessagesReducerState,
  type ToolMessage,
} from "../types";
import { aggregateFileChangeSummary } from "./fileChangeAggregator";
import { FilesChangedCard } from "./FilesChangedCard";
import { UnifiedDiffViewer } from "../diff/UnifiedDiffViewer";
import { parseUnifiedDiff } from "../diff/parseUnifiedDiff";
import { groupReviewSnapshot } from "../diff/reviewSnapshot";
import { syntheticSnippetDiff } from "../diff/composeFileEdits";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

const user: Message = { kind: "user", id: "owner", text: "edit", clientMessageId: "client" };
function edit(path: string): ToolMessage {
  return {
    kind: "tool",
    id: `edit:${path}`,
    toolName: "Edit",
    args: JSON.stringify({ file_path: path, old_string: "before", new_string: "after" }),
    status: "succeeded",
    startedAt: 0,
  };
}
function complete(state: MessagesReducerState, cwd: string, files = ["src/a.ts"]) {
  return applyStreamEvent(state, {
    type: "background_agent_completed",
    agentId: `external:${cwd}`,
    description: "DriveAgent(codex): edit",
    status: "completed",
    workKind: "cc",
    finalText: "done",
    cwd,
    changedFiles: files,
    originClientMessageId: "client",
    enqueuedAt: 1,
  } as StreamEvent);
}
function card(state: MessagesReducerState): FilesChangedSummaryMessage {
  const cards = state.messages.filter((message) => message.kind === "files_changed");
  expect(cards).toHaveLength(1);
  return cards[0] as FilesChangedSummaryMessage;
}
function external(cwd: string): Message {
  return {
    kind: "system",
    id: `marker:${cwd}`,
    text: "done",
    externalFileChanges: { sourceId: cwd, cwd, files: ["src/a.ts"] },
  };
}

test("real completion reducer preserves two external roots with the same relative file", () => {
  let state: MessagesReducerState = { ...INITIAL_STATE, messages: [user] };
  state = complete(state, "/owned/worktree-one");
  state = complete(state, "/owned/worktree-two");
  expect(card(state).files).toEqual([
    { path: "/owned/worktree-one/src/a.ts", added: 0, removed: 0, count: 1 },
    { path: "/owned/worktree-two/src/a.ts", added: 0, removed: 0, count: 1 },
  ]);
  expect(card(state).sessionDiffs).toEqual([]);
});

test("real completion does not attribute the parent relative tool to an external cwd", () => {
  const state = complete({ ...INITIAL_STATE, messages: [user, edit("src/a.ts")] }, "/owned/child");
  const summary = card(state);
  expect(summary.files).toEqual([
    { path: "src/a.ts", added: 1, removed: 1, count: 1 },
    { path: "/owned/child/src/a.ts", added: 0, removed: 0, count: 1 },
  ]);
  expect(summary.sessionDiffs?.map((diff) => diff.path)).toEqual(["src/a.ts"]);
});

for (const markerFirst of [false, true]) {
  test(`explicit absolute tools dedupe the same external file (markerFirst=${markerFirst})`, () => {
    const tool = edit("/owned/child/src/a.ts");
    const marker = external("/owned/child");
    const summary = aggregateFileChangeSummary([
      user,
      ...(markerFirst ? [marker, tool] : [tool, marker]),
    ]);
    expect(summary?.files).toEqual([
      { path: "/owned/child/src/a.ts", added: 1, removed: 1, count: 2 },
    ]);
    expect(summary?.sessionDiffs).toHaveLength(1);
    expect(parseUnifiedDiff(summary!.sessionDiffs[0]!.diff)[0]?.newPath).toBe(
      "/owned/child/src/a.ts",
    );
    let state: MessagesReducerState = { ...INITIAL_STATE, messages: [user] };
    if (markerFirst) state = complete(state, "/owned/child");
    state = { ...state, messages: [...state.messages, tool] };
    if (!markerFirst) state = complete(state, "/owned/child");
    state = applyStreamEvent(state, {
      type: "turn_complete",
      reason: "completed",
    } as StreamEvent);
    expect(card(state).files).toEqual(summary!.files);
  });
}

for (const [cwd, expected] of [
  ["C:\\owned\\child", "C:/owned/child/ 文件名 .ts "],
  ["\\\\server\\share\\child", "//server/share/child/ 文件名 .ts "],
  ["/owned/child", "/owned/child/ 文件名 .ts "],
]) {
  test(`completion retains native absolute root and filename spaces: ${cwd}`, () => {
    const state = complete({ ...INITIAL_STATE, messages: [user] }, cwd!, [" 文件名 .ts "]);
    expect(card(state).files.map((file) => file.path)).toEqual([expected]);
  });
}

test("two absolute tool snapshots retain separate same-relative Review sections", () => {
  const summary = aggregateFileChangeSummary([
    user,
    edit("/owned/one/src/a.ts"),
    edit("/owned/two/src/a.ts"),
    external("/owned/one"),
    external("/owned/two"),
  ]);
  expect(summary?.files.map((file) => file.path)).toEqual([
    "/owned/one/src/a.ts",
    "/owned/two/src/a.ts",
  ]);
  const grouped = groupReviewSnapshot(summary!.sessionDiffs.map((diff) => diff.diff).join("\n"));
  expect(parseUnifiedDiff(grouped).map((file) => file.newPath)).toEqual([
    "/owned/one/src/a.ts",
    "/owned/two/src/a.ts",
  ]);
});

test("external absolute identity preserves the conservative previews of different writers", () => {
  const path = "/owned/child/src/a.ts";
  const agent = (id: string, old_string: string, new_string: string): Message => ({
    kind: "agent",
    id,
    description: "edit the shared file",
    done: true,
    startedAt: 0,
    textBuffer: "",
    toolCount: 1,
    toolCalls: [
      { ...edit(path), args: JSON.stringify({ file_path: path, old_string, new_string }) },
    ],
  });
  const summary = aggregateFileChangeSummary([
    user,
    agent("first", "before", "middle"),
    agent("second", "middle", "after"),
    external("/owned/child"),
  ])!;
  expect(summary.files).toEqual([{ path, added: 2, removed: 2, count: 3 }]);
  const parsed = parseUnifiedDiff(summary.sessionDiffs[0]!.diff);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]?.hunks).toHaveLength(2);
  expect(parsed[0]?.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text))).toEqual([
    "before",
    "middle",
    "middle",
    "after",
  ]);
});

function descendants(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(descendants)];
}
function propsOf(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
async function click(node: any, modifier?: "meta" | "ctrl") {
  expect(typeof propsOf(node).onClick).toBe("function");
  await act(async () => {
    propsOf(node).onClick({
      stopPropagation() {},
      preventDefault() {},
      metaKey: modifier === "meta",
      ctrlKey: modifier === "ctrl",
    });
    await flushMicrotasks();
  });
}

async function withRendered(
  element: React.ReactNode,
  run: (container: HTMLElement, internal: unknown[], external: unknown[]) => Promise<void>,
) {
  ensureMiniDom();
  const previous = window.codeshell;
  const internal: unknown[] = [];
  const external: unknown[] = [];
  window.codeshell = {
    openPath: async (path: string, cwd?: string) => {
      external.push({ path, cwd });
      return "recorded-only";
    },
    getReviewDiff: () => {
      throw new Error("Snapshot Review must not query Git");
    },
  } as unknown as typeof window.codeshell;
  const onOpen = (event: Event) => internal.push((event as CustomEvent).detail);
  window.addEventListener("codeshell:open-file", onOpen);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(element);
      await flushMicrotasks();
    });
    await run(container, internal, external);
  } finally {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    document.body.removeChild(container);
    window.removeEventListener("codeshell:open-file", onOpen);
    window.codeshell = previous;
  }
}

test("actual Card row clicks retain both external targets and the relative parent target", async () => {
  let state: MessagesReducerState = { ...INITIAL_STATE, messages: [user, edit("src/a.ts")] };
  state = complete(state, "/owned/one");
  state = complete(state, "/owned/two");
  await withRendered(
    <FilesChangedCard message={card(state)} cwd="/owned/parent" sessionId={null} isLatest />,
    async (container, internal, external) => {
      await click(descendants(container).find((node) => propsOf(node)["aria-expanded"] === false));
      const links = descendants(container).filter((node) => node.tagName === "A");
      const expected = ["src/a.ts", "/owned/one/src/a.ts", "/owned/two/src/a.ts"];
      for (const link of links) {
        await click(link);
        await click(link, "meta");
        await click(link, "ctrl");
      }
      console.log(JSON.stringify({ scenario: "actual-card-file-targets", internal, external }));
      expect(links.map((node) => propsOf(node).title)).toEqual(expected);
      expect(internal).toEqual(expected.map((path) => ({ path, cwd: "/owned/parent" })));
      expect(external).toEqual(
        expected.flatMap((path) => Array(2).fill({ path, cwd: "/owned/parent" })),
      );
    },
  );
});

test("actual Review opens two same-relative external snapshots under their own roots", async () => {
  const summary = aggregateFileChangeSummary([
    user,
    edit("/owned/one/src/a.ts"),
    edit("/owned/two/src/a.ts"),
    external("/owned/one"),
    external("/owned/two"),
  ])!;
  await withRendered(
    <UnifiedDiffViewer
      cwd="/owned/parent"
      diffText={summary.sessionDiffs.map((file) => file.diff).join("\n")}
    />,
    async (container, internal, external) => {
      const nodes = descendants(container);
      expect(
        nodes
          .filter((node) => propsOf(node).className === "truncate font-mono text-xs")
          .map((node) => propsOf(node).title),
      ).toEqual(["/owned/one/src/a.ts", "/owned/two/src/a.ts"]);
      for (const button of nodes.filter((node) => propsOf(node).role === "button"))
        await click(button);
      expect(internal).toEqual([
        { path: "/owned/one/src/a.ts", cwd: "/owned/parent" },
        { path: "/owned/two/src/a.ts", cwd: "/owned/parent" },
      ]);
      expect(external).toEqual([]);
    },
  );
});

for (const path of [
  "/owned/child/src/a.ts",
  "C:/owned/child/src/a.ts",
  "//server/share/child/src/a.ts",
  "C:\\owned\\child\\src\\a.ts",
  "\\\\server\\share\\child\\src\\a.ts",
  "src/legacy.ts",
]) {
  test(`actual Review snapshot click preserves target ${path}`, async () => {
    await withRendered(
      <UnifiedDiffViewer
        cwd="/owned/parent"
        diffText={syntheticSnippetDiff(path, "before", "after")}
      />,
      async (container, internal, external) => {
        const nodes = descendants(container);
        const title = nodes.find(
          (node) => propsOf(node).className === "truncate font-mono text-xs",
        );
        expect(propsOf(title).title).toBe(path);
        const open = nodes.find((node) => propsOf(node).role === "button");
        await click(open);
        await click(open, "ctrl");
        const target = path === "src/legacy.ts" ? "/owned/parent/src/legacy.ts" : path;
        expect(internal).toEqual([{ path: target, cwd: "/owned/parent" }]);
        expect(external).toEqual([{ path: target, cwd: "/owned/parent" }]);
      },
    );
  });
}
