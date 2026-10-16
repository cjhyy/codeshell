import React from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import { LinkServiceIcon } from "./LinkServiceIcon";

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
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
        tone === "ready"
          ? "bg-status-ok/8 text-status-ok"
          : tone === "warning"
            ? "bg-status-warn/10 text-status-warn"
            : "bg-muted/65 text-muted-foreground",
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
  icon: _Icon,
  brandClass: _brandClass,
  brandText: _brandText,
  category,
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
  category?: string;
  status: string;
  tone?: LinkStatusTone;
  accounts?: string;
  children: React.ReactNode;
  hidden?: boolean;
}) {
  const { t } = useT();
  const [open, setOpen] = React.useState(false);
  const detailsId = React.useId();
  return (
    <article
      hidden={hidden}
      data-link-provider-card={id}
      data-link-integration={id}
      className={cn(
        "group min-w-0 self-start overflow-hidden rounded-2xl border border-border/65 bg-card transition-[border-color,box-shadow] hover:border-primary/30 hover:shadow-sm",
        open && "col-span-full border-primary/25",
      )}
    >
      <button
        type="button"
        data-link-provider-toggle
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 flex-col gap-4 p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex w-full min-w-0 items-center gap-3">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border/55 bg-background shadow-sm">
            <LinkServiceIcon providerId={id} name={name} className="size-6" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{name}</span>
            {category && (
              <span className="mt-1 block truncate text-xs text-muted-foreground" title={category}>
                {category}
              </span>
            )}
          </span>
          <LinkStatus tone={tone}>{status}</LinkStatus>
        </span>
        <span className="line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground">
          {description}
        </span>
        <span className="flex w-full min-w-0 items-center justify-between gap-3">
          <span className="min-w-0 truncate text-xs text-muted-foreground" title={accounts}>
            {accounts || t("ext.link.directory.chooseConnection")}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted/65 px-3 py-1.5 text-xs font-medium text-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
            {t(open ? "ext.link.directory.closeDetails" : "ext.link.directory.viewDetails")}
            <ChevronDown
              aria-hidden
              className={cn("size-3.5 transition-transform", open && "rotate-180")}
            />
          </span>
        </span>
      </button>
      <div
        id={detailsId}
        data-link-provider-details={id}
        hidden={!open}
        className="border-t border-border/60 bg-muted/15 px-5 pb-1"
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
    <section {...attributes} className="space-y-4 border-b border-border/55 py-5 last:border-b-0">
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
