import { expect, test } from "bun:test";
import { ChatSession, type TurnOpts } from "./chat-session.js";
import type { Engine } from "../engine/engine.js";

test("follow-up options preserve turn authority without replaying one-time input or goal state", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const engine = {
    async run() {
      await gate;
      return {
        text: "done",
        reason: "completed",
        sessionId: "follow-up",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
  const session = new ChatSession({ id: "follow-up", engine });
  const opts: TurnOpts = {
    cwd: "/workspace",
    workspaceContext: {
      version: 1,
      projectId: "p",
      projectRevision: 1,
      sessionMainRootId: "root",
      rootsDigest: "digest",
      roots: [{ id: "root", path: "/workspace", role: "primary" }],
    },
    permissionMode: "plan",
    planMode: true,
    behaviorMode: "isolatedTask",
    toolAllowlist: ["Read"],
    skillAllowlist: [],
    ephemeral: true,
    profileParams: { runtimeContext: "closed scope" },
    workspaceProfile: "writer",
    sessionMessageTargets: [{ sessionId: "target", title: "Target", workspaceRoot: "/workspace" }],
    kind: "work",
    approvalRouter: {} as NonNullable<TurnOpts["approvalRouter"]>,
    disableGoal: true,
    goal: { objective: "must not restart" },
    clientMessageId: "original",
    displayText: "original input",
    attachments: [],
    archiveBeforeCurrentTurn: { segmentId: "old-segment" },
    injected: true,
    onStream() {},
  };
  expect(session.captureFollowUpOptions()).toEqual({});
  const running = session.enqueueTurn("work", opts);
  const captured = session.captureFollowUpOptions();
  expect(captured).toMatchObject({
    cwd: "/workspace",
    permissionMode: "plan",
    planMode: true,
    behaviorMode: "isolatedTask",
    toolAllowlist: ["Read"],
    skillAllowlist: [],
    ephemeral: true,
    profileParams: { runtimeContext: "closed scope" },
    workspaceProfile: "writer",
    kind: "work",
    disableGoal: true,
  });
  expect(captured.approvalRouter).toBe(opts.approvalRouter);
  expect(captured.workspaceContext).not.toBe(opts.workspaceContext);
  expect(captured.workspaceContext!.roots[0]).not.toBe(opts.workspaceContext!.roots[0]);
  expect(captured.sessionMessageTargets![0]).not.toBe(opts.sessionMessageTargets![0]);
  expect(captured.toolAllowlist).not.toBe(opts.toolAllowlist);
  expect(captured.skillAllowlist).not.toBe(opts.skillAllowlist);
  for (const field of [
    "goal",
    "clientMessageId",
    "displayText",
    "attachments",
    "archiveBeforeCurrentTurn",
    "injected",
    "onStream",
  ]) {
    expect(captured).not.toHaveProperty(field);
  }
  release();
  await running;
  expect(session.captureFollowUpOptions()).toEqual({});
});

test("cancellation epoch only advances for effective scoped Stop and survives a new turn", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const engine = {
    async run(task: string) {
      if (task === "first") await gate;
      return {
        text: "done",
        reason: "completed",
        sessionId: "follow-up",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
  const session = new ChatSession({ id: "follow-up", engine });
  const first = session.enqueueTurn("first", { clientMessageId: "first" });
  expect(session.cancellationEpoch).toBe(0);
  expect(session.cancelActiveTurn("stale")).toBe(false);
  expect(session.cancellationEpoch).toBe(0);
  expect(session.cancelActiveTurn("first")).toBe(true);
  expect(session.cancellationEpoch).toBe(1);
  release();
  await first;
  await session.enqueueTurn("second", {});
  expect(session.wasCancelledSinceLastTurn()).toBe(false);
  expect(session.cancellationEpoch).toBe(1);
  session.cancel();
  expect(session.cancellationEpoch).toBe(2);
});
