import { useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { CcDiscoveredSession, PermissionMode } from "@protocol";
import type { CcCliKind } from "@mobile/hooks/useRemoteApp";
import { relativeTime } from "@mobile/lib/format";
import { CcPermissionModeSheet } from "./CcPermissionModeSheet";

const CLI_LABEL: Record<CcCliKind, string> = { "claude-code": "Claude Code", codex: "Codex" };
const CLI_KINDS: CcCliKind[] = ["claude-code", "codex"];

/** External coding-CLI sessions for the selected project — the phone-side mirror
 *  of the desktop CCRoomView. A Claude Code / Codex segmented switch picks the
 *  CLI; discovery/probe come from the hook (server RPC), not window.codeshell
 *  (the phone has no Electron IPC). Opening reuses the resident-room machinery;
 *  the server applies resolveRoomPermissionMode so a non-trusted workspace stays
 *  "default" even though we request it here. Codex has no per-tool approval — the
 *  permission-mode sheet maps to its spawn-time sandbox tier (same as desktop). */
export function CcSessionList({
  cwd,
  probe,
  sessions,
  loading,
  cliKind,
  onCliKindChange,
  onOpen,
}: {
  cwd: string | null;
  probe: { available: boolean; reason?: string } | null;
  sessions: CcDiscoveredSession[];
  loading?: boolean;
  cliKind: CcCliKind;
  onCliKindChange: (kind: CcCliKind) => void;
  onOpen: (sessionId: string, cwd: string, mode: PermissionMode) => void;
}) {
  const label = CLI_LABEL[cliKind];
  // Tapping a session opens the permission-mode picker first (mirrors the desktop
  // CCRoomView flow), then onOpen with the chosen mode — instead of silently
  // hard-coding "default".
  const [picking, setPicking] = useState<{ sessionId: string; label: string } | null>(null);
  return (
    <div className="flex h-full flex-col">
      <div className="mobile-side-header flex flex-col gap-2 px-3 py-3">
        <div className="flex items-center gap-2">
          <div>
            <h2 className="text-sm font-semibold leading-5">CC 会话</h2>
            <p className="text-[11px] text-muted-foreground">外部 {label} 会话</p>
          </div>
        </div>
        <div className="flex gap-1.5">
          {CLI_KINDS.map((k) => (
            <Button
              key={k}
              size="sm"
              variant={cliKind === k ? "default" : "outline"}
              className="h-7 px-2.5 text-xs"
              onClick={() => onCliKindChange(k)}
            >
              {CLI_LABEL[k]}
            </Button>
          ))}
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
            正在检测 {label} CLI…
          </p>
        ) : !probe.available ? (
          <p className="mobile-glass rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            未检测到 {label} CLI(需在桌面端机器的 PATH 中)。
          </p>
        ) : loading && sessions.length === 0 ? (
          <p className="mobile-glass flex items-center justify-center gap-2 rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-status-running" />
            正在加载 cc 会话…
          </p>
        ) : sessions.length === 0 ? (
          <p className="mobile-glass rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            该项目下没有 {label} 会话。
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {sessions.map((s) => (
              <li key={s.sessionId}>
                <button
                  type="button"
                  onClick={() => setPicking({ sessionId: s.sessionId, label: s.firstMessage || s.sessionId })}
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
      {picking && cwd && (
        <CcPermissionModeSheet
          sessionLabel={picking.label}
          onPick={(mode) => {
            const sid = picking.sessionId;
            setPicking(null);
            onOpen(sid, cwd, mode);
          }}
          onCancel={() => setPicking(null)}
        />
      )}
    </div>
  );
}
