import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PetLongTask } from "../../preload/types";
import { DialogProvider } from "../ui/DialogProvider";
import {
  isLongTaskDetailCollapsible,
  isLongTaskClearable,
  PetLongTaskBulkCleanupButton,
  PetLongTaskCard,
} from "./PetLongTaskSection";

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
    const html = renderToStaticMarkup(
      <PetLongTaskCard task={task("running")} busy={false} onControl={() => {}} />,
    );
    expect(html).toContain("Finish and verify the cross-workspace migration");
    expect(html).toContain("Halfway through verification");
    expect(html).toContain("Work session");
    expect(html).toContain('data-pet-long-task-control="pause"');
    expect(html).toContain('data-pet-long-task-control="cancel"');
  });

  test("makes interrupted tasks explicitly resumable and retryable", () => {
    const html = renderToStaticMarkup(
      <PetLongTaskCard task={task("interrupted")} busy={false} onControl={() => {}} />,
    );
    expect(html).toContain('data-pet-long-task-control="resume"');
    expect(html).toContain('data-pet-long-task-control="retry"');
  });

  test("renders markdown and collapses a long result by default", () => {
    const completed = task("completed");
    completed.summary =
      "## 结论\n\n- 根因在 **JPEG 探针**\n- 调用 `probeJpeg()`\n\n" + "详细调查结果。".repeat(80);

    const html = renderToStaticMarkup(
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
    const html = renderToStaticMarkup(
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
});
