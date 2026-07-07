import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import type { PermissionMode } from "@protocol";

const MODES: [
  PermissionMode,
  (
    | "mobile.permissionMode.default"
    | "mobile.permissionMode.acceptEdits"
    | "mobile.permissionMode.bypassPermissions"
  ),
][] = [
  ["default", "mobile.permissionMode.default"],
  ["acceptEdits", "mobile.permissionMode.acceptEdits"],
  ["bypassPermissions", "mobile.permissionMode.bypassPermissions"],
];

/** Compact permission-mode switch. bypassPermissions confirms first (it's the
 *  dangerous mode the design flags red). */
export function PermissionModeControl({
  mode,
  onChange,
}: {
  mode: PermissionMode;
  onChange: (m: PermissionMode) => void;
}) {
  const { t } = useT();
  const pick = (m: PermissionMode) => {
    if (m === "bypassPermissions" && mode !== "bypassPermissions") {
      if (!window.confirm(t("mobile.permissionMode.confirmBypass"))) return;
    }
    onChange(m);
  };
  return (
    <div className="mobile-tab-strip flex shrink-0 items-center gap-1 rounded-full p-0.5">
      {MODES.map(([m, labelKey]) => (
        <button
          key={m}
          type="button"
          onClick={() => pick(m)}
          className={cn(
            "rounded-full px-2 py-1 text-[11px] transition-colors",
            mode === m
              ? m === "bypassPermissions"
                ? "bg-status-err/15 text-status-err"
                : "bg-primary/15 text-primary"
              : "text-muted-foreground",
          )}
        >
          {t(labelKey)}
        </button>
      ))}
    </div>
  );
}
