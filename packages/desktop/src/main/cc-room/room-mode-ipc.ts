import { BrowserWindow, dialog, webContents, type IpcMain } from "electron";
import type { RoomManager, RoomMeta, RoomPublic } from "@cjhyy/code-shell-server/mobile-remote";
import type { ApprovalBridge } from "./approval-bridge.js";
import {
  bypassConsequence,
  modeTakesEffect,
  RoomModeAuthority,
  requestRoomModeCard,
  trustedClaudeWorkspacesFromUserSettings,
  type RoomModeApproval,
  type RoomModeRequester,
} from "./room-mode-authority.js";
import { readSettings } from "../settings-service.js";
import { requireRendererProjectPath } from "../renderer-project-path.js";
import { desktopRoomModeHostBoundary } from "./room-mode-host-boundary.js";

type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";
type Decision = { approved: boolean; reason?: string };

/**
 * Desktop Main's room permission-mode authority. bypassPermissions outside the
 * user-scope Claude Code allowlist needs a one-time high-risk approval minted
 * here: the existing room approval card for a paired phone, and a native
 * dialog on the requesting Desktop window.
 */
export function createDesktopRoomModeAuthority(deps: {
  roomManager: RoomManager;
  approvalBridge: Pick<ApprovalBridge, "request" | "respond">;
}): RoomModeAuthority {
  return new RoomModeAuthority({
    roomManager: deps.roomManager,
    // Project roots, their subdirectories and registered linked worktrees
    // (realpath-checked), plus the CLI's own on-disk session identity.
    ...desktopRoomModeHostBoundary(),
    trustedClaudeWorkspaces: async () =>
      trustedClaudeWorkspacesFromUserSettings(await readSettings("user").catch(() => null)),
    requestApproval: (approval, requester, signal) =>
      requester.channel === "desktop"
        ? confirmOnDesktop(approval, requester, signal)
        : requestRoomModeCard(deps.approvalBridge, approval, signal),
  });
}

async function confirmOnDesktop(
  approval: RoomModeApproval,
  requester: RoomModeRequester,
  signal: AbortSignal,
): Promise<Decision> {
  const contents =
    requester.ownerWebContentsId !== undefined
      ? webContents.fromId(requester.ownerWebContentsId)
      : undefined;
  const owner =
    contents && !contents.isDestroyed() ? BrowserWindow.fromWebContents(contents) : null;
  if (!owner || owner.isDestroyed()) throw new Error("发起请求的桌面窗口已关闭");
  const label = approval.kind === "codex" ? "Codex" : "Claude Code";
  const { response } = await dialog.showMessageBox(owner, {
    type: "warning",
    buttons: ["保持原模式", "批准全放行"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "切换为全放行（高风险）",
    message: `允许这个 ${label} 会话以全放行模式运行吗？`,
    detail: [
      bypassConsequence(approval.kind),
      `目录：${approval.cwd}`,
      `会话：${approval.sessionId}`,
      `当前模式：${approval.fromMode ?? "（新打开）"}`,
      modeTakesEffect(approval.kind),
    ].join("\n"),
    signal,
  });
  return response === 1 ? { approved: true } : { approved: false, reason: "已拒绝" };
}

/**
 * The two Desktop routes that choose a room's mode. Both go through the same
 * Host authority as the paired phone, so neither can start bypass without it.
 */
export function registerRoomModeIpc(deps: {
  ipcMain: Pick<IpcMain, "handle">;
  roomManager: Pick<RoomManager, "createRoom">;
  roomModes: RoomModeAuthority;
  roomToPublic: (room: RoomMeta) => RoomPublic;
  broadcastRoomState: (roomId: string) => void;
}): void {
  const { ipcMain, roomManager, roomModes } = deps;
  ipcMain.handle(
    "rooms:create",
    async (
      _e,
      input: {
        name?: string;
        cwd: string;
        kind?: "claude-code" | "codex";
        permissionMode?: PermissionMode;
      },
    ) => {
      const cwd = await requireRendererProjectPath(input?.cwd);
      if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 512)) {
        throw new Error("invalid room name");
      }
      const kind = input.kind ?? "claude-code";
      // Explicit bypass outside the Host allowlist is refused, never downgraded.
      const decided = await roomModes.resolveCreateMode(kind, cwd, input.permissionMode);
      const room = roomManager.createRoom({
        name: input.name,
        cwd,
        kind,
        permissionMode: decided.mode,
      });
      if (decided.trustedBypass) roomModes.grantTrusted(room.id, room.cwd, room.kind);
      return deps.roomToPublic(room);
    },
  );
  ipcMain.handle(
    "ccRoom:openSession",
    async (
      e,
      claudeSessionId: string,
      cwd: string,
      mode: PermissionMode,
      kind?: "claude-code" | "codex",
    ) => {
      if (typeof claudeSessionId !== "string" || !claudeSessionId)
        throw new Error("CLI session id is required");
      if (mode !== "default" && mode !== "acceptEdits" && mode !== "bypassPermissions")
        throw new Error("invalid permission mode");
      if (kind !== undefined && kind !== "claude-code" && kind !== "codex")
        throw new Error("invalid CLI kind");
      const sender = e.sender;
      const result = await roomModes.openSession({
        sessionId: claudeSessionId,
        cwd,
        kind: kind ?? "claude-code",
        mode,
        requester: {
          key: `desktop:${sender.id}`,
          channel: "desktop",
          ownerWebContentsId: sender.id,
          assertCurrent: () => {
            if (sender.isDestroyed()) throw new Error("requester window closed");
          },
        },
      });
      if (result.changed) deps.broadcastRoomState(result.roomId);
      return { roomId: result.roomId, status: result.status, permissionMode: result.mode };
    },
  );
}
