import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Zap, Image } from "lucide-react";
import { useAnchoredPopover } from "./useAnchoredPopover";
import { useT } from "../i18n/I18nProvider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * One row in the model dropdown.
 *
 * `key` is the engine-side identifier the user has in their
 * settings.json under `models[].key` — same value as the top-level
 * `activeKey` field that code-shell uses to pick the active model.
 * `provider` is just `providerKey` from the same entry; we keep it
 * for UI grouping (left chip in the dropdown).
 */
export interface ModelOption {
  key: string;
  label: string;
  provider: string;
  maxContextTokens?: number;
  /** Whether this model accepts image content blocks. */
  supportsVision?: boolean;
}

interface Props {
  /** Active model key (matches ModelOption.key). */
  activeKey: string | null;
  options: ModelOption[];
  onSelect: (opt: ModelOption) => void;
  disabled?: boolean;
  compact?: boolean;
  /**
   * Render the fixed-position menu outside ancestors that establish their own
   * containing block (for example a backdrop-filter surface).
   */
  portal?: boolean;
}

export function ModelPill({
  activeKey,
  options,
  onSelect,
  disabled,
  compact = false,
  portal = true,
}: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const popupId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLUListElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const popupOwned = useRef(false);
  const focusedLayout = useRef("");
  const isOpen = open && !disabled;
  const popoverStyle = useAnchoredPopover(isOpen, anchorRef, popoverRef, {
    align: "end",
    preferredSide: "top",
    maxHeight: "20rem",
  });

  useLayoutEffect(() => {
    if (disabled) {
      popupOwned.current = false;
      setOpen(false);
    }
  }, [disabled]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || popoverRef.current?.contains(target)) return;
      popupOwned.current = false;
      setOpen(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || popoverRef.current?.contains(target)) return;
      popupOwned.current = false;
      setOpen(false);
    };
    const onBlur = () => {
      popupOwned.current = false;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [isOpen]);

  useLayoutEffect(() => {
    const list = popoverRef.current;
    if (!isOpen || !list || popoverStyle.visibility !== "visible") return;
    const activeElement = document.activeElement;
    if (
      !list.contains(activeElement) &&
      activeElement !== anchorRef.current &&
      !(activeElement === document.body && popupOwned.current)
    )
      return;
    const next =
      options.find((option) => option.key === focusedKey) ??
      options.find((option) => option.key === activeKey) ??
      options[0];
    const nextKey = next?.key ?? null;
    if (nextKey !== focusedKey) setFocusedKey(nextKey);
    const target = (nextKey && optionRefs.current.get(nextKey)) || list;
    if (target !== activeElement) target.focus({ preventScroll: true });
    popupOwned.current = true;
    if (target !== list) {
      const bounds = list.getBoundingClientRect();
      const layout = `${nextKey}:${bounds.top}:${list.clientHeight}:${target.offsetHeight}`;
      if (layout === focusedLayout.current) return;
      focusedLayout.current = layout;
      const top = bounds.top + list.clientTop;
      const bottom = top + list.clientHeight;
      const box = target.getBoundingClientRect();
      if (box.top < top - 1 || box.height > list.clientHeight) list.scrollTop += box.top - top;
      else if (box.bottom > bottom + 1) list.scrollTop += box.bottom - bottom;
    }
  }, [activeKey, focusedKey, isOpen, options, popoverStyle]);

  const openMenu = (last = false) => {
    if (disabled) return;
    popupOwned.current = true;
    focusedLayout.current = "";
    setFocusedKey(
      options.find((option) => option.key === activeKey)?.key ??
        options[last ? options.length - 1 : 0]?.key ??
        null,
    );
    setOpen(true);
  };
  const closeMenu = (restore = false) => {
    const activeElement = document.activeElement;
    const owned =
      popoverRef.current?.contains(activeElement) || activeElement === anchorRef.current;
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
      // Move the starting point back to the trigger before the browser's native
      // Tab action, so the portal continues through the surrounding controls.
      closeMenu(true);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!options.length) return;
      const index = options.findIndex((option) => option.key === focusedKey);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : event.key === "ArrowDown"
              ? Math.min(index + 1, options.length - 1)
              : Math.max(index - 1, 0);
      setFocusedKey(options[next].key);
    }
  };

  const active = options.find((o) => o.key === activeKey) ?? null;
  const label = active?.label ?? activeKey ?? t("chat.model.select");
  const popover = isOpen ? (
    <ul
      id={popupId}
      ref={popoverRef}
      style={popoverStyle}
      className="cs-popup-surface max-h-[min(20rem,calc(100vh-20px))] w-72 max-w-[calc(100vw-20px)] overflow-y-auto rounded-md p-1"
      role="listbox"
      aria-label={t("chat.model.select")}
      tabIndex={-1}
      onKeyDown={onMenuKeyDown}
    >
      {options.length === 0 ? (
        <li className="px-2 py-1.5 text-sm text-muted-foreground">{t("chat.model.noModels")}</li>
      ) : (
        options.map((o) => (
          <li key={o.key} role="none">
            <Button
              ref={(node) => {
                if (node) optionRefs.current.set(o.key, node);
                else optionRefs.current.delete(o.key);
              }}
              type="button"
              variant="ghost"
              size="sm"
              role="option"
              aria-selected={o.key === activeKey}
              tabIndex={o.key === focusedKey ? 0 : -1}
              data-model-key={o.key}
              className={cn(
                "cs-menu-item h-auto w-full min-w-0 flex-col items-start justify-start gap-1 whitespace-normal px-2 py-1.5 text-sm font-normal",
                o.key === activeKey && "bg-accent",
              )}
              onFocus={() => setFocusedKey(o.key)}
              onClick={() => {
                if (disabled) return;
                onSelect(o);
                closeMenu(true);
              }}
            >
              <span className="max-w-full rounded bg-muted px-1.5 py-0.5 text-left text-xs whitespace-normal text-muted-foreground [overflow-wrap:anywhere]">
                {o.provider}
              </span>
              <span className="w-full min-w-0 text-left whitespace-pre-wrap [overflow-wrap:anywhere]">
                {o.label}
                {o.supportsVision && (
                  <Image
                    size={11}
                    aria-label={t("chat.model.visionSupported")}
                    className="ml-1 inline-block align-middle opacity-60"
                  />
                )}
              </span>
            </Button>
          </li>
        ))
      )}
    </ul>
  ) : null;

  return (
    <div className={cn("relative", compact && "min-w-0")} ref={ref}>
      <Button
        ref={anchorRef}
        type="button"
        variant="outline"
        size="sm"
        data-active-model={activeKey ?? ""}
        className={cn(
          "cs-control min-h-7 shrink-0 gap-1.5 px-2 py-1 text-xs text-foreground",
          compact && "max-w-full",
        )}
        disabled={disabled}
        aria-label={t("chat.model.currentLabel", { label })}
        title={t("chat.model.currentLabel", { label })}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? popupId : undefined}
        onKeyDown={(event) => {
          if (composing(event)) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu(event.key === "ArrowUp");
          } else if (event.key === "Escape" && isOpen) {
            event.preventDefault();
            closeMenu(true);
          }
        }}
        onClick={() => (isOpen ? closeMenu() : openMenu())}
      >
        <Zap size={12} className="shrink-0" aria-hidden="true" />
        <span
          className={cn(
            "truncate",
            compact ? "max-w-24" : "max-w-[12rem] @max-[520px]/composer-controls:hidden",
          )}
        >
          {label}
        </span>
        <ChevronDown
          size={11}
          className={cn("shrink-0 opacity-60", !compact && "@max-[520px]/composer-controls:hidden")}
          aria-hidden="true"
        />
      </Button>
      {portal && popover ? createPortal(popover, document.body) : popover}
    </div>
  );
}
