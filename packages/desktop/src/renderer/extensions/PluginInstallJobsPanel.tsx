import { AlertTriangle, CheckCircle2, Clock3, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT, type TFunction } from "../i18n/I18nProvider";

type PluginInstallJob = Awaited<
  ReturnType<typeof window.codeshell.listPluginInstallJobs>
>[number];

interface Props {
  jobs: PluginInstallJob[];
  onRetry: (id: string) => void | Promise<void>;
}

function statusLabel(status: PluginInstallJob["status"], t: TFunction): string {
  if (status === "queued") return t("ext.market.jobQueued");
  if (status === "installing") return t("ext.market.jobInstalling");
  if (status === "installed") return t("ext.market.jobInstalled");
  return t("ext.market.jobFailed");
}

function statusBadgeVariant(status: PluginInstallJob["status"]): "secondary" | "info" | "success" | "error" {
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

export function PluginInstallJobsPanel({ jobs, onRetry }: Props) {
  const { t } = useT();
  if (jobs.length === 0) return null;

  return (
    <section className="mb-3 rounded-md border bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-sm font-medium">{t("ext.market.installJobsTitle")}</div>
        <Badge variant="secondary">{t("ext.market.installJobsCount", { count: jobs.length })}</Badge>
      </div>
      <ul className="space-y-1">
        {jobs.map((job) => (
          <li key={job.id} className="flex items-center gap-3 rounded-md bg-muted/40 px-2 py-2 text-xs">
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
              <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => void onRetry(job.id)}>
                {t("ext.market.retryInstall")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
