import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BackgroundWorkInfo } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

let conversation: Record<string, any> | null = null;
mock.module("./CCConversationView", () => ({
  CCConversationView(props: Record<string, any>) {
    conversation = props;
    return React.createElement("div", { "data-conversation": props.sessionId });
  },
}));
const { DriveAgentTaskView, stopDriveAgentTask } = await import("./DriveAgentTaskView");

type Job = Extract<BackgroundWorkInfo, { kind: "job" }>;
const request = {
  nonce: 1,
  jobId: "cc-job",
  sourceSessionId: "parent",
  cliKind: "codex" as const,
  cwd: "/repo",
  title: "Check progress",
};
let root: Root | null = null;
let container: HTMLElement;
let current: Job | null;
let reads: string[];
let opens: unknown[][];
let cancellations: unknown[][];
let takeovers: unknown[][];
let marks: unknown[][];
function job(extra: Partial<Job> = {}): Job {
  return {
    kind: "job",
    jobId: "cc-job",
    description: "Run tests",
    jobKind: "drive-agent",
    cli: "codex",
    cwd: "/repo",
    status: "running",
    startedAt: Date.now() - 70_000,
    sourceSession: { sessionId: "parent", shortId: "parent", current: true },
    ...extra,
  };
}
function props(node: any): Record<string, any> {
  const key = Object.keys(node ?? {}).find((key) => key.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function nodes(node: any, tag: string): any[] {
  return [
    ...(node.tagName === tag ? [node] : []),
    ...(node.childNodes ?? []).flatMap((child: any) => nodes(child, tag)),
  ];
}
function text(node: any): string {
  if (node.nodeType === 3) return node.nodeValue ?? node.textContent ?? "";
  return node.childNodes?.length ? node.childNodes.map(text).join("") : (node.textContent ?? "");
}
async function render(active = true) {
  await act(async () => {
    root!.render(<DriveAgentTaskView request={request} active={active} />);
    await flushMicrotasks();
  });
}
async function changed() {
  await act(async () => {
    window.dispatchEvent(new Event("codeshell:files-changed"));
    await flushMicrotasks();
  });
}
async function elapse(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await flushMicrotasks();
  });
}
beforeEach(() => {
  ensureMiniDom();
  jest.useFakeTimers();
  conversation = null;
  current = job();
  reads = [];
  opens = [];
  cancellations = [];
  takeovers = [];
  marks = [];
  Object.assign(window, {
    codeshell: {
      listBackgroundWork: async (owner: string) => {
        reads.push(owner);
        return { items: current ? [current] : [] };
      },
      cancelBackgroundJob: async (...args: unknown[]) => {
        cancellations.push(args);
        return { cancelled: true };
      },
      markBackgroundJobInterrupted: async (...args: unknown[]) => {
        marks.push(args);
        current = { ...current!, status: "failed", finalText: "[interrupted]" };
        return { marked: true };
      },
      ccRoom: {
        openLinkedSession: async (...args: unknown[]) => {
          opens.push(args);
          return { roomId: "room-1", status: "observing", mode: "default", cwd: "/repo" };
        },
        takeOverLinkedSession: async (...args: unknown[]) => {
          takeovers.push(args);
          return { roomId: "room-1", status: "running", mode: "default", cwd: "/repo" };
        },
      },
    },
  });
  container = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
  jest.clearAllTimers();
  jest.useRealTimers();
});
afterAll(() => mock.restore());

