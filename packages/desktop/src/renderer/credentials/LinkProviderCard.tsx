import React from "react";
import { ArrowUpRight, ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import { LinkServiceIcon } from "./LinkServiceIcon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LinkPresentationContext, type LinkPrimaryAction } from "./LinkPresentation";

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

/** Directory entries stay compact; each application owns a separate management dialog. */
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
  connectionCount = 0,
  primaryOption,
  hasConnections = false,
  localOnly = false,
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
  connectionCount?: number;
  primaryOption?: string;
  hasConnections?: boolean;
  localOnly?: boolean;
  children: React.ReactNode;
  hidden?: boolean;
}) {
  const { t } = useT();
  const [open, setOpen] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);
  const [action, setAction] = React.useState<LinkPrimaryAction>();
  const trigger = React.useRef<HTMLButtonElement | null>(null);
  const title = React.useRef<HTMLHeadingElement>(null);
  const showDetails = (event: React.MouseEvent<HTMLButtonElement>) => {
    trigger.current = event?.currentTarget ?? null;
    setAdvanced(false);
    setOpen(true);
  };
  const context = React.useMemo(
    () => ({ primaryOption, advanced: advanced || !primaryOption, registerAction: setAction }),
    [primaryOption, advanced],
  );
  const detailsId = React.useId();
  const advancedId = React.useId();
  return (
    <LinkPresentationContext.Provider value={context}>
      <Dialog open={open} onOpenChange={setOpen}>
        <article
          hidden={hidden}
          data-link-provider-card={id}
          data-link-integration={id}
          className="group min-w-0 self-start rounded-2xl border border-border/65 bg-card transition-[border-color,box-shadow] hover:border-primary/30 hover:shadow-sm"
        >
          <div className="flex w-full min-w-0 flex-col gap-4 p-5 text-left">
            <span className="flex w-full min-w-0 items-center gap-3">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border/55 bg-background shadow-sm">
                <LinkServiceIcon providerId={id} name={name} className="size-6" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{name}</span>
                {category && (
                  <span
                    className="mt-1 block truncate text-xs text-muted-foreground"
                    title={category}
                  >
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
                {accounts || t("ext.link.directory.connectHint")}
              </span>
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {!hasConnections && primaryOption && (
                <Button
                  size="sm"
                  data-link-primary-connect={id}
                  aria-haspopup="dialog"
                  aria-controls={detailsId}
                  data-state={open ? "open" : "closed"}
                  onClick={showDetails}
                >
                  {t(
                    localOnly
                      ? "ext.link.directory.connectAppLocally"
                      : "ext.link.directory.connectApp",
                    { name },
                  )}
                </Button>
              )}
              {(hasConnections || !primaryOption) && (
                <button
                  type="button"
                  data-link-provider-toggle
                  aria-haspopup="dialog"
                  aria-controls={detailsId}
                  data-state={open ? "open" : "closed"}
                  onClick={showDetails}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t(
                    hasConnections
                      ? "ext.link.directory.manageConnection"
                      : "ext.link.directory.viewDetails",
                  )}
                  <ArrowUpRight aria-hidden className="size-3.5" />
                </button>
              )}
            </div>
          </div>
        </article>
        <DialogContent
          id={detailsId}
          data-link-provider-dialog={id}
          className="max-w-[560px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-2xl p-0"
          onEscapeKeyDown={(event) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest('[data-link-account-menu-open="true"]')) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            title.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus({ preventScroll: true });
          }}
        >
          <DialogHeader className="border-b border-border/60 p-4 pr-10 text-left sm:p-6 sm:pr-12 sm:text-left [@media(max-height:420px)]:p-3 [@media(max-height:420px)]:pr-10">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border/55 bg-background [@media(max-height:420px)]:size-9">
                <LinkServiceIcon providerId={id} name={name} className="size-6" />
              </span>
              <div className="min-w-0 flex-1">
                <DialogTitle
                  ref={title}
                  tabIndex={-1}
                  className="break-words leading-6 outline-none"
                >
                  {name}
                </DialogTitle>
                {connectionCount > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("ext.link.directory.connectionCount", { count: connectionCount })}
                  </p>
                )}
              </div>
              <LinkStatus tone={tone}>{status}</LinkStatus>
            </div>
            <DialogDescription className="pt-2 text-xs leading-5 [@media(max-height:420px)]:sr-only [@media(max-height:420px)]:p-0">
              {description}
            </DialogDescription>
          </DialogHeader>
          <div
            id={advancedId}
            data-link-provider-details={id}
            className="min-h-0 min-w-0 overflow-y-auto overscroll-contain px-4 [overflow-wrap:anywhere] sm:px-6"
          >
            {primaryOption && (
              <p hidden={!advanced} className="pt-4 text-xs leading-5 text-muted-foreground">
                {t("ext.link.directory.advancedHint")}
              </p>
            )}
            {children}
          </div>
          <DialogFooter className="flex-row flex-wrap items-center justify-between gap-2 border-t border-border/60 bg-muted/20 px-4 py-3 sm:justify-between sm:space-x-0 sm:px-6 sm:py-4 [@media(max-height:420px)]:py-3">
            {primaryOption ? (
              <button
                type="button"
                data-link-advanced-toggle={id}
                aria-expanded={advanced}
                aria-controls={advancedId}
                onClick={() => setAdvanced((value) => !value)}
                className="inline-flex items-center gap-1.5 rounded-md py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("ext.link.directory.otherConnections")}
                <ChevronDown
                  aria-hidden
                  className={cn("size-3 transition-transform", advanced && "rotate-180")}
                />
              </button>
            ) : (
              <span />
            )}
            <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                data-link-dialog-close={id}
                onClick={() => setOpen(false)}
              >
                {t("ext.link.directory.closeDialog")}
              </Button>
              {!hasConnections && primaryOption && (
                <Button
                  size="sm"
                  data-link-dialog-connect={id}
                  className="h-auto min-h-8 min-w-0 max-w-full whitespace-normal"
                  disabled={!action || action.disabled}
                  onClick={() => action?.onClick()}
                >
                  {t("ext.link.remoteConnect")}
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LinkPresentationContext.Provider>
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
  hidden?: boolean;
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
