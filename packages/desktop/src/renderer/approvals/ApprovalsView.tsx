import React, { useId } from "react";
import { CheckCircle2, History, ShieldCheck, XCircle } from "lucide-react";
import type { ApprovalRequestEnvelope } from "../../preload/types";
import { ApprovalCard } from "./ApprovalCard";
import type { ApproveChoice, ApprovePathScope } from "./approvalDecision";
import { useT } from "../i18n/I18nProvider";
import { cn } from "@/lib/utils";

interface Props {
  queue: ApprovalRequestEnvelope[];
  history: {
    decision: "approve" | "deny";
    envelope: ApprovalRequestEnvelope;
    reason?: string;
    at: number;
  }[];
  onDecide: (
    env: ApprovalRequestEnvelope,
    decision: "approve" | "deny",
    reason?: string,
    scope?: ApproveChoice,
    pathScope?: ApprovePathScope,
  ) => void;
}

export function ApprovalsView({ queue, history, onDecide }: Props) {
  const { t, lang } = useT();
  const pendingHeadingId = useId();
  const historyHeadingId = useId();
  const recentHistory = history.slice().reverse().slice(0, 50);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <header className="flex shrink-0 items-start gap-3 px-4 py-5 sm:px-6">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <ShieldCheck size={22} aria-hidden />
        </span>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{t("auto.approvals.title")}</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {t("auto.approvals.subtitle")}
          </p>
        </div>
      </header>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6">
        <div className="mx-auto min-w-0 max-w-5xl space-y-6">
          <section aria-labelledby={pendingHeadingId}>
            <h2
              id={pendingHeadingId}
              className="mb-3 flex flex-wrap items-center gap-2 text-sm font-semibold"
            >
              {t("auto.approvals.pending")}
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs tabular-nums text-primary">
                {queue.length}
              </span>
            </h2>
            {queue.length === 0 ? (
              <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card/70 p-5 text-sm text-muted-foreground">
                <CheckCircle2 size={20} className="shrink-0 text-status-ok" aria-hidden />
                {t("auto.approvals.noPending")}
              </div>
            ) : (
              <ul className="min-w-0 space-y-3">
                {queue.map((env) => (
                  <li key={env.requestId} className="min-w-0">
                    <ApprovalCard
                      envelope={env}
                      onDecide={(d, r, s, ps) => onDecide(env, d, r, s, ps)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby={historyHeadingId}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id={historyHeadingId} className="flex items-center gap-2 text-sm font-semibold">
                {t("auto.approvals.history")}
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
                  {history.length}
                </span>
              </h2>
              {history.length > recentHistory.length && (
                <p className="text-xs text-muted-foreground">
                  {t("auto.approvals.recentLimit", { count: recentHistory.length })}
                </p>
              )}
            </div>
            {history.length === 0 ? (
              <div className="flex items-center gap-3 rounded-2xl border border-dashed border-border/70 bg-muted/20 p-5 text-sm text-muted-foreground">
                <History size={20} className="shrink-0" aria-hidden />
                {t("auto.approvals.noHistory")}
              </div>
            ) : (
              <ul className="min-w-0 space-y-3">
                {recentHistory.map((entry) => {
                  const approved = entry.decision === "approve";
                  const StatusIcon = approved ? CheckCircle2 : XCircle;
                  const date = new Date(entry.at);
                  return (
                    <li
                      key={`${entry.envelope.sessionId}:${entry.envelope.requestId}:${entry.at}`}
                      className="min-w-0 space-y-3 rounded-2xl border border-border/70 bg-card p-4"
                    >
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-1 basis-52 flex-wrap items-center gap-2">
                          <span
                            className={cn(
                              "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium",
                              approved
                                ? "bg-status-ok/10 text-status-ok"
                                : "bg-status-err/10 text-status-err",
                            )}
                          >
                            <StatusIcon size={13} aria-hidden />
                            {t(approved ? "auto.approvals.approved" : "auto.approvals.denied")}
                          </span>
                          <span className="min-w-0 break-words font-mono text-xs font-medium [overflow-wrap:anywhere]">
                            {entry.envelope.request.toolName}
                          </span>
                        </div>
                        <time
                          dateTime={date.toISOString()}
                          className="text-xs tabular-nums text-muted-foreground"
                        >
                          {date.toLocaleString(lang === "zh" ? "zh-CN" : "en-US", {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </time>
                      </div>
                      <pre
                        tabIndex={0}
                        aria-label={t("auto.approvals.request")}
                        className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/40 p-3 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
                      >
                        {summarize(entry.envelope)}
                      </pre>
                      {entry.reason && (
                        <div>
                          <p className="mb-1 text-xs font-medium text-muted-foreground">
                            {t("auto.approvals.reason")}
                          </p>
                          <p
                            tabIndex={0}
                            aria-label={t("auto.approvals.reason")}
                            className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-lg text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
                          >
                            {entry.reason}
                          </p>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function summarize(env: ApprovalRequestEnvelope): string {
  const args = (env.request.args ?? {}) as Record<string, unknown>;
  for (const k of ["command", "file_path", "path", "url", "pattern", "query"] as const) {
    const v = args[k];
    if (typeof v === "string") return v;
  }
  return env.request.toolName;
}
