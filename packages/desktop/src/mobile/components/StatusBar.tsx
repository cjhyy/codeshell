import { cn } from "@/lib/utils";
import type { ConnStatus } from "@mobile/hooks/useRemoteSocket";
import type { RunState } from "@mobile/lib/streamReducer";

const CONN_LABEL: Record<ConnStatus, string> = {
  connecting: "连接中…",
  authenticating: "认证中…",
  unpaired: "未配对",
  online: "在线",
  offline: "已断开",
};

const RUN_LABEL: Record<RunState, string> = {
  idle: "空闲",
  running: "运行中",
  waiting: "待审批",
  completed: "已完成",
  error: "出错",
};

/** A status pip + label. When online, shows the run state; otherwise the
 *  connection state. Colors come from the shared status tokens. */
export function StatusBar({ conn, run }: { conn: ConnStatus; run: RunState }) {
  const online = conn === "online";
  const tone = !online
    ? conn === "offline" || conn === "unpaired"
      ? "err"
      : "running"
    : run === "running"
      ? "running"
      : run === "waiting"
        ? "warn"
        : run === "error"
          ? "err"
          : run === "completed"
            ? "ok"
            : "idle";
  const label = online ? RUN_LABEL[run] : CONN_LABEL[conn];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        "border-border bg-card text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "ok" && "bg-status-ok",
          tone === "running" && "animate-pulse bg-status-running",
          tone === "warn" && "bg-status-warn",
          tone === "err" && "bg-status-err",
          tone === "idle" && "bg-status-idle",
        )}
      />
      {label}
    </span>
  );
}
