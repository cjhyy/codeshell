import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, ChevronDown } from "lucide-react";

export type PermissionMode = "plan" | "default" | "accept_edits" | "goal";
export type CorePermissionMode =
  | "plan"
  | "default"
  | "acceptEdits"
  | "auto";

const MODES: Array<{
  id: PermissionMode;
  label: string;
  tone: "ok" | "warn" | "err";
  hint: string;
}> = [
  { id: "plan", label: "计划模式", tone: "ok", hint: "只读探索 + 出方案,不动手" },
  { id: "default", label: "默认权限", tone: "ok", hint: "每个有风险的操作都问一下" },
  { id: "accept_edits", label: "接受编辑", tone: "warn", hint: "自动放行文件编辑,命令仍问" },
  {
    id: "goal",
    label: "Goal 模式",
    tone: "warn",
    hint: "设目标后跑到完;危险/破坏性操作仍会拦下",
  },
];

export function toCorePermissionMode(mode: PermissionMode): CorePermissionMode {
  switch (mode) {
    case "accept_edits":
      return "acceptEdits";
    case "goal":
      // Goal mode = engine "auto" backend: auto-approve low/safe,
      // auto-DENY high-risk dangerous (rm -rf, curl|sh, etc). This is
      // the "run to completion but don't let it nuke the machine"
      // posture that replaces the old blanket bypassPermissions.
      return "auto";
    default:
      return mode;
  }
}

export function fromSettingsPermissionMode(raw: unknown): PermissionMode {
  switch (raw) {
    case "plan":
      return "plan";
    case "accept_edits":
    case "acceptEdits":
      return "accept_edits";
    case "goal":
    case "auto":
      return "goal";
    // Legacy: old configs / sessions may still carry the dropped
    // bypass mode. Down-map it to Goal mode (the safe replacement)
    // rather than silently honoring an unrestricted bypass.
    case "bypass":
    case "bypassPermissions":
      return "goal";
    case "default":
    default:
      return "default";
  }
}

interface Props {
  value: PermissionMode | null;
  onChange: (mode: PermissionMode) => void;
  disabled?: boolean;
}

export function PermissionPill({ value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cur = MODES.find((m) => m.id === value) ?? MODES[1];

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="composer-pill-wrap" ref={ref}>
      <button
        type="button"
        className={`composer-pill perm-tone-${cur.tone}`}
        disabled={disabled}
        title="当前对话权限"
        onClick={() => setOpen((o) => !o)}
      >
        <AlertCircle size={12} />
        <span>本次：{cur.label}</span>
        <ChevronDown size={11} />
      </button>
      {open && (
        <ul className="composer-popover">
          {MODES.map((m) => (
            <li
              key={m.id}
              className={`composer-popover-item${m.id === value ? " active" : ""}`}
              title={m.hint}
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
            >
              <span className={`status-dot status-${m.tone === "ok" ? "ok" : m.tone === "warn" ? "warn" : "err"}`} />
              <span className="composer-popover-item-label">{m.label}</span>
              <span className="composer-popover-item-hint">{m.hint}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
