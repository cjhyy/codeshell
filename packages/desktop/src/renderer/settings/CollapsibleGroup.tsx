import React, { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  title: string;
  subtitle?: string;
  /** Right-aligned count/badge text in the header. */
  badge?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

/**
 * Collapsible connection group. The whole header is a toggle button (the
 * earlier WebSearch group header wasn't collapsible — user asked for groups to
 * fold). Pure presentational; each connection group (WebSearch, ImageGen, …)
 * wraps its card grid in one of these.
 */
export function CollapsibleGroup({ title, subtitle, badge, defaultOpen = true, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full select-none items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-accent/50",
          // No stray focus ring on mouse click; only a subtle inset ring on
          // keyboard focus (the orange browser-default outline looked broken).
          "outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset",
          open && "border-b border-border",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="text-sm font-medium text-foreground">{title}</strong>
          {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {badge && <span className="text-xs text-muted-foreground">{badge}</span>}
          <ChevronRight
            size={14}
            aria-hidden
            className={cn("text-muted-foreground transition-transform", open && "rotate-90")}
          />
        </span>
      </button>
      {open && <div className="p-3">{children}</div>}
    </div>
  );
}
