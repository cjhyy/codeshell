import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT, type TFunction } from "../i18n/I18nProvider";

type PluginInstallJob = Awaited<ReturnType<typeof window.codeshell.listPluginInstallJobs>>[number];

interface Props {
  jobs: PluginInstallJob[];
  onRetry: (id: string) => void | Promise<void>;
}

const INSTALLED_VISIBLE_MS = 12_000;

function statusLabel(status: PluginInstallJob["status"], t: TFunction): string {
  if (status === "queued") return t("ext.market.jobQueued");
  if (status === "installing") return t("ext.market.jobInstalling");
  if (status === "installed") return t("ext.market.jobInstalled");
  return t("ext.market.jobFailed");
}

function statusBadgeVariant(
  status: PluginInstallJob["status"],
): "secondary" | "info" | "success" | "error" {
  if (status === "installing") return "info";
  if (status === "installed") return "success";
  if (status === "failed") return "error";
  return "secondary";
}

function StatusIcon({ status }: { status: PluginInstallJob["status"] }) {
  if (status === "installing") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-status-running" aria-hidden="true" />;
  }
  if (status === "installed") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-status-ok" aria-hidden="true" />;
  }
  if (status === "failed") {
    return <AlertTriangle className="h-3.5 w-3.5 text-status-err" aria-hidden="true" />;
  }
  return <Clock3 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />;
}

function isVisibleJob(job: PluginInstallJob, now: number): boolean {
  if (job.status === "queued" || job.status === "installing" || job.status === "failed") {
    return true;
  }
  return typeof job.finishedAt === "number" && now - job.finishedAt < INSTALLED_VISIBLE_MS;
}

function summaryJob(jobs: PluginInstallJob[]): PluginInstallJob | undefined {
  return (
    jobs.find((job) => job.status === "installing") ??
    jobs.find((job) => job.status === "queued") ??
    jobs.find((job) => job.status === "failed") ??
    jobs.find((job) => job.status === "installed")
  );
}

function summaryLabel(job: PluginInstallJob, t: TFunction): string {
  if (job.status === "installing") {
    return t("ext.market.installSummaryInstalling", {
      plugin: job.pluginName,
      marketplace: job.marketplaceName,
    });
  }
  if (job.status === "queued") {
    return t("ext.market.installSummaryQueued", {
      plugin: job.pluginName,
      marketplace: job.marketplaceName,
    });
  }
  if (job.status === "installed") {
    return t("ext.market.installSummaryInstalled", { plugin: job.pluginName });
  }
  return t("ext.market.installSummaryFailed", { plugin: job.pluginName });
}

function nextInstalledExpiryDelay(jobs: PluginInstallJob[], now: number): number | undefined {
  const delays = jobs
    .filter((job) => job.status === "installed" && typeof job.finishedAt === "number")
    .map((job) => (job.finishedAt ?? 0) + INSTALLED_VISIBLE_MS - now)
    .filter((delay) => delay > 0);
  if (delays.length === 0) return undefined;
  return Math.min(...delays);
}

export function PluginInstallJobsPanel({ jobs, onRetry }: Props) {
  const { t } = useT();
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hoverOnly = useRef(false);
  const restoreFocus = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const enter = () => {
    cancelClose();
    if (!open) {
      restoreFocus.current = false;
      hoverOnly.current = true;
      setOpen(true);
    }
  };
  const leave = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (
        !hoverOnly.current ||
        triggerRef.current?.contains(document.activeElement) ||
        contentRef.current?.contains(document.activeElement)
      )
        return;
      setOpen(false);
    }, 120);
  };
  useEffect(() => () => cancelClose(), []);

  useEffect(() => {
    setNow(Date.now());
  }, [jobs]);

  useEffect(() => {
    const delay = nextInstalledExpiryDelay(jobs, now);
    if (delay === undefined) return;
    const timeout = window.setTimeout(() => setNow(Date.now()), delay + 50);
    return () => window.clearTimeout(timeout);
  }, [jobs, now]);

  const visibleJobs = useMemo(() => jobs.filter((job) => isVisibleJob(job, now)), [jobs, now]);
  const summary = summaryJob(visibleJobs);
  const hasVisibleJobs = visibleJobs.length > 0;
  useEffect(() => {
    if (hasVisibleJobs) return;
    cancelClose();
    hoverOnly.current = false;
    restoreFocus.current = false;
    setOpen(false);
  }, [hasVisibleJobs]);
  if (!summary) return null;

  return (
    <div className="ml-auto min-w-0 max-w-full shrink-0">
      <Popover
        open={open}
        onOpenChange={(next) => {
          restoreFocus.current = !next && !!contentRef.current?.contains(document.activeElement);
          cancelClose();
          hoverOnly.current = false;
          setOpen(next);
        }}
      >
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            onMouseEnter={enter}
            onMouseLeave={leave}
            onClick={(event) => {
              // The first click pins an already-hovered list instead of toggling it shut.
              if (open && hoverOnly.current) event.preventDefault();
              hoverOnly.current = false;
            }}
            type="button"
            className="flex h-8 w-full max-w-[22rem] items-center gap-2 rounded-md border bg-background px-2.5 text-xs text-foreground shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={t("ext.market.installJobsHover")}
            aria-label={t("ext.market.installJobsHover")}
          >
            <StatusIcon status={summary.status} />
            <span className="min-w-0 truncate">{summaryLabel(summary, t)}</span>
            <Badge variant="secondary" className="h-5 shrink-0 px-1.5">
              {visibleJobs.length}
            </Badge>
          </button>
        </PopoverTrigger>
        <PopoverContent
          ref={contentRef}
          align="end"
          aria-label={t("ext.market.installJobsTitle")}
          className="flex w-[min(28rem,calc(100vw-2rem))] flex-col overflow-hidden p-2"
          onMouseEnter={cancelClose}
          onMouseLeave={leave}
          onFocusCapture={() => {
            hoverOnly.current = false;
          }}
          onOpenAutoFocus={(event) => {
            if (hoverOnly.current) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            // Passive hover must not move focus away from the user's current field.
            event.preventDefault();
            if (restoreFocus.current) triggerRef.current?.focus({ preventScroll: true });
          }}
        >
          <div className="mb-2 flex shrink-0 items-center justify-between gap-3 px-1">
            <div className="text-sm font-medium">{t("ext.market.installJobsTitle")}</div>
            <Badge variant="secondary">
              {t("ext.market.installJobsCount", { count: visibleJobs.length })}
            </Badge>
          </div>
          <ul className="min-h-0 max-h-72 space-y-1 overflow-y-auto overscroll-contain pr-1">
            {visibleJobs.map((job) => (
              <li
                key={job.id}
                className="flex items-center gap-3 rounded-md bg-muted/40 px-2 py-2 text-xs"
              >
                <StatusIcon status={job.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium text-foreground">{job.pluginName}</span>
                    <span className="truncate text-muted-foreground">@{job.marketplaceName}</span>
                  </div>
                  {job.error && <div className="mt-0.5 truncate text-status-err">{job.error}</div>}
                </div>
                <Badge variant={statusBadgeVariant(job.status)} className="shrink-0">
                  {statusLabel(job.status, t)}
                </Badge>
                {job.status === "failed" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2"
                    onClick={() => void onRetry(job.id)}
                  >
                    {t("ext.market.retryInstall")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}
