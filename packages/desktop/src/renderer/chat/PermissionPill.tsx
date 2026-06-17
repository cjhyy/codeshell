import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useAnchoredPopover } from "./useAnchoredPopover";
import { useT } from "../i18n/I18nProvider";
import type { TranslationKey } from "../i18n/dict";

export type PermissionMode = "plan" | "default" | "accept_edits" | "bypass";
export type CorePermissionMode =
  | "plan"
  | "default"
  | "acceptEdits"
  | "bypassPermissions";

const MODES: Array<{
  id: PermissionMode;
  labelKey: TranslationKey;
  tone: "ok" | "warn" | "err";
}> = [
  { id: "plan", labelKey: "chat.permission.plan", tone: "ok" },
  { id: "default", labelKey: "chat.permission.default", tone: "ok" },
  { id: "accept_edits", labelKey: "chat.permission.acceptEdits", tone: "warn" },
  { id: "bypass", labelKey: "chat.permission.bypass", tone: "err" },
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
  const { t } = useT();
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
        className={`cs-control inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50 ${toneText(cur.tone)} ${toneBorder(cur.tone)}`}
        disabled={disabled}
        aria-label={t("chat.permission.currentLabel", { label: t(cur.labelKey) })}
        title={t("chat.permission.currentLabel", { label: t(cur.labelKey) })}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${toneDot(cur.tone)}`} aria-hidden="true" />
        <span className="max-w-[7rem] truncate @max-[520px]/composer-controls:hidden">
          {t(cur.labelKey)}
        </span>
        <ChevronDown
          size={11}
          className="shrink-0 opacity-60 @max-[520px]/composer-controls:hidden"
          aria-hidden="true"
        />
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
              <span className="font-medium">{t(m.labelKey)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
