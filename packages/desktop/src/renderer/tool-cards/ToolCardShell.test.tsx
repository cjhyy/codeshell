import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCardShell } from "./ToolCardShell";
import type { ToolMessage } from "../types";

function msg(): ToolMessage {
  return {
    kind: "tool",
    id: "t1",
    toolName: "Read",
    args: "{}",
    status: "succeeded",
    startedAt: 0,
  };
}

describe("ToolCardShell — turnEpoch prop", () => {
  test("accepts turnEpoch prop without crashing", () => {
    // Real force-collapse-on-epoch-change behavior is exercised in
    // manual UI verification (Task 9); static markup just confirms
    // the prop is wired and the card renders.
    const html = renderToStaticMarkup(
      <ToolCardShell
        message={msg()}
        summary="hello"
        details={<div>body</div>}
        turnEpoch={5}
      />,
    );
    expect(html).toContain("Read");
    expect(html).toContain("hello");
    // Default closed state — details body not in static output.
    expect(html).not.toContain("body");
  });

  test("works with turnEpoch undefined (back-compat)", () => {
    const html = renderToStaticMarkup(
      <ToolCardShell message={msg()} summary="hi" />,
    );
    expect(html).toContain("Read");
  });
});
