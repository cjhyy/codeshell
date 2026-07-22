import { afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { PetLongTask } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? React.createElement("div", null, children) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

const { DialogProvider } = await import("../ui/DialogProvider");
const {
  isLongTaskDetailCollapsible,
  isLongTaskClearable,
  PetLongTaskBulkCleanupButton,
  PetLongTaskCard,
} = await import("./PetLongTaskSection");

function reactPropsOf(node: unknown): Record<string, any> {
  const key = Object.keys(node as object).find((candidate) =>
    candidate.startsWith("__reactProps$"),
  );
  return key ? ((node as Record<string, any>)[key] ?? {}) : {};
}

function findElements(node: unknown, tagName: string): unknown[] {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  return [
    ...(current.tagName === tagName ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => findElements(child, tagName)),
  ];
}

function childText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(childText).join("");
  if (React.isValidElement(value)) return childText(value.props.children);
  return "";
}

function buttonWithLabel(node: unknown, label: string): unknown {
  return findElements(node, "BUTTON").find(
    (button) => childText(reactPropsOf(button).children) === label,
  );
}

function controlButton(node: unknown, action: string): unknown {
  return findElements(node, "BUTTON").find(
    (button) => reactPropsOf(button)["data-pet-long-task-control"] === action,
  );
}

function renderCardMarkup(card: React.ReactElement): string {
  return renderToStaticMarkup(<DialogProvider>{card}</DialogProvider>);
}

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
  }
  root = null;
  if (container?.parentNode) container.parentNode.removeChild(container);
  container = null;
});

function task(status: PetLongTask["status"]): PetLongTask {
  return {
    schemaVersion: 1,
    id: "pet-task-0123456789abcdef01234567",
    originClientMessageId: "message-1",
    objective: "Finish and verify the cross-workspace migration",
    workspacePath: "/work/app",
    sessionId: "session-1",
    status,
    phase: status === "waiting" ? "waiting-user" : "executing",
    attempt: 2,
    revision: 4,
    createdAt: 10,
    updatedAt: 20,
    summary: "Halfway through verification",
    waitingFor: status === "waiting" ? "Approve the deployment" : undefined,
    nextAction: "Run the integration suite",
    artifacts: [{ kind: "session", label: "Work session", reference: "session-1" }],
    events: [
      { id: "event-1", sequence: 1, kind: "created", at: 10 },
      { id: "event-2", sequence: 2, kind: "progress", at: 20 },
    ],
  };
}

