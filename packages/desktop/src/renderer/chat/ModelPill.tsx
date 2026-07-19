import React, { useEffect, useRef, useState } from "react";
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
  /**
   * Render the fixed-position menu outside ancestors that establish their own
   * containing block (for example a backdrop-filter surface).
   */
  portal?: boolean;
}

export function ModelPill({ activeKey, options, onSelect, disabled, portal = false }: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLUListElement>(null);
  const popoverStyle = useAnchoredPopover(open, anchorRef, popoverRef, {
    align: "end",
    preferredSide: "top",
  });

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        anchorRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const active = options.find((o) => o.key === activeKey) ?? null;
  const label = active?.label ?? activeKey ?? t("chat.model.select");
  const popover = open ? (
    <ul
      ref={popoverRef}
      style={popoverStyle}
      className="cs-popup-surface max-h-[min(20rem,calc(100vh-20px))] w-72 max-w-[calc(100vw-20px)] overflow-y-auto rounded-md p-1"
      role="listbox"
      aria-label={t("chat.model.select")}
    >
      {options.length === 0 ? (
        <li className="px-2 py-1.5 text-sm text-muted-foreground">
          {t("chat.model.noModels")}
        </li>
      ) : (
        options.map((o) => (
          <li key={o.key} role="none">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              role="option"
              aria-selected={o.key === activeKey}
              data-model-key={o.key}
              className={cn(
                "cs-menu-item h-auto w-full justify-start gap-2 px-2 py-1.5 text-sm font-normal",
                o.key === activeKey && "bg-accent",
              )}
              onClick={() => {
                onSelect(o);
                setOpen(false);
                anchorRef.current?.focus();
              }}
            >
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {o.provider}
              </span>
              <span className="flex-1 truncate text-left">{o.label}</span>
              {o.supportsVision && (
                <Image
                  size={11}
                  aria-label={t("chat.model.visionSupported")}
                  className="opacity-60"
                />
              )}
            </Button>
          </li>
        ))
      )}
    </ul>
  ) : null;

  return (
    <div className="relative" ref={ref}>
      <Button
        ref={anchorRef}
        type="button"
        variant="outline"
        size="sm"
        data-active-model={activeKey ?? ""}
        className="cs-control min-h-7 shrink-0 gap-1.5 px-2 py-1 text-xs text-foreground"
        disabled={disabled}
        aria-label={t("chat.model.currentLabel", { label })}
        title={t("chat.model.currentLabel", { label })}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Zap size={12} className="shrink-0" aria-hidden="true" />
        <span className="max-w-[12rem] truncate @max-[520px]/composer-controls:hidden">
          {label}
        </span>
        <ChevronDown
          size={11}
          className="shrink-0 opacity-60 @max-[520px]/composer-controls:hidden"
          aria-hidden="true"
        />
      </Button>
      {portal && popover ? createPortal(popover, document.body) : popover}
    </div>
  );
}