describe("DriveAgentTaskView", () => {
  test("keeps a stable startup page, binds a delayed CLI identity, and follows completion", async () => {
    await render();
    expect(text(container)).toContain("等待外部会话");
    expect(text(container)).toContain("暂未收到新输出");
    expect(opens).toEqual([]);
    current = job({
      externalSessionId: "thread-1",
      progress: {
        lastActivityAt: Date.now(),
        eventCount: 1,
        phase: "tool",
        summary: "Bash: bun test",
      },
    });
    await changed();
    expect(opens).toEqual([
      ["thread-1", "/repo", "codex", { jobId: "cc-job", sourceSessionId: "parent" }],
    ]);
    expect(conversation).toMatchObject({
      sessionId: "thread-1",
      observing: true,
      onTakeOver: undefined,
    });
    expect(text(container)).toContain("Bash: bun test");
    expect(text(container)).not.toContain("暂未收到新输出");
    current = {
      ...current,
      status: "completed",
      finishedAt: Date.now(),
      finalText: "All tests passed",
    };
    await changed();
    expect(text(container)).toContain("已完成");
    expect(text(container)).toContain("All tests passed");
    expect(typeof conversation!.onTakeOver).toBe("function");
    expect(takeovers).toEqual([]);
  });

  test("does not read or open a hidden task, and resumes when shown", async () => {
    current = job({ externalSessionId: "thread-1" });
    await render(false);
    await changed();
    expect(reads).toEqual([]);
    expect(opens).toEqual([]);
    await render(true);
    expect(reads).toEqual(["parent"]);
    expect(opens).toHaveLength(1);
  });

  test("recovers a live transcript that appears after the initial retry window", async () => {
    current = job({ externalSessionId: "thread-1" });
    const open = window.codeshell.ccRoom.openLinkedSession;
    let attempts = 0;
    window.codeshell.ccRoom.openLinkedSession = async (...args) => {
      if (++attempts <= 5) throw new Error("Transcript not flushed yet");
      return open(...args);
    };
    await render();
    for (let i = 0; i < 4; i++) await elapse(1500);
    expect(attempts).toBe(5);
    expect(text(container)).toContain("暂时无法读取会话记录");
    await elapse(10_000);
    expect(attempts).toBe(6);
    expect(conversation).toMatchObject({ sessionId: "thread-1", observing: true });
  });

  test("stops connection retries when the task page is hidden", async () => {
    current = job({ externalSessionId: "thread-1" });
    let attempts = 0;
    window.codeshell.ccRoom.openLinkedSession = async () => {
      attempts += 1;
      throw new Error("Transcript unavailable");
    };
    await render();
    await render(false);
    await elapse(30_000);
    expect(attempts).toBe(1);
    await render(true);
    expect(attempts).toBe(2);
  });

  test("retries immediately on completion and bounds retries for a finished task", async () => {
    current = job({ externalSessionId: "thread-1" });
    let attempts = 0;
    window.codeshell.ccRoom.openLinkedSession = async () => {
      attempts += 1;
      throw new Error("Transcript unavailable");
    };
    await render();
    for (let i = 0; i < 4; i++) await elapse(1500);
    expect(attempts).toBe(5);
    current = { ...current, status: "completed", finalText: "Fixed the failing Linux checks" };
    await changed();
    expect(attempts).toBe(6);
    for (let i = 0; i < 4; i++) await elapse(1500);
    await elapse(30_000);
    expect(attempts).toBe(10);
    expect(text(container)).toContain("Fixed the failing Linux checks");
    expect(
      nodes(container, "DETAILS").some((node) => text(node).includes(current!.finalText!)),
    ).toBe(false);
    const retry = nodes(container, "BUTTON").find((node) => text(node) === "重试");
    await act(async () => {
      props(retry).onClick();
      await flushMicrotasks();
    });
    expect(attempts).toBe(11);
  });

  test("shows a finished task's actual result directly when there is no transcript", async () => {
    current = job({ status: "failed", finalText: "Build failed in packages/desktop" });
    await render();
    expect(text(container)).toContain("Build failed in packages/desktop");
    expect(text(container)).toContain("此任务暂无可用的会话记录");
    expect(nodes(container, "DETAILS")).toHaveLength(0);
    expect(opens).toEqual([]);
    window.codeshell.listBackgroundWork = async () => {
      throw new Error("worker temporarily unavailable");
    };
    await changed();
    expect(text(container)).toContain("无法确认任务当前状态");
    expect(text(container)).toContain("Build failed in packages/desktop");
  });

  test("rejects another owner's matching job and reports unknown instead of running", async () => {
    current = job({
      sourceSession: { sessionId: "other", shortId: "other", current: false },
      externalSessionId: "other-thread",
    });
    await render();
    expect(text(container)).toContain("状态待确认");
    expect(opens).toEqual([]);
    expect(conversation).toBeNull();
  });

  test("unknown and stopping jobs remain read-only even when their transcript exists", async () => {
    current = job({ status: "unknown", externalSessionId: "thread-1", canCancel: false });
    await render();
    expect(conversation!.onTakeOver).toBeUndefined();
    expect(conversation!.observing).toBe(true);
    current = { ...current, status: "cancelling" };
    await changed();
    expect(text(container)).toContain("停止中");
    expect(conversation!.onTakeOver).toBeUndefined();
    expect(nodes(container, "BUTTON").some((node) => text(node) === "停止")).toBe(false);
  });

  test("an orphaned task explains why and can be marked ended after confirmation", async () => {
    current = job({
      status: "unknown",
      unknownReason: "orphaned-process",
      externalSessionId: "thread-1",
      canCancel: false,
      startedAt: 4321,
    });
    await render();
    expect(text(container)).toContain("CLI 进程仍在运行");
    const button = (label: string) =>
      nodes(container, "BUTTON").find((node) => text(node) === label);
    await act(async () => {
      props(button("标记为已结束")).onClick();
      await flushMicrotasks();
    });
    expect(marks).toEqual([]);
    expect(text(container)).toContain("仅在确认 CLI 已不再运行时继续");
    await act(async () => {
      props(button("标记为已结束")).onClick();
      await flushMicrotasks();
    });
    expect(marks).toEqual([["parent", "cc-job", 4321]]);
    expect(text(container)).toContain("失败");
    expect(button("标记为已结束")).toBeUndefined();
    expect(typeof conversation!.onTakeOver).toBe("function");
  });

  test("a task owned by another process says so", async () => {
    current = job({ status: "unknown", unknownReason: "other-process", canCancel: false });
    await render();
    expect(text(container)).toContain("另一个 CodeShell 进程");
  });

  test("stops through the owner and exact attempt fence", async () => {
    current = job({ startedAt: 1234 });
    expect(await stopDriveAgentTask(current)).toBe(true);
    expect(cancellations).toEqual([["parent", "cc-job", 1234]]);
  });

  test("rechecks terminal state before takeover and rejects a newly active task", async () => {
    current = job({ status: "completed", externalSessionId: "thread-1" });
    await render();
    const takeOver = conversation!.onTakeOver;
    current = { ...current, status: "running" };
    await act(async () => {
      await expect(takeOver()).rejects.toThrow();
      await flushMicrotasks();
    });
    expect(takeovers).toEqual([]);
    expect(conversation!.onTakeOver).toBeUndefined();
  });

  test("a failed status refresh disables takeover and exposes a retryable status", async () => {
    current = job({ status: "completed", externalSessionId: "thread-1" });
    await render();
    window.codeshell.listBackgroundWork = async () => {
      throw new Error("worker unavailable");
    };
    await changed();
    expect(text(container)).toContain("无法确认任务当前状态");
    expect(conversation!.onTakeOver).toBeUndefined();
  });
});