describe("PetLongTaskCard", () => {
  test("shows durable progress, artifacts, and pause/cancel controls", () => {
    const html = renderCardMarkup(
      <PetLongTaskCard task={task("running")} busy={false} onControl={() => {}} />,
    );
    expect(html).toContain("Finish and verify the cross-workspace migration");
    expect(html).toContain("Halfway through verification");
    expect(html).toContain("Work session");
    expect(html).toContain('data-pet-long-task-control="pause"');
    expect(html).toContain('data-pet-long-task-control="cancel"');
  });

  test("makes interrupted tasks explicitly resumable and retryable", () => {
    const html = renderCardMarkup(
      <PetLongTaskCard task={task("interrupted")} busy={false} onControl={() => {}} />,
    );
    expect(html).toContain('data-pet-long-task-control="resume"');
    expect(html).toContain('data-pet-long-task-control="retry"');
  });

  test("renders markdown and collapses a long result by default", () => {
    const completed = task("completed");
    completed.summary =
      "## 结论\n\n- 根因在 **JPEG 探针**\n- 调用 `probeJpeg()`\n\n" + "详细调查结果。".repeat(80);

    const html = renderCardMarkup(
      <PetLongTaskCard task={completed} busy={false} onControl={() => {}} />,
    );

    expect(html).toContain("结论</h2>");
    expect(html).toContain("<strong>JPEG 探针</strong>");
    expect(html).toContain("<code>probeJpeg()</code>");
    expect(html).toContain('data-pet-long-task-detail="collapsed"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("展开完整结果");
    expect(html).toContain("max-h-48");
  });

  test("keeps short results and user decisions fully visible", () => {
    expect(isLongTaskDetailCollapsible("简短结果")).toBe(false);
    expect(isLongTaskDetailCollapsible("详细结果".repeat(130))).toBe(true);

    const waiting = task("waiting");
    waiting.waitingFor = "# 请确认\n\n" + "这是一条很长的用户决策提示。".repeat(80);
    const html = renderCardMarkup(
      <PetLongTaskCard task={waiting} busy={false} onControl={() => {}} />,
    );

    expect(html).toContain("请确认</h1>");
    expect(html).toContain('data-pet-long-task-detail="expanded"');
    expect(html).not.toContain("展开完整结果");
  });

  test("offers a confirmed bulk cleanup for ended task records", () => {
    const html = renderToStaticMarkup(
      <DialogProvider>
        <PetLongTaskBulkCleanupButton count={6} busy={false} onClear={async () => true} />
      </DialogProvider>,
    );

    expect(html).toContain('data-pet-long-task-cleanup="terminal"');
    expect(html).toContain("清理已结束（6）");
    expect(html).not.toContain('disabled=""');
  });

  test("offers an individual cleanup on every ended task state", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const ended = task(status);
      expect(isLongTaskClearable(ended)).toBe(true);
      const html = renderToStaticMarkup(
        <DialogProvider>
          <PetLongTaskCard
            task={ended}
            busy={false}
            onControl={() => {}}
            onClear={async () => true}
          />
        </DialogProvider>,
      );
      expect(html).toContain(`data-pet-long-task-clear="${ended.id}"`);
      expect(html).toContain("清理记录");
    }
    expect(isLongTaskClearable(task("running"))).toBe(false);
  });

  test("requires cancellation confirmation and runs cancel exactly once after approval", async () => {
    ensureMiniDom();
    const controls: Array<[string, string]> = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <DialogProvider>
          <PetLongTaskCard
            task={task("running")}
            busy={false}
            onControl={(taskId, action) => controls.push([taskId, action])}
          />
        </DialogProvider>,
      );
      await flushMicrotasks();
    });

    await act(async () => {
      reactPropsOf(controlButton(container, "cancel")).onClick();
      await flushMicrotasks();
    });
    expect(
      findElements(document.body, "BUTTON").map((button) =>
        childText(reactPropsOf(button).children),
      ),
    ).toContain("取消任务");
    await act(async () => {
      reactPropsOf(buttonWithLabel(document.body, "取消")).onClick();
      await flushMicrotasks();
    });
    expect(controls).toEqual([]);

    await act(async () => {
      reactPropsOf(controlButton(container, "cancel")).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(buttonWithLabel(document.body, "取消任务")).onClick();
      await flushMicrotasks();
    });
    expect(controls).toEqual([["pet-task-0123456789abcdef01234567", "cancel"]]);
  });

  test("runs pause, resume, and retry directly without opening confirmation", async () => {
    ensureMiniDom();
    const controls: Array<[string, string]> = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const render = async (status: PetLongTask["status"]): Promise<void> => {
      await act(async () => {
        root?.render(
          <DialogProvider>
            <PetLongTaskCard
              task={task(status)}
              busy={false}
              onControl={(taskId, action) => controls.push([taskId, action])}
            />
          </DialogProvider>,
        );
        await flushMicrotasks();
      });
    };

    await render("running");
    await act(async () => {
      reactPropsOf(controlButton(container, "pause")).onClick();
      await flushMicrotasks();
    });
    expect(buttonWithLabel(document.body, "取消任务")).toBeUndefined();

    await render("interrupted");
    for (const action of ["resume", "retry"] as const) {
      await act(async () => {
        reactPropsOf(controlButton(container, action)).onClick();
        await flushMicrotasks();
      });
      expect(buttonWithLabel(document.body, "取消任务")).toBeUndefined();
    }
    expect(controls).toEqual([
      ["pet-task-0123456789abcdef01234567", "pause"],
      ["pet-task-0123456789abcdef01234567", "resume"],
      ["pet-task-0123456789abcdef01234567", "retry"],
    ]);
  });
});
