import { BrowserWindow, dialog, webContents } from "electron";
import {
  bypassConsequence,
  modeTakesEffect,
  type RoomModeApproval,
  type RoomModeRequester,
} from "./room-mode-authority.js";
type Decision = { approved: boolean; reason?: string };

export async function confirmOnDesktop(
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
