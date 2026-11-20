import { describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantMessageView } from "./AssistantMessageView";
import { UserMessageView } from "./UserMessageView";
import type { AssistantMessage, UserMessage } from "../types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

function asst(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return { kind: "assistant", id: "a1", text: "", done: false, ...over };
}

describe("AssistantMessageView empty suppression", () => {
  test("renders nothing while streaming with empty text", () => {
    const html = renderToStaticMarkup(
      <AssistantMessageView message={asst({ done: false, text: "" })} />,
    );
    expect(html).toBe("");
  });

  // Replay (transcript-reader) emits stream_request_start → text_delta("") →
  // assistant_message for EVERY assistant turn, including tool-only turns
  // (e.g. a TodoWrite turn with no prose). Those land as done:true text:"".
  // The view renders only `text`, so a done empty assistant is a blank bubble
  // (padding + hover footer) — the empty blocks the user saw after refresh.
  test("renders nothing when DONE with empty text (tool-only turn after replay)", () => {
    const html = renderToStaticMarkup(
      <AssistantMessageView message={asst({ done: true, text: "" })} />,
    );
    expect(html).toBe("");
  });

  test("still renders a done assistant that has text", () => {
    const html = renderToStaticMarkup(
      <AssistantMessageView message={asst({ done: true, text: "hello" })} />,
    );
    expect(html).toContain("hello");
  });
});

// User bubbles share this file to keep the desktop shard within its budget.
const image = "/repo/.code-shell/attachments/s-1/abc-shot.png";
const message: UserMessage = {
  kind: "user",
  id: "u1",
  text: "修复一下",
  attachments: [
    { kind: "image", path: image, absPath: image, sessionId: "", originalName: "abc-shot.png" },
  ],
};

function elementsByTag(node: any, tag: string): any[] {
  return [
    ...(node.tagName === tag ? [node] : []),
    ...(node.childNodes ?? []).flatMap((child: any) => elementsByTag(child, tag)),
  ];
}

async function render(localRuntime: boolean) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <UserMessageView message={message} localRuntime={localRuntime} onZoom={() => {}} />,
    );
  });
  await act(async () => flushMicrotasks());
  const images = elementsByTag(container, "IMG");
  await act(async () => root.unmount());
  return images;
}

test("an image attachment restored from history renders as a thumbnail", async () => {
  ensureMiniDom();
  const reads: unknown[] = [];
  (globalThis as any).window.codeshell = {
    readImageDataUrl: async (path: string, context: unknown) => {
      reads.push([path, context]);
      return "data:image/png;base64,aW1n";
    },
  };
  try {
    const images = await render(true);
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute("src")).toBe("data:image/png;base64,aW1n");
    // Main authorizes the read by the attachment's own project and Session.
    expect(reads).toEqual([[image, { cwd: "/repo", sessionId: "s-1" }]]);
    // A cloud runtime cannot read this machine's files: keep the name chip.
    reads.length = 0;
    expect(await render(false)).toHaveLength(0);
    expect(reads).toHaveLength(0);
  } finally {
    delete (globalThis as any).window.codeshell;
  }
});
