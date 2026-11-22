import { join } from "node:path";
import { CC_COST_GUARD_PROMPT } from "@cjhyy/code-shell-capability-coding/orchestration";
import {
  CodexRoomAgent,
  ResidentAgentProcess,
  roomProcessLauncher,
  RoomManager,
  type MobileServerEvent,
  type RoomMeta,
  type RoomPublic,
} from "@cjhyy/code-shell-server/mobile-remote";
import { publishRoomEnded } from "../../main/mobile-remote/lifecycle.js";
import { ApprovalBridge } from "../../main/cc-room/approval-bridge.js";
import { assertExternalSessionIdle } from "../../main/cc-room/background-work-ipc.js";
import { resolveLinkedSessionFromDisk } from "../../main/cc-room/linked-session-resolver.js";
import { createRoomTranscriptSubscriptions } from "../../main/cc-room/transcript-subscriptions.js";
import { parseExternalRuntimeModelKey } from "../../shared/external-runtime-models.js";
import { createRoomModeAuthority } from "./mode.js";
import { canonicalRoomDirectory } from "../../main/cc-room/room-mode-authority.js";

type AgentFactory = ConstructorParameters<typeof RoomManager>[0]["createAgent"];
type ModeSources = Pick<
  Parameters<typeof createRoomModeAuthority>[0],
  "confirm" | "externalRuntimeModels"
>;
export type RoomRuntimeEvent =
  | Extract<
      MobileServerEvent,
      {
        type:
          | "room.message"
          | "room.list.ok"
          | "room.closed"
          | "room.recovery"
          | "ccRoom.approvalRequest"
          | "ccRoom.approvalResolved";
      }
    >
  | { type: "room.changed"; room: RoomPublic };

export function createOwnedRooms(
  options: ModeSources & {
    directory: string;
    sessions: string;
    emit(event: RoomRuntimeEvent): void;
    createAgent?: AgentFactory;
  },
) {
  const { emit } = options;
  const approvals = new ApprovalBridge({
    onPush: (roomId, req) => emit({ type: "ccRoom.approvalRequest", roomId, req }),
    onResolve: (roomId, requestId, decision) =>
      emit({ type: "ccRoom.approvalResolved", roomId, requestId, decision }),
  });
  const createAgent: AgentFactory = (room, onEvent) => {
    const launch = roomProcessLauncher(join(options.directory, "room-processes"), [
      "room:" + room.id,
      ...(room.claudeSessionId ? [JSON.stringify([room.kind, room.claudeSessionId])] : []),
    ]);
    const agentOptions = {
      launch,
      cwd: room.cwd,
      permissionMode: room.permissionMode,
      model: parseExternalRuntimeModelKey(room.modelKey)?.model,
      onEvent,
    };
    return room.kind === "codex"
      ? new CodexRoomAgent({
          ...agentOptions,
          command: "codex",
          resumeThreadId: room.claudeSessionId,
          onThreadId: (id) => manager.setRoomSessionId(room.id, id),
        })
      : new ResidentAgentProcess({
          ...agentOptions,
          command: "claude",
          resumeSessionId: room.claudeSessionId,
          appendSystemPrompt: CC_COST_GUARD_PROMPT,
        });
  };
  const manager: RoomManager = new RoomManager({
    rootDir: join(options.directory, "rooms"),
    modelTracing: {
      storageDir: join(options.sessions, ".model-traces"),
      parameters: (room) =>
        room.kind === "codex" ? {} : { appendSystemPrompt: CC_COST_GUARD_PROMPT },
    },
    resolveLinkedSession: resolveLinkedSessionFromDisk,
    assertExternalSessionAvailable: assertExternalSessionIdle,
    authorizeStart: (room) => modes.authorizeStart(room),
    onRoomClosed: (roomId) => modes.revoke(roomId),
    onRoomStateChanged: (roomId) => changed(roomId),
    createAgent: options.createAgent ?? createAgent,
    onMessage: (roomId, msg) => emit({ type: "room.message", roomId, msg }),
    onApprovalRequest: (roomId, event) => {
      const { toolName, displayName, input, description, askUser } = event;
      void approvals
        .request(roomId, event.requestId, { toolName, displayName, input, description, askUser })
        .then((decision) => manager.respondApproval(roomId, event.requestId, decision));
    },
    onRoomEnded: (roomId) =>
      publishRoomEnded({ approvals, transcripts, remote: { broadcast: emit } }, roomId),
  });
  const modes = createRoomModeAuthority({
    ...options,
    roomManager: manager,
    approvalBridge: approvals,
  });
  const transcripts = createRoomTranscriptSubscriptions({
    roomManager: manager,
    checkpointDir: join(options.directory, "transcript-checkpoints"),
    broadcast: emit,
  });
  function publicRoom(room: RoomMeta): RoomPublic {
    return {
      ...room,
      modelKey: room.modelKey ?? null,
      open: manager.isOpen(room.id),
      observing: room.linkedSessionMode === "observe-only",
      ...(room.claudeSessionId ? { sessionId: room.claudeSessionId } : {}),
    };
  }
  function changed(id: string) {
    emit({ type: "room.list.ok", rooms: manager.listRooms().map(publicRoom) });
    const room = manager.getRoom(id);
    if (room) emit({ type: "room.changed", room: publicRoom(room) });
  }
  function matches(roomId: string, cwd: string, sessionId: string, kind: RoomMeta["kind"]) {
    const room = manager.getRoom(roomId);
    return (
      !!room &&
      canonicalRoomDirectory(room.cwd) === canonicalRoomDirectory(cwd) &&
      room.claudeSessionId === sessionId &&
      room.kind === kind
    );
  }
  return { manager, modes, approvals, transcripts, publicRoom, changed, matches };
}
