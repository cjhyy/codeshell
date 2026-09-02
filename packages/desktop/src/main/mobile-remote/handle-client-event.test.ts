import { describe, expect, test } from "bun:test";
import type { WorkerFrameMeta } from "@cjhyy/code-shell-server/worker";
import type { AgentBridge } from "../agent-bridge.js";
import { prepareAgentRunMetadata } from "../agent-run-metadata.js";
import type { SessionCwdIndexEntry } from "../session-cwd-index.js";
import {
  agentRunTimeoutMs,
  handleClientEvent,
  injectAndAwaitResult,
  type OrchestratorCtx,
} from "./handle-client-event.js";

type OutboundListener = (line: string) => void;

function createHarness(options: {
  requestedWorkspaceRoot: string;
  lookupSession: (refresh: boolean) => SessionCwdIndexEntry | undefined;
}) {
  const outbound = new Set<OutboundListener>();
  const replies: Array<Record<string, unknown>> = [];
  const preparedRuns: Array<Record<string, unknown>> = [];
  const metas: WorkerFrameMeta[] = [];

  const emit = (message: Record<string, unknown>): void => {
    const line = JSON.stringify(message);
    for (const listener of outbound) listener(line);
  };
  const bridge = {
    getLastRunContext: () => ({}),
    subscribeOutbound: (listener: OutboundListener) => {
      outbound.add(listener);
      return () => outbound.delete(listener);
    },
    injectWorkerMessage: (line: string, meta: WorkerFrameMeta) => {
      metas.push(meta);
      const request = JSON.parse(line) as { id: string };
      try {
        const prepared = prepareAgentRunMetadata(line, meta, {
          isProjectTrusted: () => true,
          lookupSession: (_sessionId, refresh) => options.lookupSession(refresh),
          isNoRepoCwd: () => false,
        });
        preparedRuns.push(JSON.parse(prepared.outLine).params as Record<string, unknown>);
        queueMicrotask(() =>
          emit({ method: "agent/runAccepted", params: { requestId: request.id } }),
        );
      } catch (error) {
        queueMicrotask(() =>
          emit({
            id: request.id,
            error: {
              code: -32602,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
      }
    },
  } as unknown as AgentBridge;

  const state = {
    selectedSessionId: "session-1",
    selectedCwd: "/primary",
  };
  const ctx = {
    remote: {
      sendToDevice: (_deviceId: string, event: Record<string, unknown>) => replies.push(event),
      broadcast: (event: Record<string, unknown>) => replies.push(event),
    },
    uploads: {
      claim: () => {
        throw new Error("unexpected upload claim");
      },
      release: async () => undefined,
      finalize: async () => undefined,
    },
    getBridge: () => bridge,
    mobileSessionCwds: new Map(),
    mobilePermissionModes: new Map(),
    deviceState: () => state,
    ensureMobileSessionId: () => "session-1",
    lookupDiskSessionCwd: async () => undefined,
    effectiveMobileRunCwd: () => "/primary",
    validateMobileSessionCwd: async () => true,
    resolveSessionWorkspaceRoot: async () => options.requestedWorkspaceRoot,
    sendMobilePermissionMode: () => undefined,
    sendSelectedMobilePermissionModes: () => undefined,
    replayPendingMobileApprovals: () => undefined,
    broadcastDesktopPermissionMode: () => undefined,
    broadcastMobileSession: () => undefined,
    broadcastApprovalResolved: () => undefined,
    settleMobileUploadClaims: async () => undefined,
  } as unknown as OrchestratorCtx;

  return { ctx, metas, preparedRuns, replies };
}

async function sendChat(ctx: OrchestratorCtx): Promise<void> {
  await handleClientEvent(ctx, {
    type: "chat.send",
    deviceId: "phone-1",
    sessionId: "session-1",
    text: "continue",
  });
}

describe("mobile existing-session workspace authorization", () => {
  test("continues a worktree Session using its resolved workspace root", async () => {
    const harness = createHarness({
      requestedWorkspaceRoot: "/worktree",
      lookupSession: () => ({
        sessionId: "session-1",
        cwd: "/primary",
        workspaceRoot: "/worktree",
        status: "confirmed",
      }),
    });

    await sendChat(harness.ctx);

    expect(harness.preparedRuns).toHaveLength(1);
    expect(harness.preparedRuns[0]?.cwd).toBe("/worktree");
    expect(harness.metas).toEqual([{ origin: "mobile", producer: "mobile-chat" }]);
    expect(harness.replies.some((event) => event.type === "chat.accepted")).toBe(true);
  });

  test("refreshes one stale index entry and accepts the new worktree root", async () => {
    let refreshes = 0;
    const harness = createHarness({
      requestedWorkspaceRoot: "/worktree-new",
      lookupSession: (refresh) => {
        if (refresh) refreshes += 1;
        return {
          sessionId: "session-1",
          cwd: "/primary",
          workspaceRoot: refresh ? "/worktree-new" : "/worktree-old",
          status: "confirmed",
        };
      },
    });

    await sendChat(harness.ctx);

    expect(refreshes).toBe(1);
    expect(harness.preparedRuns[0]?.cwd).toBe("/worktree-new");
    expect(harness.replies.some((event) => event.type === "chat.accepted")).toBe(true);
  });

  test("rejects when both cached and refreshed Session roots mismatch", async () => {
    let refreshes = 0;
    const harness = createHarness({
      requestedWorkspaceRoot: "/forged",
      lookupSession: (refresh) => {
        if (refresh) refreshes += 1;
        return {
          sessionId: "session-1",
          cwd: "/primary",
          workspaceRoot: refresh ? "/worktree-disk" : "/worktree-old",
          status: "confirmed",
        };
      },
    });

    await sendChat(harness.ctx);

    expect(refreshes).toBe(1);
    expect(harness.preparedRuns).toHaveLength(0);
    expect(harness.replies).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("does not match"),
      }),
    );
    expect(harness.replies.some((event) => event.type === "chat.accepted")).toBe(false);
  });
});

describe("injectAndAwaitResult timeouts", () => {
  /** A bridge whose worker never answers, so only the timeout can settle. */
  function silentBridge() {
    const injected: string[] = [];
    return {
      injected,
      bridge: {
        subscribeOutbound: () => () => undefined,
        injectWorkerMessage: (line: string) => {
          injected.push(line);
        },
      } as unknown as AgentBridge,
    };
  }

  const meta: WorkerFrameMeta = { origin: "host", producer: "test" };

  test("gives a full agent turn far longer than a control op before declaring no response", async () => {
    // agent/run drives a whole Mimi turn (delegate + describe + inference).
    // The old blanket 5s killed live turns and surfaced them to the user as
    // "worker did not respond", so it must get a turn-scale budget.
    expect(agentRunTimeoutMs("agent/run")).toBeGreaterThanOrEqual(120_000);
    // Control ops stay snappy: the phone should not spin for two minutes on a
    // bad model name.
    expect(agentRunTimeoutMs("agent/configure")).toBeLessThanOrEqual(15_000);
    expect(agentRunTimeoutMs("agent/goalExtend")).toBeLessThanOrEqual(15_000);
  });

  test("still reports a non-answering worker once its budget elapses", async () => {
    const { bridge, injected } = silentBridge();
    const result = await injectAndAwaitResult(bridge, "agent/configure", { model: "x" }, meta, 20);
    expect(result).toEqual({ ok: false, message: "worker did not respond" });
    expect(injected).toHaveLength(1);
  });
});
