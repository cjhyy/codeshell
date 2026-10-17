// Owned real legacy reader/fold + production React controls; fork stops at the bridge.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import type { RawTranscriptEvent } from "../preload/types";

let deniedFetches = 0;
const deny = () => {
  deniedFetches++;
  throw new Error("Context fixture denies network");
};
globalThis.fetch = deny as unknown as typeof fetch;
for (const transport of [http, https]) {
  transport.request = deny as any;
  transport.get = deny as any;
}
syncBuiltinESMExports();
ensureMiniDom();
const { getSessionTranscriptPage, DEFAULT_TRANSCRIPT_PAGE_BYTES } =
  await import("../main/transcript-reader");
const { getSessionEvents } = await import("../main/rawTranscript");
const { foldTranscript } = await import("./automation/foldTranscript");
const { mergeHistoryWindows } = await import("./app/mergeHistoryWindows");
const { MessageStream } = await import("./MessageStream");
const scenario = process.argv[2];
assert.ok(
  [
    "tail",
    "normal",
    "steer",
    "duplicate-text",
    "history-expand",
    "modern-client",
    "unmapped",
    "ambiguous-client",
  ].includes(scenario),
);
const directory = await mkdtemp(join(tmpdir(), "codeshell-context-tail-owned-"));
const session = "owned-context-tail";
const event = (
  id: string,
  type: string,
  turnNumber: number,
  data: Record<string, unknown> = {},
): RawTranscriptEvent => ({ id, type, turnNumber, timestamp: 1000 + turnNumber, data });
const tail = ["tail", "duplicate-text", "history-expand"].includes(scenario);
const recentText =
  scenario === "duplicate-text" ? "Identical owned request" : "RECENT visible owned task";
const clients = scenario === "modern-client" || scenario === "ambiguous-client";
const raw = [
  event("old-user", "message", 0, {
    role: "user",
    content: scenario === "duplicate-text" ? recentText : "OLD unrelated owned task",
    ...(clients
      ? { clientMessageId: scenario === "ambiguous-client" ? "reused-client" : "old-client" }
      : {}),
  }),
  event("old-answer", "message", 0, {
    role: "assistant",
    content: tail ? "x".repeat(DEFAULT_TRANSCRIPT_PAGE_BYTES + 1000) : "Old owned answer",
  }),
  event("old-boundary", "turn_boundary", 1),
  event("recent-user", "message", 1, {
    role: "user",
    content: recentText,
    ...(clients
      ? { clientMessageId: scenario === "ambiguous-client" ? "reused-client" : "recent-client" }
      : {}),
  }),
  event("recent-answer", "message", 1, { role: "assistant", content: "Recent owned answer" }),
  event("recent-boundary", "turn_boundary", 2),
];
if (scenario === "steer")
  raw.push(
    event("steer-user", "message", 2, {
      role: "user",
      content: "Owned step-in guidance",
      steerId: "owned-steer",
    }),
    event("steer-answer", "message", 2, {
      role: "assistant",
      content: "Owned continuation answer",
    }),
    event("steer-boundary", "turn_boundary", 3),
  );
