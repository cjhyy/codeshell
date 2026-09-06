import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AutomationSummary } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { AutomationDetail, AutomationView } from "./AutomationView";

function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(descendants)];
}

function props(node: Element): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}

function textOf(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? (node as Text).data ?? node.textContent ?? "";
  const children = Array.from(node.childNodes);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}

const firstJob: AutomationSummary = {
  id: "daily",
  name: "每日摘要",
  schedule: "0 9 * * *",
  prompt: "整理昨日进展。",
  enabled: true,
  cwd: null,
  timezone: "UTC",
  permissionLevel: "read-only",
  lastRun: null,
  nextRun: 1_800_000_000_000,
  runCount: 0,
  createdAt: 0,
  lastRunId: null,
  once: false,
  resumeSessionId: null,
};
const secondJob: AutomationSummary = {
  ...firstJob,
  id: "weekly",
  name: "每周复查",
  prompt: "回顾这一周。",
  enabled: false,
  once: true,
};
const noop = () => undefined;

describe("AutomationView interaction", () => {
  let root: Root;
  let container: HTMLElement;
  let codeshellBefore: PropertyDescriptor | undefined;
  let storageBefore: PropertyDescriptor | undefined;
  let jobs: AutomationSummary[];
  let createCalls: number;
  const writes: string[] = [];

  beforeEach(() => {
    ensureMiniDom();
    codeshellBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null },
    });
    jobs = [firstJob, secondJob];
    createCalls = 0;
    writes.length = 0;
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        listAutomations: async () => jobs,
        listRuns: async () => [],
        listDiskSessions: async () => ({ sessions: [] }),
        pauseAutomation: async () => writes.push("pause"),
        resumeAutomation: async () => writes.push("resume"),
        runAutomationNow: async () => writes.push("run"),
        deleteAutomation: async () => writes.push("delete"),
        updateAutomation: async () => writes.push("update"),
      },
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
    if (codeshellBefore) Object.defineProperty(window, "codeshell", codeshellBefore);
    else Reflect.deleteProperty(window, "codeshell");
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  async function renderView() {
    await act(async () => {
      root.render(
        <AutomationView
          projects={[]}
          sessionIndices={{}}
          onCreateConversational={() => createCalls++}
          onOpenRunSession={noop}
          onOpenDiskSession={noop}
          onOpenSession={noop}
        />,
      );
      await flushMicrotasks();
    });
  }

  const button = (label: string) => {
    const found = descendants(container).find(
      (node) => node.tagName === "BUTTON" && textOf(node) === label,
    );
    expect(found).toBeDefined();
    return found as HTMLButtonElement;
  };

  async function click(node: Element) {
    await act(async () => {
      props(node).onClick();
      await flushMicrotasks();
    });
  }

  test("uses native selection buttons connected to the detail, without running or changing a job", async () => {
    await renderView();
    const list = descendants(container).find(
      (node) => node.tagName === "UL" && node.getAttribute("aria-label") === "自动化任务",
    )!;
    const choices = descendants(list).filter((node) => node.tagName === "BUTTON");
    expect(choices).toHaveLength(2);
    expect(choices[0].getAttribute("aria-pressed")).toBe("true");
    expect(choices[1].getAttribute("aria-pressed")).toBe("false");
    expect(props(choices[1]).type).toBe("button");
    const detail = descendants(container).find(
      (node) => node.getAttribute("id") === choices[1].getAttribute("aria-controls"),
    )!;
    expect(detail.getAttribute("aria-label")).toBe(firstJob.name);

    (choices[1] as HTMLElement).focus();
    await click(choices[1]);
    expect(choices[0].getAttribute("aria-pressed")).toBe("false");
    expect(choices[1].getAttribute("aria-pressed")).toBe("true");
    expect(detail.getAttribute("aria-label")).toBe(secondJob.name);
    expect(textOf(detail)).toContain(secondJob.prompt);
    expect(textOf(detail)).toContain("已暂停");
    expect(textOf(descendants(detail).find((node) => node.tagName === "P")!)).toContain("一次性");
    expect(document.activeElement).toBe(choices[1]);
    expect(writes).toEqual([]);

    await click(button("编辑"));
    expect(document.activeElement?.tagName).toBe("TEXTAREA");
    (choices[0] as HTMLElement).focus();
    await click(choices[0]);
    expect(descendants(detail).some((node) => node.tagName === "TEXTAREA")).toBe(false);
    expect(document.activeElement).toBe(choices[0]);
  });

  test("the empty state has one working conversational creation entry", async () => {
    jobs = [];
    await renderView();
    expect(textOf(container)).toContain("从一件重复的小事开始");
    expect(descendants(container).filter((node) => node.tagName === "BUTTON")).toHaveLength(1);
    await click(button("新建自动化"));
    expect(createCalls).toBe(1);
    expect(writes).toEqual([]);
  });

  test("prompt editing labels and focuses the field, then restores focus on cancel and save", async () => {
    const saves: unknown[] = [];
    function DetailHarness() {
      const [job, setJob] = React.useState(firstJob);
      return (
        <AutomationDetail
          job={job}
          projects={[]}
          sessions={[]}
          onToggleEnabled={noop}
          onDelete={noop}
          onRunNow={noop}
          onSave={(patch) => {
            saves.push(patch);
            setJob((current) => ({ ...current, ...patch }));
          }}
          runNowBusy={false}
          deleteBusy={false}
          toggleBusy={false}
          saveBusy={false}
          onOpenRunSession={noop}
          onOpenDiskSession={noop}
          onOpenSession={noop}
        />
      );
    }
    await act(async () => {
      root.render(<DetailHarness />);
      await flushMicrotasks();
    });
    const edit = button("编辑");
    edit.focus();
    await click(edit);
    const textarea = descendants(container).find((node) => node.tagName === "TEXTAREA")!;
    expect(document.activeElement).toBe(textarea);
    expect(
      textOf(
        descendants(container).find(
          (node) => node.getAttribute("id") === textarea.getAttribute("aria-labelledby"),
        )!,
      ),
    ).toBe("任务指令");
    await act(async () => {
      props(textarea).onChange({ target: { value: "  更新后的任务指令。  " } });
    });
    await click(button("取消"));
    expect(document.activeElement).toBe(edit);
    expect(saves).toEqual([]);

    await click(edit);
    const reopened = descendants(container).find((node) => node.tagName === "TEXTAREA")!;
    expect(props(reopened).value).toBe(firstJob.prompt);
    await act(async () => {
      props(reopened).onChange({ target: { value: "  更新后的任务指令。  " } });
    });
    await click(button("保存"));
    expect(saves).toEqual([{ prompt: "更新后的任务指令。" }]);
    expect(document.activeElement).toBe(edit);
    expect(textOf(container)).toContain("更新后的任务指令。");
  });
});
