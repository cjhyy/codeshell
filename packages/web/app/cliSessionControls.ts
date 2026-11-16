import type { RemoteApp } from "../src/hooks/useRemoteApp.js";

/** One gate for both room settings; the Host remains the authority on changes. */
export function cliSessionControlBlock(app: RemoteApp): string | undefined {
  if (app.status !== "online") return "连接电脑后可调整。";
  const room = app.activeRoom;
  if (!room) return "正在读取会话设置…";
  if (room.observing) return "此会话在电脑上运行，当前仅可查看。";
  if (app.outputHistoryFailed) return "恢复会话记录后可调整。";
  if (app.ccModeRequest?.switching)
    return app.ccModeRequest.modelKey !== undefined
      ? "正在切换模型，等待电脑确认…"
      : "正在切换权限，等待电脑确认…";
  if (app.loading.roomHistory) return "正在读取会话记录…";
  if (app.approvals.some((approval) => approval.roomId === room.id && !approval.asynchronous))
    return "先处理待确认的操作，再调整模型或权限。";
  if (app.chat.run === "running") return "任务完成或停止后可调整模型和权限。";
  const queued = app.turnQueue?.entries.length ?? 0;
  if (queued) return `有 ${queued} 条排队消息，执行完或取消后可调整。`;
  return undefined;
}
