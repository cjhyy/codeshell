import type { PermissionMode } from "@protocol";
import { cn } from "@/lib/utils";
import { AlertTriangle, Pencil, Shield, type LucideIcon } from "lucide-react";

/** Mode options mirroring the desktop CCRoomView picker. Each carries a short
 *  label + one-line description so the choice is self-explanatory on a phone. */
const MODES: {
  mode: PermissionMode;
  label: string;
  desc: string;
  icon: LucideIcon;
  danger?: boolean;
}[] = [
  { mode: "default", label: "默认", desc: "每个工具调用都要你确认", icon: Shield },
  { mode: "acceptEdits", label: "自动改", desc: "自动放行文件编辑,其余仍确认", icon: Pencil },
  {
    mode: "bypassPermissions",
    label: "全放行",
    desc: "跳过所有权限确认(危险)",
    icon: AlertTriangle,
    danger: true,
  },
];

/**
 * Bottom-sheet permission-mode picker shown before opening a CC (Claude Code)
 * session — the phone equivalent of the desktop "选择权限模式" dialog. The host
 * still applies resolveRoomPermissionMode server-side, so a non-trusted
 * workspace is clamped to "default" even if a looser mode is requested here.
 */
export function CcPermissionModeSheet({
  sessionLabel,
  onPick,
  onCancel,
}: {
  sessionLabel: string;
  onPick: (mode: PermissionMode) => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-30 flex flex-col justify-end">
      <div className="flex-1 bg-black/55 backdrop-blur-[2px]" onClick={onCancel} />
      <div className="mobile-panel mobile-safe-bottom max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-border/70 p-4">
        <div className="mb-1 text-sm font-semibold">选择权限模式</div>
        <div className="mb-3 min-w-0 truncate text-[11px] text-muted-foreground">
          {sessionLabel}
        </div>
        <div className="flex flex-col gap-2">
          {MODES.map(({ mode, label, desc, icon: Icon, danger }) => (
            <button
              key={mode}
              type="button"
              onClick={() => onPick(mode)}
              className={cn(
                "mobile-list-item flex min-h-16 w-full min-w-0 items-center gap-3 rounded-lg border px-3 py-2.5 text-left",
                danger
                  ? "border-status-err/40 hover:bg-status-err/10"
                  : "border-border/70 hover:bg-primary/10",
              )}
            >
              <span
                className={cn(
                  "grid size-9 shrink-0 place-items-center rounded-lg border",
                  danger
                    ? "border-status-err/35 bg-status-err/10 text-status-err"
                    : "border-border/70 bg-primary/10 text-primary",
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block text-sm font-medium",
                    danger ? "text-status-err" : "text-foreground",
                  )}
                >
                  {label}
                </span>
                <span className="block whitespace-normal break-words text-[11px] leading-4 text-muted-foreground">
                  {desc}
                </span>
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="mt-3 w-full rounded-lg py-2 text-center text-sm text-muted-foreground"
        >
          取消
        </button>
      </div>
    </div>
  );
}
