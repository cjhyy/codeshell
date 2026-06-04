import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageStream } from "./MessageStream";
import type { Message } from "./types";

describe("MessageStream — empty streaming assistant guard", () => {
  test("hides assistant with empty text while streaming", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "hi" },
      { kind: "assistant", id: "a1", text: "", done: false },
    ];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    expect(html).not.toContain("…");
    expect(html).toContain("hi");
  });

  test("renders assistant with non-empty streaming text", () => {
    const messages: Message[] = [
      { kind: "assistant", id: "a1", text: "Hel", done: false },
    ];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    expect(html).toContain("Hel");
  });

  test("renders done assistant with empty text (defensive)", () => {
    const messages: Message[] = [
      { kind: "assistant", id: "a1", text: "", done: true },
    ];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    expect(html).not.toContain("…");
  });
});

describe("MessageStream — empty marker suppression (no blank blocks)", () => {
  // The replay path can synthesize these with empty content; each must
  // render nothing rather than a padded blank block.
  test("hides a system message with empty text", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "hi" },
      { kind: "system", id: "s1", text: "" },
    ];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    // No empty centered marker div beyond the user bubble.
    expect(html).not.toContain("text-center");
  });

  test("hides a thinking message with empty text", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: "hi" },
      { kind: "thinking", id: "t1", text: "", done: true },
    ];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    expect(html).not.toContain("thinking");
  });

  test("still renders a thinking message that has text", () => {
    const messages: Message[] = [
      { kind: "thinking", id: "t1", text: "pondering", done: true },
    ];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    expect(html).toContain("thinking");
  });
});
