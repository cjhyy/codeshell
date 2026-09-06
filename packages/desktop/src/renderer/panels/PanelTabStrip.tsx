import React, { useEffect, useRef } from "react";
import { X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface PanelStripTab {
  id: string;
  label: string;
  icon: LucideIcon;
}

interface Props {
  tabs: PanelStripTab[];
  activeId: string | null;
  idPrefix: string;
  hidden: boolean;
  label: string;
  closeLabel: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** The focused last tab disappeared; its host owns the surviving opener. */
  onRestoreFocus?: () => void;
}

/** Only the tabs scroll; dock actions remain visible beside this strip. */
export function PanelTabStrip({
  tabs,
  activeId,
  idPrefix,
  hidden,
  label,
  closeLabel,
  onActivate,
  onClose,
  onRestoreFocus,
}: Props) {
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (hidden || !activeId) return;
    tabButtons.current.get(activeId)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId, hidden, tabs.length]);

  const close = (id: string, retainFocus: boolean) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const remaining = tabs.filter((tab) => tab.id !== id);
    const nextId = id === activeId ? remaining[Math.max(0, index - 1)]?.id : activeId;
    onClose(id);
    if (!retainFocus) return;
    if (nextId) tabButtons.current.get(nextId)?.focus();
    else if (remaining.length === 0) onRestoreFocus?.();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 py-1 [scrollbar-width:thin]"
    >
      {tabs.map((tab, index) => {
        const active = tab.id === activeId;
        const Icon = tab.icon;
        return (
          <div
            key={tab.id}
            role="presentation"
            className={cn(
              "group flex h-8 min-w-0 shrink-0 items-center rounded-lg border transition-colors",
              active
                ? "border-border/80 bg-background text-foreground shadow-sm"
                : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Button
              ref={(node) => {
                if (node) tabButtons.current.set(tab.id, node);
                else tabButtons.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={`${idPrefix}-tab-${tab.id}`}
              aria-controls={`${idPrefix}-body-${tab.id}`}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={tab.label}
              variant="ghost"
              className="h-full min-w-0 max-w-44 justify-start gap-1.5 rounded-l-lg rounded-r-none py-0 pl-2.5 pr-1.5 text-xs hover:bg-transparent focus-visible:ring-inset"
              onClick={() => onActivate(tab.id)}
              onKeyDown={(event) => {
                if (event.altKey || event.ctrlKey || event.metaKey) return;
                let nextIndex: number;
                switch (event.key) {
                  case "ArrowLeft":
                    nextIndex = (index - 1 + tabs.length) % tabs.length;
                    break;
                  case "ArrowRight":
                    nextIndex = (index + 1) % tabs.length;
                    break;
                  case "Home":
                    nextIndex = 0;
                    break;
                  case "End":
                    nextIndex = tabs.length - 1;
                    break;
                  case "Delete":
                    event.preventDefault();
                    close(tab.id, event.currentTarget === document.activeElement);
                    return;
                  default:
                    return;
                }
                event.preventDefault();
                const nextId = tabs[nextIndex].id;
                onActivate(nextId);
                tabButtons.current.get(nextId)?.focus();
              }}
            >
              <Icon className={cn("size-3.5", active && "text-primary")} />
              <span className="truncate">{tab.label}</span>
            </Button>
            <Button
              type="button"
              aria-label={`${closeLabel}: ${tab.label}`}
              title={`${closeLabel}: ${tab.label}`}
              tabIndex={active ? 0 : -1}
              variant="ghost"
              size="icon"
              className={cn(
                "mr-1 size-6 shrink-0 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-inset",
                active ? "opacity-100" : "opacity-40",
              )}
              onClick={(event) => close(tab.id, event.currentTarget === document.activeElement)}
            >
              <X className="size-3" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
