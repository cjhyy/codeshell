import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GenericToolCard } from "./GenericToolCard";
import type { ToolMessage } from "../types";

function msg(over: Partial<ToolMessage> = {}): ToolMessage {
  return {
    kind: "tool",
    id: "t1",
    toolName: "PowerShell",
    args: JSON.stringify({ command: "Write-Output hi" }),
    result: "hi",
    status: "succeeded",
    startedAt: 0,
    ...over,
  };
}

describe("GenericToolCard sandbox badge", () => {
  test("shows the unisolated badge for tools that carry sandbox status", () => {
    const html = renderToStaticMarkup(
      <GenericToolCard message={msg({ sandbox: { backend: "off" } })} />,
    );
    expect(html).toContain("未隔离");
  });

  test("does not label tools without sandbox status as unisolated", () => {
    const html = renderToStaticMarkup(<GenericToolCard message={msg()} />);
    expect(html).not.toContain("未隔离");
  });

  test("shows isolated backend details instead of the unisolated badge", () => {
    const html = renderToStaticMarkup(
      <GenericToolCard message={msg({ sandbox: { backend: "seatbelt", network: "deny" } })} />,
    );
    expect(html).toContain("seatbelt");
    expect(html).toContain("网络禁止");
    expect(html).not.toContain("未隔离");
  });
});
