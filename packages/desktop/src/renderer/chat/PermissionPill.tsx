import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useAnchoredPopover } from "./useAnchoredPopover";

export type PermissionMode = "plan" | "default" | "accept_edits" | "bypass";
export type CorePermissionMode =
  | "plan"
  | "default"
  | "acceptEdits"
  | "bypassPermissions";

const MODES: Array<{
  id: PermissionMode;
  label: string;
  tone: "ok" | "warn" | "err";
}> = [
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
      // 完全访问权限 = engine bypassPermissions backend: every approval
      // request is allowed (HeadlessApprovalBackend "approve-all"). This
      // is a permission LEVEL — orthogonal to Goal mode, which is an
      // autonomy toggle handled separately (see goalEnabled / RunParams.goal).
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
    // Migration: commit 58e6114 briefly persisted permissionMode="goal"
    // (engine "auto" backend) before Goal became an orthogonal autonomy
    // toggle. Residual "goal"/"auto" values are no longer permission
    // levels — downgrade them to default (ask) rather than silently
    // granting full access from a stale config.
    case "goal":
    case "auto":
      return "default";
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
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLUListElement>(null);
  const popoverStyle = useAnchoredPopover(open, anchorRef, popoverRef, {
    align: "start",
    preferredSide: "top",
  });
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

  const toneText = (t: "ok" | "warn" | "err") =>
    t === "ok" ? "text-status-ok" : t === "warn" ? "text-status-warn" : "text-status-err";
  const toneBorder = (t: "ok" | "warn" | "err") =>
    t === "ok" ? "border-status-ok" : t === "warn" ? "border-status-warn" : "border-status-err";
  const toneDot = (t: "ok" | "warn" | "err") =>
    t === "ok" ? "bg-status-ok" : t === "warn" ? "bg-status-warn" : "bg-status-err";

  return (
    <div className="relative" ref={ref}>
      <button
        ref={anchorRef}
        type="button"
        className={`cs-control inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50 ${toneText(cur.tone)} ${toneBorder(cur.tone)}`}
        disabled={disabled}
        title="当前对话权限"
        onClick={() => setOpen((o) => !o)}
      >
        {/* Narrow composer (panel open): collapse to a tone dot only, hide the
            label — keyed to the composer card's @container width, not viewport. */}
        <span className={`hidden h-2 w-2 shrink-0 rounded-full @max-[480px]:inline-block ${toneDot(cur.tone)}`} />
        <span className="@max-[480px]:hidden">{cur.label}</span>
        <ChevronDown size={11} className="opacity-60" />
      </button>
      {open && (
        <ul
          ref={popoverRef}
          style={popoverStyle}
          className="cs-popup-surface w-64 overflow-hidden rounded-md p-1"
        >
          {MODES.map((m) => (
            <li
              key={m.id}
              className={
                "cs-menu-item flex cursor-pointer gap-2 px-2 py-1.5 text-sm " +
                (m.id === value ? "bg-accent" : "")
              }
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${toneDot(m.tone)}`} />
              <span className="font-medium">{m.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
