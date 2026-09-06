import React, { useEffect, useRef } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "../i18n/I18nProvider";
import { resolveSearchOpener } from "./searchFocus";

interface Props {
  open: boolean;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  matchCount: number;
}

export function SearchBar({ open, value, onChange, onClose, matchCount }: Props) {
  const { t } = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const opener = resolveSearchOpener(document.activeElement);
    const surface = surfaceRef.current;
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      clearTimeout(timer);
      if (
        opener instanceof HTMLElement &&
        opener.isConnected &&
        (document.activeElement === document.body || surface?.contains(document.activeElement))
      ) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [open]);
  if (!open) return null;
  return (
    <div
      ref={surfaceRef}
      role="search"
      aria-label={t("chat.search.placeholder")}
      className="absolute right-3 top-3 z-20 w-[calc(100%-1.5rem)] max-w-sm rounded-xl border border-border/80 bg-popover p-2 text-popover-foreground shadow-lg"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          if (!event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            onClose();
          }
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Search className="ml-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <Input
          ref={inputRef}
          className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={t("chat.search.placeholder")}
          aria-label={t("chat.search.placeholder")}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 rounded-lg"
          onClick={onClose}
          aria-label={t("chat.search.close")}
        >
          <X size={14} aria-hidden />
        </Button>
      </div>
      <div
        role="status"
        className="px-1 pb-0.5 pt-1 text-[11px] tabular-nums text-muted-foreground"
      >
        {t("chat.search.matches", { count: matchCount })}
      </div>
    </div>
  );
}
