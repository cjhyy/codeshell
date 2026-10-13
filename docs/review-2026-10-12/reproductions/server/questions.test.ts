import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomManager } from "../../../../packages/server/src/mobile-remote/room-manager.ts";

test("review reproduction: one multi-question request consumes approval with only the first answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-review-questions-"));
  let emit: any;
  const approvals: any[] = [];
  const controls: any[] = [];
  const manager = new RoomManager({
    rootDir: dir,
    createAgent: (_room, callback) => {
      emit = callback;
      return {
        start() {},
        send: () => true,
        isRunning: () => true,
        stop() {},
        respondControl: (id, decision) => controls.push({ id, decision }),
      };
    },
    onMessage() {},
    onApprovalRequest: (_id, request) => approvals.push(request),
  });
  try {
    const room = manager.createRoom({ cwd: dir });
    manager.open(room.id);
    const input = {
      questions: [
        { question: "Which language?", options: [{ label: "TypeScript" }, { label: "Python" }] },
        { question: "Which framework?", options: [{ label: "React" }, { label: "Vue" }] },
      ],
    };
    emit({
      type: "approval_request",
      requestId: "multi-question",
      toolName: "AskUserQuestion",
      input,
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0].askUser.question).toBe("Which language?");
    expect(
      manager.respondApproval(room.id, "multi-question", {
        behavior: "allow",
        answer: "TypeScript",
      }),
    ).toBe(true);
    expect(controls[0].decision.updatedInput.questions).toHaveLength(2);
    expect(controls[0].decision.updatedInput.answers).toEqual({ "Which language?": "TypeScript" });
    expect(controls[0].decision.updatedInput.answers["Which framework?"]).toBeUndefined();
    expect(
      manager.respondApproval(room.id, "multi-question", { behavior: "allow", answer: "React" }),
    ).toBe(false);
    console.info(
      "Confirmed: approval is consumed after first question; second question is neither surfaced nor answerable.",
    );
  } finally {
    manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
