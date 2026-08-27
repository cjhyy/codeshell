import { describe, expect, test } from "bun:test";
import type { WorkerFrameMeta } from "@cjhyy/code-shell-server/worker";
import type { AgentBridge } from "../agent-bridge.js";
import { prepareAgentRunMetadata } from "../agent-run-metadata.js";
import type { SessionCwdIndexEntry } from "../session-cwd-index.js";
import {
  handleClientEvent,
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
      expect.objectContaining({ type: "error", message: expect.stringContaining("does not match") }),
    );
    expect(harness.replies.some((event) => event.type === "chat.accepted")).toBe(false);
  });
});
