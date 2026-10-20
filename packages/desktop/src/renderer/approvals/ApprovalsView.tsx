import React, { useId, useMemo, useState } from "react";
import { CheckCircle2, History, Search, ShieldCheck, X, XCircle } from "lucide-react";
import type { ApprovalRequestEnvelope } from "../../preload/types";
import { ApprovalCard } from "./ApprovalCard";
import { approvalKey, approvalMatches, approvalSummary } from "./approvalRecords";
import type { ApproveChoice, ApprovePathScope } from "./approvalDecision";
import { useT } from "../i18n/I18nProvider";
import { Button } from "@/components/ui/button";
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
  ) => void | Promise<void>;
}

const PAGE_SIZE = 50;

export function ApprovalsView({ queue, history, onDecide }: Props) {
  const { t, lang } = useT();
  const pendingHeadingId = useId();
  const historyHeadingId = useId();
  const searchId = useId();
  const [search, setSearch] = useState("");
  const [decision, setDecision] = useState<"all" | "approve" | "deny">("all");
  const [pendingLimit, setPendingLimit] = useState(PAGE_SIZE);
  const [historyLimit, setHistoryLimit] = useState(PAGE_SIZE);
  const query = search.trim().toLocaleLowerCase();
  const filteredQueue = useMemo(
    () => queue.filter((envelope) => approvalMatches(envelope, query)),
    [queue, query],
  );
  const filteredHistory = useMemo(
    () =>
      history
        .map((entry, index) => ({ entry, index }))
        .filter(
          ({ entry }) =>
            (decision === "all" || entry.decision === decision) &&
            approvalMatches(entry.envelope, query, entry.reason),
        )
        .sort((a, b) => {
          const timeA = Number.isFinite(new Date(a.entry.at).getTime()) ? a.entry.at : -Infinity;
          const timeB = Number.isFinite(new Date(b.entry.at).getTime()) ? b.entry.at : -Infinity;
          return timeB - timeA || b.index - a.index;
        }),
    [history, decision, query],
  );
  const visibleQueue = filteredQueue.slice(0, pendingLimit);
  const visibleHistory = filteredHistory.slice(0, historyLimit);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background" data-approvals-page>
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

      <div className="shrink-0 px-4 pb-4 sm:px-6">
        <div className="relative mx-auto max-w-5xl">
          <label htmlFor={searchId} className="sr-only">
            {t("activityApprovals.search")}
          </label>
          <Search
            size={16}
            aria-hidden
            className="pointer-events-none absolute left-3 top-3 text-muted-foreground"
          />
          <input
            id={searchId}
            type="search"
            value={search}
            placeholder={t("activityApprovals.search")}
            onChange={(event) => {
              setSearch(event.target.value);
              setPendingLimit(PAGE_SIZE);
              setHistoryLimit(PAGE_SIZE);
            }}
            className="h-10 w-full min-w-0 rounded-xl border border-input bg-background pl-9 pr-10 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {search && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute right-1 top-1 size-8"
              aria-label={t("activityApprovals.clearSearch")}
              onClick={() => {
                setSearch("");
                setPendingLimit(PAGE_SIZE);
                setHistoryLimit(PAGE_SIZE);
              }}
            >
              <X size={14} aria-hidden />
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6">
        <div className="mx-auto min-w-0 max-w-5xl space-y-6">
          <section aria-labelledby={pendingHeadingId}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2
                id={pendingHeadingId}
                className="flex flex-wrap items-center gap-2 text-sm font-semibold"
              >
                {t("auto.approvals.pending")}
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs tabular-nums text-primary">
                  {queue.length}
                </span>
              </h2>
              {query && (
                <p className="text-xs text-muted-foreground" role="status">
                  {t("activityApprovals.matching", {
                    count: filteredQueue.length,
                    total: queue.length,
                  })}
                </p>
              )}
            </div>
            {visibleQueue.length === 0 ? (
              <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card/70 p-5 text-sm text-muted-foreground">
                {queue.length === 0 ? (
                  <CheckCircle2 size={20} className="shrink-0 text-status-ok" aria-hidden />
                ) : (
                  <Search size={20} className="shrink-0" aria-hidden />
                )}
                {t(queue.length === 0 ? "auto.approvals.noPending" : "activityApprovals.noMatches")}
              </div>
            ) : (
              <ul className="min-w-0 space-y-3">
                {visibleQueue.map((env) => (
                  <li key={approvalKey(env)} className="min-w-0">
                    <ApprovalCard
                      envelope={env}
                      onDecide={(d, r, s, ps) => onDecide(env, d, r, s, ps)}
                    />
                  </li>
                ))}
              </ul>
            )}
            {filteredQueue.length > visibleQueue.length && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {t("activityApprovals.showing", {
                    count: visibleQueue.length,
                    total: filteredQueue.length,
                  })}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setPendingLimit((limit) => limit + PAGE_SIZE)}
                >
                  {t("activityApprovals.loadMore")}
                </Button>
              </div>
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
              <select
                aria-label={t("activityApprovals.decisionFilter")}
                value={decision}
                onChange={(event) => {
                  setDecision(event.target.value as typeof decision);
                  setHistoryLimit(PAGE_SIZE);
                }}
                className="h-9 max-w-full rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="all">{t("activityApprovals.allDecisions")}</option>
                <option value="approve">{t("auto.approvals.approved")}</option>
                <option value="deny">{t("auto.approvals.denied")}</option>
              </select>
            </div>
            {(query || decision !== "all") && (
              <p className="mb-3 text-xs text-muted-foreground" role="status">
                {t("activityApprovals.matching", {
                  count: filteredHistory.length,
                  total: history.length,
                })}
              </p>
            )}
            {visibleHistory.length === 0 ? (
              <div className="flex items-center gap-3 rounded-2xl border border-dashed border-border/70 bg-muted/20 p-5 text-sm text-muted-foreground">
                <History size={20} className="shrink-0" aria-hidden />
                {t(
                  history.length === 0 ? "auto.approvals.noHistory" : "activityApprovals.noMatches",
                )}
              </div>
            ) : (
              <ul className="min-w-0 space-y-3">
                {visibleHistory.map(({ entry, index }) => {
                  const approved = entry.decision === "approve";
                  const StatusIcon = approved ? CheckCircle2 : XCircle;
                  const date = new Date(entry.at);
                  const hasTime = Number.isFinite(date.getTime());
                  return (
                    <li
                      key={`${approvalKey(entry.envelope)}:${entry.at}:${index}`}
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
                          dateTime={hasTime ? date.toISOString() : undefined}
                          className="text-xs tabular-nums text-muted-foreground"
                        >
                          {hasTime
                            ? date.toLocaleString(lang === "zh" ? "zh-CN" : "en-US", {
                                dateStyle: "medium",
                                timeStyle: "short",
                              })
                            : t("activityApprovals.unknownTime")}
                        </time>
                      </div>
                      <pre
                        tabIndex={0}
                        aria-label={t("auto.approvals.request")}
                        className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/40 p-3 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
                      >
                        {approvalSummary(entry.envelope)}
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
                      <HistoryDetails envelope={entry.envelope} />
                    </li>
                  );
                })}
              </ul>
            )}
            {filteredHistory.length > visibleHistory.length && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {t("activityApprovals.showing", {
                    count: visibleHistory.length,
                    total: filteredHistory.length,
                  })}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setHistoryLimit((limit) => limit + PAGE_SIZE)}
                >
                  {t("activityApprovals.loadMore")}
                </Button>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function HistoryDetails({ envelope }: { envelope: ApprovalRequestEnvelope }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <details className="min-w-0 text-xs" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {t("activityApprovals.details")}
      </summary>
      {open && (
        <>
          <dl className="mt-3 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
            <dt className="text-muted-foreground">{t("activityApprovals.requestId")}</dt>
            <dd className="min-w-0 font-mono [overflow-wrap:anywhere]">{envelope.requestId}</dd>
            {envelope.sessionId && (
              <>
                <dt className="text-muted-foreground">{t("activityApprovals.session")}</dt>
                <dd className="min-w-0 font-mono [overflow-wrap:anywhere]">{envelope.sessionId}</dd>
              </>
            )}
          </dl>
          {envelope.request.description && (
            <p className="mt-3 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {envelope.request.description}
            </p>
          )}
          <pre
            tabIndex={0}
            aria-label={t("auto.approvalCard.rawArgs")}
            className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/40 p-3 font-mono leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
          >
            {JSON.stringify(envelope.request.args ?? {}, null, 2)}
          </pre>
        </>
      )}
    </details>
  );
}
