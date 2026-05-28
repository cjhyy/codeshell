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
