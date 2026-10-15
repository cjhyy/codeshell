import React from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type LinkStatusTone = "ready" | "warning" | "neutral";

export function LinkStatus({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: LinkStatusTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs",
        tone === "ready"
          ? "text-status-ok"
          : tone === "warning"
            ? "text-status-warn"
            : "text-muted-foreground",
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

/** Every service owns one directory entry and the same expandable management surface. */
export function LinkProviderCard({
  id,
  name,
  description,
  icon: Icon,
  brandClass,
  brandText,
  status,
  tone,
  accounts,
  children,
  hidden = false,
}: {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
  brandClass: string;
  brandText?: string;
  status: string;
  tone?: LinkStatusTone;
  accounts?: string;
  children: React.ReactNode;
  hidden?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const detailsId = React.useId();
  return (
    <article
      hidden={hidden}
      data-link-provider-card={id}
      data-link-integration={id}
      className={cn(
        "min-w-0 self-start overflow-hidden rounded-xl border border-border/70 bg-card",
        open && "lg:col-span-2",
      )}
    >
      <button
        type="button"
        data-link-provider-toggle
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-start gap-3 p-4 text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span
          className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", brandClass)}
        >
          {id === "github" || id === "figma" ? (
            <Icon className="size-5" aria-hidden />
          ) : (
            <span aria-hidden className="text-sm font-semibold">
              {brandText ?? name.slice(0, 1)}
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1 space-y-1.5">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold">{name}</span>
            <LinkStatus tone={tone}>{status}</LinkStatus>
          </span>
          <span className="block text-xs leading-5 text-muted-foreground">{description}</span>
          {accounts && (
            <span className="block truncate text-xs text-muted-foreground" title={accounts}>
              {accounts}
            </span>
          )}
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      <div
        id={detailsId}
        data-link-provider-details={id}
        hidden={!open}
        className="border-t border-border/70 px-4 pb-1"
      >
        {children}
      </div>
    </article>
  );
}

/** Shared connection rows keep purposes, status, and actions aligned across providers. */
export function LinkConnectionRow({
  title,
  description,
  technical,
  status,
  tone,
  actions,
  children,
  ...attributes
}: {
  title: string;
  description?: string;
  technical?: string;
  status?: string;
  tone?: LinkStatusTone;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  [key: `data-${string}`]: unknown;
}) {
  return (
    <section {...attributes} className="space-y-3 border-b border-border/60 py-4 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h5 className="text-sm font-medium">{title}</h5>
            {technical && <span className="text-xs text-muted-foreground">{technical}</span>}
          </div>
          {description && (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
          )}
        </div>
        {status && <LinkStatus tone={tone}>{status}</LinkStatus>}
      </div>
      {children}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </section>
  );
}
