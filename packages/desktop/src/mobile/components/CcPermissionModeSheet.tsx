import type { PermissionMode } from "@protocol";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { AlertTriangle, Pencil, Shield, type LucideIcon } from "lucide-react";

/** Mode options mirroring the desktop CCRoomView picker. Each carries a short
 *  label + one-line description so the choice is self-explanatory on a phone. */
const MODES: {
  mode: PermissionMode;
  labelKey:
    | "mobile.permissionMode.default"
    | "mobile.permissionMode.acceptEdits"
    | "mobile.permissionMode.bypassPermissions";
  descKey:
    | "mobile.permissionMode.defaultDesc"
    | "mobile.permissionMode.acceptEditsDesc"
    | "mobile.permissionMode.bypassDesc";
  icon: LucideIcon;
  danger?: boolean;
}[] = [
  {
    mode: "default",
    labelKey: "mobile.permissionMode.default",
    descKey: "mobile.permissionMode.defaultDesc",
    icon: Shield,
  },
  {
    mode: "acceptEdits",
    labelKey: "mobile.permissionMode.acceptEdits",
    descKey: "mobile.permissionMode.acceptEditsDesc",
    icon: Pencil,
  },
  {
    mode: "bypassPermissions",
    labelKey: "mobile.permissionMode.bypassPermissions",
    descKey: "mobile.permissionMode.bypassDesc",
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
  const { t } = useT();
  return (
    <div className="fixed inset-0 z-30 flex flex-col justify-end">
      <div className="flex-1 bg-black/55 backdrop-blur-[2px]" onClick={onCancel} />
      <div className="mobile-panel mobile-safe-bottom max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-border/70 p-4">
        <div className="mb-1 text-sm font-semibold">{t("mobile.permissionMode.title")}</div>
        <div className="mb-3 min-w-0 truncate text-[11px] text-muted-foreground">
          {sessionLabel}
        </div>
        <div className="flex flex-col gap-2">
          {MODES.map(({ mode, labelKey, descKey, icon: Icon, danger }) => (
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
                  {t(labelKey)}
                </span>
                <span className="block whitespace-normal break-words text-[11px] leading-4 text-muted-foreground">
                  {t(descKey)}
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
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
