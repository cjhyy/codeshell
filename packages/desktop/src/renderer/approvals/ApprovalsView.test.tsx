import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApprovalRequestEnvelope } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { UI_LANGUAGE_STORAGE_KEY } from "../uiLanguage";

ensureMiniDom();
const { ApprovalsView } = await import("./ApprovalsView");

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

function envelope(id: string, command = `command-${id}`): ApprovalRequestEnvelope {
  return {
    sessionId: "session-1",
    requestId: id,
    request: { toolName: "Bash", args: { command }, riskLevel: "medium" },
  } as ApprovalRequestEnvelope;
}

type HistoryEntry = React.ComponentProps<typeof ApprovalsView>["history"][number];
let root: Root;
let container: HTMLElement;
let storageBefore: PropertyDescriptor | undefined;
let language: "zh" | "en";
let decisions: unknown[][];

beforeEach(() => {
  ensureMiniDom();
  language = "zh";
  decisions = [];
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

async function render(queue: ApprovalRequestEnvelope[] = [], history: HistoryEntry[] = []) {
  await act(async () => {
    root.render(
      <ApprovalsView
        queue={queue}
        history={history}
        onDecide={(...args) => decisions.push(args)}
      />,
    );
    await flushMicrotasks();
  });
}

async function click(node: any) {
  await act(async () => {
    props(node).onClick();
    await flushMicrotasks();
  });
}

function section(index: number) {
  return nodes(container).filter((node) => node.tagName === "SECTION")[index];
}

describe("ApprovalsView", () => {
  test("labels pending and history separately and shows both empty states without decisions", async () => {
    await render();
    expect(textOf(nodes(container).find((node) => node.tagName === "H1"))).toBe("审批记录");
    expect(textOf(section(0))).toContain("没有待处理的工具调用");
    expect(textOf(section(1))).toContain("暂无记录");
    for (const region of [section(0), section(1)]) {
      const heading = nodes(region).find((node) => node.tagName === "H2");
      expect(props(region)["aria-labelledby"]).toBe(props(heading).id);
    }
    expect(decisions).toEqual([]);
  });

  test.each(["zh", "en"] as const)(
    "localizes history decisions in %s and retains full request and reason tails",
    async (locale) => {
      language = locale;
      const command = "command-long-segment/".repeat(180) + "COMMAND-TAIL";
      const reason = "Detailed explanation. ".repeat(70) + "REASON-TAIL";
      await render(
        [],
        [
          { decision: "approve", envelope: envelope("approved"), at: 1_800_000_000_000 },
          {
            decision: "deny",
            envelope: envelope("denied", command),
            reason,
            at: 1_800_000_001_000,
          },
        ],
      );
      const history = section(1);
      expect(textOf(history)).toContain(locale === "zh" ? "已批准" : "Approved");
      expect(textOf(history)).toContain(locale === "zh" ? "已拒绝" : "Denied");
      const request = nodes(history).find((node) => node.tagName === "PRE");
      expect(textOf(request)).toBe(command);
      expect(props(request).tabIndex).toBe(0);
      expect(props(request)["aria-label"]).toBe(locale === "zh" ? "请求内容" : "Request details");
      const reasonBlock = nodes(history).find(
        (node) => node.tagName === "P" && props(node).tabIndex === 0,
      );
      expect(textOf(reasonBlock)).toBe(reason);
      expect(props(reasonBlock)["aria-label"]).toBe(
        locale === "zh" ? "决定理由" : "Decision reason",
      );
      const time = nodes(history).find((node) => node.tagName === "TIME");
      expect(props(time).dateTime).toBe(new Date(1_800_000_001_000).toISOString());
      expect(decisions).toEqual([]);
    },
  );

  test("preserves newest-first history and its 50-entry limit without mutating the source", async () => {
    const history: HistoryEntry[] = Array.from({ length: 53 }, (_, index) => ({
      decision: "approve",
      envelope: envelope(String(index)),
      at: 1_800_000_000_000 + index,
    }));
    const original = history.slice();
    await render([], history);
    const requests = nodes(section(1)).filter((node) => node.tagName === "PRE");
    expect(requests).toHaveLength(50);
    expect(textOf(requests[0])).toBe("command-52");
    expect(textOf(requests[49])).toBe("command-3");
    expect(textOf(section(1))).toContain("显示最近 50 条记录");
    expect(history).toEqual(original);
    expect(decisions).toEqual([]);
  });

  test("keeps queue order and forwards existing session / file approval scopes with their envelope", async () => {
    const first = envelope("first");
    const second = {
      ...envelope("second"),
      request: {
        toolName: "Write",
        args: { file_path: "/repo/src/index.ts" },
        riskLevel: "medium",
      },
    } as ApprovalRequestEnvelope;
    const queue = [first, second];
    await render(queue);
    const items = nodes(section(0)).filter((node) => node.tagName === "LI");
    expect(items).toHaveLength(2);
    expect(textOf(items[0])).toContain("command-first");
    expect(textOf(items[1])).toContain("/repo/src/index.ts");
    expect(decisions).toEqual([]);
    const sessionButton = nodes(items[0]).find(
      (node) => node.tagName === "BUTTON" && textOf(node) === "本会话一直允许",
    );
    const fileButton = nodes(items[1]).find(
      (node) => node.tagName === "BUTTON" && textOf(node) === "本会话允许写 index.ts",
    );
    await click(sessionButton);
    await click(fileButton);
    expect(decisions).toEqual([
      [first, "approve", undefined, "session", undefined],
      [second, "approve", undefined, "session", "file"],
    ]);
    expect(queue).toEqual([first, second]);
  });

  test("approval once and denial still use their original unremembered decisions", async () => {
    const first = envelope("first");
    const second = envelope("second");
    await render([first, second]);
    const items = nodes(section(0)).filter((node) => node.tagName === "LI");
    await click(
      nodes(items[0]).find((node) => node.tagName === "BUTTON" && textOf(node) === "仅本次批准"),
    );
    await click(
      nodes(items[1]).find((node) => node.tagName === "BUTTON" && textOf(node) === "拒绝"),
    );
    expect(decisions).toEqual([
      [first, "approve", undefined, "once", undefined],
      [second, "deny", undefined, undefined, undefined],
    ]);
  });
});
