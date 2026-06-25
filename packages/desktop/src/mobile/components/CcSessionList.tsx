import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CcDiscoveredSession, PermissionMode } from "@protocol";
import { relativeTime } from "@mobile/lib/format";

/** External `claude` CLI sessions for the selected project — the phone-side
 *  mirror of the desktop CCRoomView. Discovery/probe come from the hook (server
 *  RPC), not window.codeshell (the phone has no Electron IPC). Opening reuses the
 *  resident-room machinery; the server applies resolveRoomPermissionMode so a
 *  non-trusted workspace stays "default" even though we request it here. */
export function CcSessionList({
  cwd,
  probe,
  sessions,
  loading,
  onOpen,
}: {
  cwd: string | null;
  probe: { available: boolean; reason?: string } | null;
  sessions: CcDiscoveredSession[];
  loading?: boolean;
  onOpen: (sessionId: string, cwd: string, mode: PermissionMode) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="mobile-side-header flex items-center gap-2 px-3 py-3">
        <div>
          <h2 className="text-sm font-semibold leading-5">CC 会话</h2>
          <p className="text-[11px] text-muted-foreground">外部 Claude Code 会话</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {!cwd ? (
          <p className="mobile-glass rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            先选择一个项目。
          </p>
        ) : probe === null ? (
          <p className="mobile-glass flex items-center justify-center gap-2 rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-status-running" />
            正在检测 Claude Code CLI…
          </p>
        ) : !probe.available ? (
          <p className="mobile-glass rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            未检测到 Claude Code CLI(需在桌面端机器的 PATH 中)。
          </p>
        ) : loading && sessions.length === 0 ? (
          <p className="mobile-glass flex items-center justify-center gap-2 rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-status-running" />
            正在加载 cc 会话…
          </p>
        ) : sessions.length === 0 ? (
          <p className="mobile-glass rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            该项目下没有 Claude Code 会话。
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {sessions.map((s) => (
              <li key={s.sessionId}>
                <button
                  type="button"
                  onClick={() => onOpen(s.sessionId, cwd, "default")}
                  className={cn("mobile-list-item flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left")}
                >
                  <span className="truncate text-sm font-medium text-foreground">
                    {s.firstMessage || s.sessionId}
                  </span>
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{s.messageCount} 条</span>
                    <span className="ml-auto shrink-0">{relativeTime(s.lastModified)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
