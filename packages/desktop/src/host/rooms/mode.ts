import type { RoomManager } from "@cjhyy/code-shell-server/mobile-remote";
import type { ApprovalBridge } from "../../main/cc-room/approval-bridge.js";
import {
  RoomModeAuthority,
  requestRoomModeCard,
  trustedClaudeWorkspacesFromUserSettings,
  type RoomModeApproval,
  type RoomModeRequester,
} from "../../main/cc-room/room-mode-authority.js";
import { desktopRoomModeHostBoundary } from "../../main/cc-room/room-mode-host-boundary.js";
import { readSettings } from "../../main/settings-service.js";
import {
  parseExternalRuntimeModelKey,
  type ExternalRuntimeModelEntry,
} from "../../shared/external-runtime-models.js";
export function createRoomModeAuthority(deps: {
  roomManager: RoomManager;
  approvalBridge: Pick<ApprovalBridge, "request" | "respond">;
  confirm: (
    approval: RoomModeApproval,
    requester: RoomModeRequester,
    signal: AbortSignal,
  ) => Promise<{ approved: boolean; reason?: string }>;
  externalRuntimeModels?: () => Promise<ExternalRuntimeModelEntry[]>;
}): RoomModeAuthority {
  return new RoomModeAuthority({
    roomManager: deps.roomManager,
    validateModel: async (key, kind) => {
      const parsed = parseExternalRuntimeModelKey(key);
      if (
        !parsed?.model ||
        parsed.kind !== kind ||
        !((await deps.externalRuntimeModels?.()) ?? []).some(
          (entry) => entry.key === key && entry.kind === kind,
        )
      )
        throw new Error("该模型不在此电脑当前 CLI 的可用模型中，请刷新模型列表后重试。");
    },
    // Project roots, their subdirectories and registered linked worktrees
    // (realpath-checked), plus the CLI's own on-disk session identity.
    ...desktopRoomModeHostBoundary(),
    trustedClaudeWorkspaces: async () =>
      trustedClaudeWorkspacesFromUserSettings(await readSettings("user").catch(() => null)),
    requestApproval: (approval, requester, signal) =>
      requester.channel === "desktop"
        ? deps.confirm(approval, requester, signal)
        : requestRoomModeCard(deps.approvalBridge, approval, signal),
  });
}
