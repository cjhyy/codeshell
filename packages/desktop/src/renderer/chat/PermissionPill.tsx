import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { useAnchoredPopover } from "./useAnchoredPopover";
import { useT } from "../i18n/I18nProvider";
import type { TranslationKey } from "../i18n/dict";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PermissionMode = "plan" | "default" | "accept_edits" | "bypass";
export type CorePermissionMode = "plan" | "default" | "acceptEdits" | "bypassPermissions";

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

/**
 * External Agent Runtimes take plan mode as a separate flag, not a permission
 * level. Both the chat send and Panel App submissions route through this so
 * main sees one spelling and never restarts a runtime over a mapping drift.
 */
export function toExternalRuntimePermission(mode: CorePermissionMode | undefined): {
  permissionMode: Exclude<CorePermissionMode, "plan">;
  planMode: boolean;
} {
  if (mode === "plan") return { permissionMode: "default", planMode: true };
  return { permissionMode: mode ?? "default", planMode: false };
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
  compact?: boolean;
}

export function PermissionPill({ value, onChange, disabled, compact = false }: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [focusedMode, setFocusedMode] = useState<PermissionMode>("default");
  const popupId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLUListElement>(null);
  const optionRefs = useRef(new Map<PermissionMode, HTMLButtonElement>());
  const popupOwned = useRef(false);
  const isOpen = open && !disabled;
  const popoverStyle = useAnchoredPopover(isOpen, anchorRef, popoverRef, {
    align: "start",
    preferredSide: "top",
  });
  const cur = MODES.find((m) => m.id === value) ?? MODES[1];

  useLayoutEffect(() => {
    if (disabled) {
      popupOwned.current = false;
      setOpen(false);
    }
  }, [disabled]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const onOutside = (event: PointerEvent | FocusEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || popoverRef.current?.contains(target)) return;
      popupOwned.current = false;
      setOpen(false);
    };
    const onBlur = () => {
      popupOwned.current = false;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("focusin", onOutside, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("focusin", onOutside, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [isOpen]);

  useLayoutEffect(() => {
    const list = popoverRef.current;
    if (!isOpen || !list || popoverStyle.visibility !== "visible") return;
    const active = document.activeElement;
    if (
      !list.contains(active) &&
      active !== anchorRef.current &&
      !(active === document.body && popupOwned.current)
    )
      return;
    const target = optionRefs.current.get(focusedMode);
    if (!target) return;
    if (active !== target) target.focus({ preventScroll: true });
    popupOwned.current = true;
    const bounds = list.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    const top = bounds.top + list.clientTop;
    const bottom = top + list.clientHeight;
    if (box.top < top - 1) list.scrollTop += box.top - top;
    else if (box.bottom > bottom + 1) list.scrollTop += box.bottom - bottom;
  }, [focusedMode, isOpen, popoverStyle]);

  const openMenu = () => {
    if (disabled) return;
    popupOwned.current = true;
    setFocusedMode(cur.id);
    setOpen(true);
  };
  const closeMenu = (restore = false) => {
    const active = document.activeElement;
    const owned = popoverRef.current?.contains(active) || active === anchorRef.current;
    popupOwned.current = false;
    setOpen(false);
    if (restore && owned && anchorRef.current?.isConnected && !anchorRef.current.disabled)
      anchorRef.current.focus();
  };
  const composing = (event: React.KeyboardEvent) => {
    if (!event.nativeEvent.isComposing && event.keyCode !== 229) return false;
    event.preventDefault();
    return true;
  };
  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (composing(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    } else if (event.key === "Tab") {
      // Let native Tab continue from the trigger through the surrounding UI.
      closeMenu(true);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const index = MODES.findIndex((mode) => mode.id === focusedMode);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? MODES.length - 1
            : event.key === "ArrowDown"
              ? Math.min(index + 1, MODES.length - 1)
              : Math.max(index - 1, 0);
      setFocusedMode(MODES[next].id);
    }
  };

  const toneText = (t: "ok" | "warn" | "err") =>
    t === "ok" ? "text-status-ok" : t === "warn" ? "text-status-warn" : "text-status-err";
  const toneBorder = (t: "ok" | "warn" | "err") =>
    t === "ok" ? "border-status-ok" : t === "warn" ? "border-status-warn" : "border-status-err";
  const toneDot = (t: "ok" | "warn" | "err") =>
    t === "ok" ? "bg-status-ok" : t === "warn" ? "bg-status-warn" : "bg-status-err";

  return (
    <div className={cn("relative", compact && "min-w-0")} ref={ref}>
      <Button
        ref={anchorRef}
        type="button"
        variant="outline"
        size="sm"
        className={cn(
          "cs-control min-h-7 shrink-0 gap-1.5 px-2 py-1 text-xs font-medium",
          toneText(cur.tone),
          toneBorder(cur.tone),
          compact && "max-w-full",
        )}
        disabled={disabled}
        aria-label={t("chat.permission.currentLabel", { label: t(cur.labelKey) })}
        title={t("chat.permission.currentLabel", { label: t(cur.labelKey) })}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? popupId : undefined}
        onKeyDown={(event) => {
          if (composing(event)) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu();
          } else if (event.key === "Escape" && isOpen) {
            event.preventDefault();
            closeMenu(true);
          }
        }}
        onClick={() => (isOpen ? closeMenu() : openMenu())}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${toneDot(cur.tone)}`} aria-hidden="true" />
        <span
          className={cn(
            "truncate",
            compact ? "max-w-24" : "max-w-[7rem] @max-[520px]/composer-controls:hidden",
          )}
        >
          {t(cur.labelKey)}
        </span>
        <ChevronDown
          size={11}
          className={cn("shrink-0 opacity-60", !compact && "@max-[520px]/composer-controls:hidden")}
          aria-hidden="true"
        />
      </Button>
      {isOpen &&
        createPortal(
          <ul
            id={popupId}
            ref={popoverRef}
            style={popoverStyle}
            className="cs-popup-surface w-64 overflow-hidden rounded-md p-1"
            role="listbox"
            onKeyDown={onMenuKeyDown}
            aria-label={t("chat.permission.currentLabel", { label: t(cur.labelKey) })}
          >
            {MODES.map((m) => (
              <li key={m.id} role="none">
                <Button
                  id={`${popupId}-${m.id}`}
                  ref={(node) => {
                    if (node) optionRefs.current.set(m.id, node);
                    else optionRefs.current.delete(m.id);
                  }}
                  type="button"
                  variant="ghost"
                  size="sm"
                  role="option"
                  aria-selected={m.id === value}
                  tabIndex={m.id === focusedMode ? 0 : -1}
                  onFocus={() => setFocusedMode(m.id)}
                  className={cn(
                    "cs-menu-item h-auto w-full justify-start gap-2 px-2 py-1.5 text-sm",
                    m.id === value && "bg-accent",
                  )}
                  onClick={() => {
                    if (disabled) return;
                    onChange(m.id);
                    closeMenu(true);
                  }}
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${toneDot(m.tone)}`}
                    aria-hidden="true"
                  />
                  <span className="font-medium">{t(m.labelKey)}</span>
                </Button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
