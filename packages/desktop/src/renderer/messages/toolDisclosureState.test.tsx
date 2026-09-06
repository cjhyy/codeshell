import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToolCardShell } from "../tool-cards/ToolCardShell";
import { ToolGroupCard } from "./ToolGroupCard";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import type { ToolMessage } from "../types";

function reactPropsOf(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

function descendants(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(descendants)];
}

describe.each(["tool", "group"] as const)("%s disclosure turn ownership", (kind) => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    ensureMiniDom();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    document.body.removeChild(container);
  });

  async function render(status: ToolMessage["status"], epoch?: number, defaultOpen = false) {
    const message: ToolMessage = {
      kind: "tool",
      id: "tool-1",
      toolName: "TestTool",
      args: "{}",
      status,
      startedAt: 1,
    };
    await act(async () => {
      root.render(
        kind === "tool" ? (
          <ToolCardShell
            message={message}
            summary="Activity"
            details={<p>Tool result</p>}
            turnEpoch={epoch}
          />
        ) : (
          <ToolGroupCard
            group={{ kind: "tool_group", id: "group-1", items: [message] }}
            turnEpoch={epoch}
            defaultOpen={defaultOpen}
          />
        ),
      );
      await flushMicrotasks();
    });
  }

  function toggleProps() {
    return reactPropsOf(descendants(container).find((node) => node.tagName === "BUTTON"));
  }

  async function toggle() {
    await act(async () => {
      toggleProps().onClick({ stopPropagation() {} });
      await flushMicrotasks();
    });
  }

  test("keeps manually opened history across later turns", async () => {
    await render("succeeded", 4);
    const collapsedDetailsId = toggleProps()["aria-controls"];
    const collapsedDetails = descendants(container).find(
      (node) => reactPropsOf(node).id === collapsedDetailsId,
    );
    expect(reactPropsOf(collapsedDetails).hidden).toBe(true);
    await toggle();
    expect(toggleProps()["aria-expanded"]).toBe(true);
    const detailsId = toggleProps()["aria-controls"];
    expect(typeof detailsId).toBe("string");
    expect(descendants(container).some((node) => reactPropsOf(node).id === detailsId)).toBe(true);

    await render("succeeded", 5);
    await render("succeeded", 6);
    expect(toggleProps()["aria-expanded"]).toBe(true);
    expect(toggleProps()["aria-controls"]).toBe(detailsId);
  });

  test("folds its own completed run once, then preserves reopened history", async () => {
    await render("running", 4);
    await toggle();
    await render("succeeded", 4);
    expect(toggleProps()["aria-expanded"]).toBe(true);

    await render("succeeded", 5);
    expect(toggleProps()["aria-expanded"]).toBe(false);

    await toggle();
    await render("succeeded", 6);
    expect(toggleProps()["aria-expanded"]).toBe(true);
  });

  test("preserves manual state without an epoch signal", async () => {
    await render("running");
    await toggle();
    await render("succeeded");
    expect(toggleProps()["aria-expanded"]).toBe(true);
  });

  if (kind === "group") {
    test("keeps the nested group's default-open policy only for its own turn", async () => {
      await render("running", 4, true);
      await toggle();
      expect(toggleProps()["aria-expanded"]).toBe(false);
      await render("succeeded", 4, true);
      await render("succeeded", 5, true);
      expect(toggleProps()["aria-expanded"]).toBe(true);

      await toggle();
      await render("succeeded", 6, true);
      expect(toggleProps()["aria-expanded"]).toBe(false);
    });
  }
});
