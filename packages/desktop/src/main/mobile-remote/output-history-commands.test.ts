import { expect, test } from "bun:test";
import type { MobileServerEvent } from "@cjhyy/code-shell-core";
import {
  handleOutputHistoryRecoveryCommand,
  type MobileOutputHistoryService,
} from "./output-history-commands.js";

function harness() {
  let authenticated = true;
  const replies: Array<{ viewer: string; event: MobileServerEvent }> = [];
  const calls: unknown[][] = [];
  const service: MobileOutputHistoryService = {
    async plan(...args) {
      calls.push(args);
      return {
        status: "ready",
        sessionId: args[0],
        planId: "owned-plan",
        historicalGap: true,
        notice: "historical_notifications_incomplete",
        comparison: { turns: 2, userInputs: 2, toolCalls: 1, toolResults: 1 },
      };
    },
    async apply(...args) {
      calls.push(args);
      return { status: "applied", sessionId: args[0], historicalGap: true };
    },
  };
  const remote = {
    hasAuthenticatedViewer: (viewer: string, device: string) =>
      authenticated && viewer === "tab-a" && device === "phone",
    sendToViewer: (viewer: string, event: MobileServerEvent) => {
      replies.push({ viewer, event });
      return true;
    },
  };
  return {
    service,
    remote,
    replies,
    calls,
    revoke: () => {
      authenticated = false;
    },
  };
}
const request = {
  type: "session.outputRecovery.plan" as const,
  sessionId: "session-a",
  requestId: "review-a",
  viewerId: "tab-a",
  deviceId: "phone",
};

test("a review uses only the authenticated requesting tab and a Host-created caller", async () => {
  const f = harness();
  await handleOutputHistoryRecoveryCommand(f, {
    ...request,
    caller: { kind: "desktop", webContentsId: 999 },
  } as typeof request);
  expect(f.calls).toEqual([
    ["session-a", { kind: "mobile", viewerId: "tab-a", deviceId: "phone" }],
  ]);
  expect(f.replies).toHaveLength(1);
  expect(f.replies[0]!.viewer).toBe("tab-a");
  expect(f.replies[0]!.event).toMatchObject({
    type: request.type,
    sessionId: "session-a",
    requestId: "review-a",
    result: { status: "ready" },
  });
});

test.each([
  { viewerId: undefined },
  { deviceId: undefined },
  { viewerId: "tab-b" },
  { deviceId: "other-device" },
])("an unbound recovery request cannot invoke storage: %j", async (change) => {
  const f = harness();
  await handleOutputHistoryRecoveryCommand(f, { ...request, ...change });
  expect(f.calls).toHaveLength(0);
  expect(f.replies).toHaveLength(0);
});

test("revocation while a plan awaits prevents a late private reply", async () => {
  const f = harness();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.service.plan = async (sessionId) => {
    await wait;
    return { status: "blocked", sessionId, reason: "busy" };
  };
  const pending = handleOutputHistoryRecoveryCommand(f, request);
  f.revoke();
  release();
  await pending;
  expect(f.replies).toHaveLength(0);
});

test("an application keeps its explicit acceptance and request correlation", async () => {
  const f = harness();
  await handleOutputHistoryRecoveryCommand(f, {
    ...request,
    type: "session.outputRecovery.apply",
    requestId: "apply-a",
    planId: "owned-plan",
    acceptHistoricalGap: true,
  });
  expect(f.calls).toEqual([
    [
      "session-a",
      { planId: "owned-plan", acceptHistoricalGap: true },
      { kind: "mobile", viewerId: "tab-a", deviceId: "phone" },
    ],
  ]);
  expect(f.replies[0]!.event).toMatchObject({
    type: "session.outputRecovery.apply",
    requestId: "apply-a",
    result: { status: "applied", sessionId: "session-a" },
  });
});

test("the boundary never upgrades a false confirmation to an acceptance", async () => {
  const f = harness();
  await handleOutputHistoryRecoveryCommand(f, {
    ...request,
    type: "session.outputRecovery.apply",
    planId: "owned-plan",
    acceptHistoricalGap: false,
  } as never);
  expect(f.calls).toHaveLength(0);
  expect(f.replies[0]!.event).toMatchObject({
    result: { status: "blocked", reason: "confirmation_required" },
  });
});

test("missing services, exceptions and mismatched results are bounded failures", async () => {
  const f = harness();
  await handleOutputHistoryRecoveryCommand({ remote: f.remote }, request);
  expect(f.replies.pop()!.event).toMatchObject({
    result: { status: "blocked", reason: "unavailable" },
  });
  f.service.plan = async () => {
    throw new Error("private path must not escape");
  };
  await handleOutputHistoryRecoveryCommand(f, request);
  expect(f.replies.pop()!.event).toMatchObject({
    result: { status: "blocked", reason: "storage_error" },
  });
  f.service.plan = async () => ({ status: "blocked", sessionId: "other-session", reason: "busy" });
  await handleOutputHistoryRecoveryCommand(f, request);
  expect(f.replies.pop()!.event).toMatchObject({
    result: { sessionId: "session-a", reason: "storage_error" },
  });
});
