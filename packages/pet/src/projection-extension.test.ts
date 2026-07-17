import { describe, expect, test } from "bun:test";
import type {
  ExtensionQueryHandler,
  ProtocolLiveSession,
  ProtocolObserverHost,
} from "@cjhyy/code-shell-core/extension";
import { createPetProjectionObserver, PET_HIDDEN_SESSION_KINDS } from "./projection-extension.js";
import {
  GET_PET_PROJECTION_SNAPSHOT_METHOD,
  PET_PROJECTION_DELTA_METHOD,
  type PetProjectionDelta,
  type PetProjectionSnapshotResult,
} from "./protocol.js";

describe("Pet projection observer", () => {
  test("drops closed session state before the same id is attached again", async () => {
    let liveSessions: ProtocolLiveSession[] = [
      {
        sessionId: "work-a",
        busy: true,
        queueDepth: 0,
        lastActivityAt: 100,
        kind: "work",
      },
    ];
    let snapshotQuery: ExtensionQueryHandler | undefined;
    const host: ProtocolObserverHost = {
      getLiveSessionSnapshot: () => liveSessions,
      projectionGeneration: () => 1,
      getSessionKind: () => "work",
      isTransportDisconnected: () => false,
      notify: () => {},
      registerQuery: (method, handler) => {
        if (method === GET_PET_PROJECTION_SNAPSHOT_METHOD) snapshotQuery = handler;
      },
    };
    const observer = createPetProjectionObserver(host);

    observer.onSessionAttached?.("work-a", 100);
    observer.onSessionStream?.("work-a", {
      type: "tool_use_start",
      toolCall: { id: "tool-1", toolName: "Bash", args: {} },
    });
    const before = (await snapshotQuery?.({})) as PetProjectionSnapshotResult;
    expect(before.sessions[0]).toMatchObject({ phase: "tool", summary: "正在运行 Bash" });

    liveSessions = [];
    observer.onSessionClosed?.("work-a");
    liveSessions = [
      {
        sessionId: "work-a",
        busy: false,
        queueDepth: 0,
        lastActivityAt: 300,
        kind: "work",
      },
    ];
    observer.onSessionAttached?.("work-a", 300);

    const after = (await snapshotQuery?.({})) as PetProjectionSnapshotResult;
    expect(after.sessions[0]).toMatchObject({
      agentSessionId: "work-a",
      runState: "idle",
      pendingDecisionCount: 0,
    });
    expect(after.sessions[0]?.phase).toBeUndefined();
    expect(after.sessions[0]?.summary).toBeUndefined();
  });

  test("declares only the durable Pet session kind as hidden", () => {
    expect(PET_HIDDEN_SESSION_KINDS).toEqual(["pet"]);
  });

  test("preserves the indexed terminal when the host becomes idle at turn completion", async () => {
    const liveSessions: ProtocolLiveSession[] = [
      {
        sessionId: "work-a",
        busy: true,
        queueDepth: 0,
        lastActivityAt: 100,
        kind: "work",
      },
    ];
    let snapshotQuery: ExtensionQueryHandler | undefined;
    const deltas: PetProjectionDelta[] = [];
    const host: ProtocolObserverHost = {
      getLiveSessionSnapshot: () => liveSessions,
      projectionGeneration: () => 1,
      getSessionKind: () => "work",
      isTransportDisconnected: () => false,
      notify: (method, payload) => {
        if (method === PET_PROJECTION_DELTA_METHOD) {
          deltas.push(payload as unknown as PetProjectionDelta);
        }
      },
      registerQuery: (method, handler) => {
        if (method === GET_PET_PROJECTION_SNAPSHOT_METHOD) snapshotQuery = handler;
      },
    };
    const observer = createPetProjectionObserver(host);
    observer.onSessionAttached?.("work-a", 100);

    liveSessions[0] = { ...liveSessions[0]!, busy: false, lastActivityAt: 190 };
    observer.onSessionStream?.("work-a", {
      type: "turn_complete",
      reason: "completed",
    });

    const finalDelta = deltas.at(-1);
    expect(finalDelta).toMatchObject({
      kind: "session-upsert",
      session: {
        runState: "terminal",
        phase: "finalizing",
        terminal: { status: "completed" },
      },
    });
    const terminalAt =
      finalDelta?.kind === "session-upsert" ? finalDelta.session.terminal?.at : undefined;
    expect(terminalAt).toBeNumber();
    const snapshot = (await snapshotQuery?.({})) as PetProjectionSnapshotResult;
    expect(snapshot.sessions[0]).toMatchObject({
      runState: "terminal",
      phase: "finalizing",
      lastActivityAt: terminalAt,
      terminal: { status: "completed", at: terminalAt },
    });

    liveSessions[0] = {
      ...liveSessions[0]!,
      busy: true,
      lastActivityAt: (terminalAt ?? 200) + 1,
    };
    observer.onSessionStream?.("work-a", {
      type: "stream_request_start",
      turnNumber: 2,
    });
    expect(deltas.at(-1)).toMatchObject({
      kind: "session-upsert",
      session: {
        runState: "running",
        phase: "model",
        terminal: undefined,
      },
    });
  });
});
