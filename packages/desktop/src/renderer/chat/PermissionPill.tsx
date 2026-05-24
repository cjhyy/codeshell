import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, ChevronDown } from "lucide-react";

export type PermissionMode = "plan" | "default" | "accept_edits" | "bypass";
export type CorePermissionMode = "plan" | "default" | "acceptEdits" | "bypassPermissions";

const MODES: Array<{ id: PermissionMode; label: string; tone: "ok" | "warn" | "err" }> = [
  { id: "plan", label: "计划模式", tone: "ok" },
  { id: "default", label: "默认权限", tone: "ok" },
  { id: "accept_edits", label: "接受编辑", tone: "warn" },
  { id: "bypass", label: "完全访问权限", tone: "err" },
];

export function toCorePermissionMode(mode: PermissionMode): CorePermissionMode {
  switch (mode) {
    case "accept_edits":
      return "acceptEdits";
    case "bypass":
      return "bypassPermissions";
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
    case "bypass":
    case "bypassPermissions":
      return "bypass";
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
        onClick={() => setOpen((o) => !o)}
      >
        <AlertCircle size={12} />
        <span>{cur.label}</span>
        <ChevronDown size={11} />
      </button>
      {open && (
        <ul className="composer-popover">
          {MODES.map((m) => (
            <li
              key={m.id}
              className={`composer-popover-item${m.id === value ? " active" : ""}`}
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
            >
              <span className={`status-dot status-${m.tone === "ok" ? "ok" : m.tone === "warn" ? "warn" : "err"}`} />
              <span>{m.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
