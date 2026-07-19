import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PetLongTask } from "../../preload/types";
import { PetLongTaskCard } from "./PetLongTaskSection";

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
});
