import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantMessageView } from "./AssistantMessageView";
import type { AssistantMessage } from "../types";

function asst(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return { kind: "assistant", id: "a1", text: "", done: false, ...over };
}

describe("AssistantMessageView empty suppression", () => {
  test("renders nothing while streaming with empty text", () => {
    const html = renderToStaticMarkup(<AssistantMessageView message={asst({ done: false, text: "" })} />);
    expect(html).toBe("");
  });

  // Replay (transcript-reader) emits stream_request_start → text_delta("") →
  // assistant_message for EVERY assistant turn, including tool-only turns
  // (e.g. a TodoWrite turn with no prose). Those land as done:true text:"".
  // The view renders only `text`, so a done empty assistant is a blank bubble
  // (padding + hover footer) — the empty blocks the user saw after refresh.
  test("renders nothing when DONE with empty text (tool-only turn after replay)", () => {
    const html = renderToStaticMarkup(<AssistantMessageView message={asst({ done: true, text: "" })} />);
    expect(html).toBe("");
  });

  test("still renders a done assistant that has text", () => {
    const html = renderToStaticMarkup(<AssistantMessageView message={asst({ done: true, text: "hello" })} />);
    expect(html).toContain("hello");
  });
});
