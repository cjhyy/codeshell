import { cn } from "@/lib/utils";
import type { PermissionMode } from "@protocol";

const MODES: [PermissionMode, string][] = [
  ["default", "默认"],
  ["acceptEdits", "自动改"],
  ["bypassPermissions", "全放行"],
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
  const pick = (m: PermissionMode) => {
    if (m === "bypassPermissions" && mode !== "bypassPermissions") {
      if (!window.confirm("全放行模式会跳过所有权限确认。确定吗?")) return;
    }
    onChange(m);
  };
  return (
    <div className="flex items-center gap-1 rounded-full border border-border bg-card p-0.5">
      {MODES.map(([m, label]) => (
        <button
          key={m}
          type="button"
          onClick={() => pick(m)}
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px]",
            mode === m
              ? m === "bypassPermissions"
                ? "bg-status-err/15 text-status-err"
                : "bg-primary/15 text-primary"
              : "text-muted-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
