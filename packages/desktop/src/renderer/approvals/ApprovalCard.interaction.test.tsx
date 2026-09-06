import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApprovalRequestEnvelope } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { UI_LANGUAGE_STORAGE_KEY } from "../uiLanguage";

ensureMiniDom();
const { ApprovalCard } = await import("./ApprovalCard");
const { RiskPill } = await import("./RiskPill");

function nodes(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
}
function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function textOf(node: any): string {
  if (node.nodeType === 3) return node.data ?? node.textContent ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}

let root: Root;
let container: HTMLElement;
let language: "zh" | "en";
let storageBefore: PropertyDescriptor | undefined;

beforeEach(() => {
  ensureMiniDom();
  language = "zh";
  storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => (key === UI_LANGUAGE_STORAGE_KEY ? language : null) },
  });
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
  if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

async function render(child: React.ReactNode) {
  await act(async () => {
    root.render(child);
    await flushMicrotasks();
  });
}

function envelope(args: Record<string, unknown>, riskLevel?: "low" | "medium" | "high") {
  return {
    sessionId: "s1",
    requestId: "r1",
    request: { toolName: "Bash", args, riskLevel },
  } as ApprovalRequestEnvelope;
}

describe("ApprovalCard disclosure", () => {
  test.each(["zh", "en"] as const)(
    "%s raw arguments are labelled, complete, keyboard reachable, and independent of decisions",
    async (locale) => {
      language = locale;
      const decisions: unknown[] = [];
      const args = {
        command: "git status",
        payload: "long-json-segment/".repeat(500) + "JSON-TAIL",
      };
      await render(
        <ApprovalCard
          envelope={envelope(args, "medium")}
          onDecide={(...decision) => decisions.push(decision)}
        />,
      );
      const toggle = nodes(container).find(
        (node) => node.tagName === "BUTTON" && props(node)["aria-controls"],
      );
      expect(textOf(toggle)).toBe(locale === "zh" ? "展开原始参数" : "Show raw arguments");
      expect(props(toggle).type).toBe("button");
      expect(props(toggle)["aria-expanded"]).toBe(false);
      const panel = nodes(container).find(
        (node) => props(node).id === props(toggle)["aria-controls"],
      );
      expect(panel).toBeDefined();
      expect(props(panel).hidden).toBe(true);
      expect(nodes(panel).some((node) => node.tagName === "PRE")).toBe(false);
      await act(async () => props(toggle).onClick());
      expect(props(toggle)["aria-expanded"]).toBe(true);
      expect(textOf(toggle)).toBe(locale === "zh" ? "收起原始参数" : "Hide raw arguments");
      expect(props(panel).hidden).toBe(false);
      const raw = nodes(panel).find((node) => node.tagName === "PRE");
      expect(textOf(raw)).toBe(JSON.stringify(args, null, 2));
      expect(props(raw)["aria-label"]).toBe(locale === "zh" ? "原始参数" : "Raw arguments");
      expect(props(raw).tabIndex).toBe(0);
      raw.focus();
      expect(document.activeElement).toBe(raw);
      toggle.focus();
      await act(async () => props(toggle).onClick());
      expect(props(toggle)["aria-expanded"]).toBe(false);
      expect(props(panel).hidden).toBe(true);
      expect(document.activeElement).toBe(toggle);
      expect(decisions).toEqual([]);
    },
  );

  test.each(["zh", "en"] as const)(
    "%s risk labels describe all levels without changing their tones",
    async (locale) => {
      language = locale;
      await render(
        <>
          <RiskPill level="low" />
          <RiskPill level="medium" />
          <RiskPill level="high" />
        </>,
      );
      const pills = nodes(container).filter((node) => node.tagName === "SPAN");
      expect(pills.map(textOf)).toEqual(
        locale === "zh" ? ["低风险", "中风险", "高风险"] : ["Low risk", "Medium risk", "High risk"],
      );
      expect(props(pills[0]).className).toContain("text-status-ok");
      expect(props(pills[1]).className).toContain("text-status-warn");
      expect(props(pills[2]).className).toContain("text-status-err");
    },
  );

  test("engine-supplied risk still takes precedence over the heuristic", async () => {
    await render(
      <ApprovalCard
        envelope={envelope({ command: "git status" }, "high")}
        onDecide={() => undefined}
      />,
    );
    expect(textOf(container)).toContain("高风险");
    expect(textOf(container)).not.toContain("低风险");
  });

  test("requests without an explicit risk still use the existing heuristic", async () => {
    await render(
      <ApprovalCard
        envelope={envelope({ command: "rm -rf /tmp/example" })}
        onDecide={() => undefined}
      />,
    );
    expect(textOf(container)).toContain("高风险");
  });
});