const payloads: unknown[] = [];
let read: Promise<unknown> | undefined;
Object.assign(window, {
  codeshell: {
    getSessionRawEvents: (id: string) => {
      assert.equal(id, session);
      return (read = getSessionEvents(id, undefined, directory));
    },
    forkSession: (payload: unknown) => {
      payloads.push(payload);
      return Promise.reject(new Error("Owned context payload captured before Core dispatch"));
    },
  },
});
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const nodes = (node: any): any[] => [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
const props = (node: any): Record<string, any> => {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
};
const text = (node: any): string =>
  node.nodeType === 3
    ? (node.data ?? "")
    : Array.from(node.childNodes ?? [])
        .map(text)
        .join("") ||
      node.textContent ||
      "";
const buttons = () =>
  nodes(container).filter(
    (node) => node.tagName === "BUTTON" && props(node)["data-context-turn-index"] !== undefined,
  );
try {
  await mkdir(join(directory, session));
  await writeFile(
    join(directory, session, "transcript.jsonl"),
    raw.map((item) => JSON.stringify(item)).join("\n") + "\n",
    { mode: 0o600 },
  );
  const page = await getSessionTranscriptPage(session, {}, directory);
  assert.equal(page.hasMore, tail);
  if (tail) assert.equal(page.loadedBytes, DEFAULT_TRANSCRIPT_PAGE_BYTES);
  const initialHistory = foldTranscript(page.items);
  let messages = initialHistory.messages;
  // Live/output-journal users have a submit id; older UI caches can lack both identities.
  if (scenario === "modern-client" || scenario === "unmapped")
    messages = messages.map((message) => {
      if (message.kind !== "user") return message;
      const { sourceEventId: _sourceEventId, ...cached } = message;
      return cached;
    });
  const visibleUsers = messages.filter((item) => item.kind === "user");
  if (tail) {
    assert.equal(visibleUsers.length, 1);
    assert.equal(visibleUsers[0]?.text, recentText);
  }
  const render = async (request: number) =>
    act(async () => {
      root.render(
        <MessageStream
          messages={messages}
          engineSessionId={session}
          liveTurnActive={false}
          onContextPackageCreated={() => undefined}
          contextSelectionRequest={request}
        />,
      );
      await flushMicrotasks();
    });
  await render(0);
  await render(1);
  assert.ok(read);
  await act(async () => {
    await read;
    await flushMicrotasks();
  });
  const blocked = scenario === "unmapped" || scenario === "ambiguous-client";
  assert.equal(buttons().length, blocked ? 0 : tail ? 1 : 2);
  if (!blocked) {
    await act(async () => {
      props(buttons().at(-1)).onClick();
      await flushMicrotasks();
    });
    if (scenario === "normal")
      await act(async () => {
        props(buttons()[0]).onClick();
        await flushMicrotasks();
      });
    if (scenario === "history-expand") {
      const full = await getSessionTranscriptPage(
        session,
        { maxBytes: DEFAULT_TRANSCRIPT_PAGE_BYTES * 2 },
        directory,
      );
      assert.equal(full.hasMore, false);
      messages = mergeHistoryWindows(foldTranscript(full.items), initialHistory).messages;
      await render(1);
      assert.equal(buttons().length, 2);
      assert.equal(props(buttons()[0])["aria-pressed"], false);
      assert.equal(props(buttons()[1])["aria-pressed"], true);
    }
    const selected = nodes(container).filter(
      (node) => props(node)["data-context-turn-selected"] === "true",
    );
    assert.ok(selected.some((node) => text(node).includes(recentText)));
    if (scenario === "steer")
      assert.ok(selected.some((node) => text(node).includes("Owned continuation answer")));
  } else assert.ok(text(container).includes("对齐"));
  const merge = nodes(container).find((node) => props(node)["data-context-action"] === "merge");
  assert.ok(merge);
  assert.equal(props(merge).disabled, blocked);
  await act(async () => {
    props(merge).onClick();
    await flushMicrotasks();
  });
  const expected = blocked
    ? []
    : [
        {
          sourceSessionId: session,
          mode: "summary",
          fromEventId: scenario === "normal" ? "old-user" : "recent-user",
          toEventId: scenario === "steer" ? "steer-boundary" : "recent-boundary",
        },
      ];
  console.log(
    JSON.stringify({
      scenario,
      visibleUsers: visibleUsers.map((user) => user.text),
      hasMore: page.hasMore,
      loadedBytes: page.loadedBytes,
      payloads,
      deniedFetches,
      passed: JSON.stringify(payloads) === JSON.stringify(expected),
    }),
  );
  assert.deepEqual(payloads, expected);
  assert.equal(deniedFetches, 0);
} finally {
  await act(async () => root.unmount());
  container.parentNode?.removeChild(container);
  await rm(directory, { recursive: true, force: true });
}
