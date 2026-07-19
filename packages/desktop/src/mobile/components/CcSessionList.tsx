import { useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import type { CcDiscoveredSession, PermissionMode } from "@protocol";
import type { CcCliKind } from "@cjhyy/code-shell-web";
import { relativeTime } from "@cjhyy/code-shell-web";
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
  const { t, lang } = useT();
  const label = CLI_LABEL[cliKind];
  // Tapping a session opens the permission-mode picker first (mirrors the desktop
  // CCRoomView flow), then onOpen with the chosen mode — instead of silently
  // hard-coding "default".
  const [picking, setPicking] = useState<{
    sessionId: string;
    label: string;
    cwd: string;
  } | null>(null);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mobile-side-header flex flex-col gap-2 px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold leading-5">{t("mobile.cc.title")}</h2>
            <p className="text-[11px] text-muted-foreground">
              {t("mobile.cc.subtitle", { label })}
            </p>
          </div>
        </div>
        <div className="flex min-w-0 gap-1.5">
          {CLI_KINDS.map((k) => (
            <Button
              key={k}
              size="sm"
              variant={cliKind === k ? "default" : "outline"}
              className="h-7 min-w-0 px-2.5 text-xs"
              onClick={() => onCliKindChange(k)}
            >
              {CLI_LABEL[k]}
            </Button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
        {!cwd ? (
          <p className="mobile-glass rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            {t("mobile.cc.selectProjectFirst")}
          </p>
        ) : probe === null ? (
          <p className="mobile-glass flex items-center justify-center gap-2 rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-status-running" />
            {t("mobile.cc.probingCli", { label })}
          </p>
        ) : !probe.available ? (
          <p className="mobile-glass rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            {t("mobile.cc.cliMissing", { label })}
          </p>
        ) : loading && sessions.length === 0 ? (
          <p className="mobile-glass flex items-center justify-center gap-2 rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-status-running" />
            {t("mobile.cc.loadingSessions")}
          </p>
        ) : sessions.length === 0 ? (
          <p className="mobile-glass rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            {t("mobile.cc.empty", { label })}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {sessions.map((s) => (
              <li key={s.sessionId}>
                <button
                  type="button"
                  onClick={() =>
                    setPicking({
                      sessionId: s.sessionId,
                      label: s.firstMessage || s.sessionId,
                      cwd: s.cwd || cwd,
                    })
                  }
                  className={cn(
                    "mobile-list-item flex w-full min-w-0 flex-col gap-1 rounded-lg px-3 py-2.5 text-left",
                  )}
                >
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">
                    {s.firstMessage || s.sessionId}
                  </span>
                  <div className="flex w-full min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate">
                      {t("mobile.cc.messageCount", { count: s.messageCount })}
                    </span>
                    <span className="ml-auto shrink-0">
                      {relativeTime(s.lastModified, Date.now(), lang)}
                    </span>
                  </div>
                  {s.cwd && s.cwd !== cwd && (
                    <span className="w-full truncate text-[11px] text-muted-foreground">
                      {s.cwd}
                    </span>
                  )}
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
            const sessionCwd = picking.cwd;
            setPicking(null);
            onOpen(sid, sessionCwd, mode);
          }}
          onCancel={() => setPicking(null)}
        />
      )}
    </div>
  );
}
