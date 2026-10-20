import React, { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Zap, Image } from "lucide-react";
import { useAnchoredPopover } from "./useAnchoredPopover";
import { useT } from "../i18n/I18nProvider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { groupModelOptions } from "./modelPickerPresentation";

/**
 * One row in the model dropdown.
 *
 * `key` is the engine-side identifier the user has in their
 * settings.json under `models[].key` — same value as the top-level
 * `activeKey` field that code-shell uses to pick the active model.
 * `provider` is just `providerKey` from the same entry; we keep it
 * for UI grouping (one heading per provider).
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
  const groups = useMemo(() => groupModelOptions(options), [options]);
  const displayedOptions = useMemo(() => groups.flatMap((group) => group.options), [groups]);
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
      displayedOptions.find((option) => option.key === focusedKey) ??
      displayedOptions.find((option) => option.key === activeKey) ??
      displayedOptions[0];
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
  }, [activeKey, focusedKey, isOpen, displayedOptions, popoverStyle]);

  const openMenu = (last = false) => {
    if (disabled) return;
    popupOwned.current = true;
    focusedLayout.current = "";
    setFocusedKey(
      displayedOptions.find((option) => option.key === activeKey)?.key ??
        displayedOptions[last ? displayedOptions.length - 1 : 0]?.key ??
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
      anchorRef.current.focus({ preventScroll: true });
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
      if (!displayedOptions.length) return;
      const index = displayedOptions.findIndex((option) => option.key === focusedKey);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? displayedOptions.length - 1
            : event.key === "ArrowDown"
              ? Math.min(index + 1, displayedOptions.length - 1)
              : Math.max(index - 1, 0);
      setFocusedKey(displayedOptions[next].key);
    }
  };

  const active = options.find((o) => o.key === activeKey) ?? null;
  const label = active?.label ?? activeKey ?? t("chat.model.select");
  const popover = isOpen ? (
    <ul
      id={popupId}
      ref={popoverRef}
      style={popoverStyle}
      className="cs-popup-surface max-h-[min(20rem,calc(100vh-20px))] w-72 max-w-[calc(100vw-20px)] overflow-y-auto rounded-xl p-1.5"
      role="listbox"
      aria-label={t("chat.model.select")}
      tabIndex={-1}
      onKeyDown={onMenuKeyDown}
    >
      {options.length === 0 ? (
        <li className="px-2 py-1.5 text-sm text-muted-foreground">{t("chat.model.noModels")}</li>
      ) : (
        groups.map((group, index) => (
          <li
            key={group.provider}
            role="group"
            aria-labelledby={`${popupId}-provider-${index}`}
            data-model-provider={group.provider}
            className="min-w-0 border-border/60 pb-0.5 [&+&]:border-t [&+&]:pt-0.5"
          >
            <div
              id={`${popupId}-provider-${index}`}
              data-model-provider-label
              className="px-2.5 py-1.5 text-[11px] font-medium leading-4 text-muted-foreground [overflow-wrap:anywhere]"
            >
              {group.provider}
            </div>
            <ul role="none" className="space-y-0.5">
              {group.options.map((o) => (
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
                    title={`${o.provider} · ${o.label}`}
                    className={cn(
                      "cs-menu-item h-auto min-h-8 w-full min-w-0 justify-start gap-2 rounded-lg whitespace-normal px-2.5 py-1.5 text-[13px] font-normal leading-5",
                      o.key === activeKey && "bg-primary/8 text-foreground",
                    )}
                    onFocus={() => setFocusedKey(o.key)}
                    onClick={() => {
                      if (disabled) return;
                      onSelect(o);
                      closeMenu(true);
                    }}
                  >
                    <span
                      data-model-label
                      className="min-w-0 flex-1 text-left whitespace-pre-wrap [overflow-wrap:anywhere]"
                    >
                      {o.label}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {o.supportsVision && (
                        <Image
                          size={13}
                          aria-label={t("chat.model.visionSupported")}
                          className="text-muted-foreground"
                        />
                      )}
                      <span className="flex size-3.5 items-center justify-center" aria-hidden>
                        {o.key === activeKey && <Check size={14} className="text-primary" />}
                      </span>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
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
