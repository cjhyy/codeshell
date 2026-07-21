import React from "react";
import {
  ChevronDown,
  Clock3,
  ExternalLink,
  History,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Square,
} from "lucide-react";
import type { PetLongTask, PetLongTaskControlAction } from "../../preload/types";
import { useT } from "../i18n";
import { Markdown } from "../Markdown";
import { useOptionalPetState } from "./PetStateProvider";

const LONG_DETAIL_COLLAPSE_CHARS = 480;
const LONG_DETAIL_COLLAPSE_LINES = 8;

export function isLongTaskDetailCollapsible(detail: string): boolean {
  return (
    detail.length > LONG_DETAIL_COLLAPSE_CHARS ||
    detail.split(/\r?\n/u).length > LONG_DETAIL_COLLAPSE_LINES
  );
}

const STATUS_STYLE: Record<PetLongTask["status"], string> = {
  queued: "bg-status-running/10 text-status-running",
  running: "bg-status-running/10 text-status-running",
  waiting: "bg-status-warn/10 text-status-warn",
  paused: "bg-muted text-muted-foreground",
  interrupted: "bg-status-warn/10 text-status-warn",
  completed: "bg-status-ok/10 text-status-ok",
  failed: "bg-status-err/10 text-status-err",
  cancelled: "bg-muted text-muted-foreground",
};

function taskActions(task: PetLongTask): PetLongTaskControlAction[] {
  switch (task.status) {
    case "queued":
    case "running":
    case "waiting":
      return ["pause", "cancel"];
    case "paused":
      return ["resume", "cancel"];
    case "interrupted":
      return ["resume", "retry", "cancel"];
    case "failed":
      return ["retry", "cancel"];
    default:
      return [];
  }
}

const ACTION_ICON = {
  pause: Pause,
  resume: Play,
  retry: RotateCcw,
  cancel: Square,
} satisfies Record<PetLongTaskControlAction, typeof Pause>;

export function PetLongTaskCard({
  task,
  busy,
  onOpenSession,
  onControl,
}: {
  task: PetLongTask;
  busy: boolean;
  onOpenSession?: (sessionId: string) => void;
  onControl: (taskId: string, action: PetLongTaskControlAction) => void;
}) {
  const { t } = useT();
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [detailExpanded, setDetailExpanded] = React.useState(false);
  const actions = taskActions(task);
  const recentEvents = task.events.slice(-6).reverse();
  const detail = task.waitingFor ?? task.lastError ?? task.summary;
  const detailCollapsible = Boolean(
    detail && !task.waitingFor && isLongTaskDetailCollapsible(detail),
  );
  const detailCollapsed = detailCollapsible && !detailExpanded;
  return (
    <article
      data-pet-long-task={task.id}
      className="rounded-2xl border border-border/60 bg-background/60 p-3 shadow-[0_1px_2px_hsl(var(--cs-foreground)/0.035)]"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={`mt-0.5 rounded-full px-2 py-1 text-[10px] font-semibold ${STATUS_STYLE[task.status]}`}
        >
          {t(`pet.longTask.status.${task.status}`)}
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="line-clamp-2 text-sm font-semibold leading-5" title={task.objective}>
            {task.objective}
          </h4>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span>{t(`pet.longTask.phase.${task.phase}`)}</span>
            <span aria-hidden="true">·</span>
            <span>{t("pet.longTask.attempt", { count: task.attempt })}</span>
          </div>
        </div>
      </div>

      {detail && (
        <div
          data-pet-long-task-detail={detailCollapsed ? "collapsed" : "expanded"}
          className={`mt-2 rounded-xl px-3 py-2 text-xs leading-5 ${
            task.waitingFor || task.lastError
              ? "bg-status-warn/8 text-foreground"
              : "bg-muted/55 text-muted-foreground"
          }`}
        >
          <div className="relative">
            <div className={detailCollapsed ? "max-h-48 overflow-hidden" : undefined}>
              <div
                className={
                  task.waitingFor || task.lastError
                    ? "[&>div]:!max-w-none [&>div]:!text-xs [&>div]:!leading-5 [&>div]:!text-foreground [&_p]:!my-1.5 [&_p:first-child]:!mt-0 [&_p:last-child]:!mb-0"
                    : "[&>div]:!max-w-none [&>div]:!text-xs [&>div]:!leading-5 [&>div]:!text-muted-foreground [&_p]:!my-1.5 [&_p:first-child]:!mt-0 [&_p:last-child]:!mb-0"
                }
              >
                <Markdown text={detail} cwd={task.workspacePath} />
              </div>
            </div>
            {detailCollapsed && (
              <span
                className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-muted to-transparent"
                aria-hidden="true"
              />
            )}
          </div>
          {detailCollapsible && (
            <button
              type="button"
              aria-expanded={detailExpanded}
              className="mt-1.5 flex w-full items-center justify-center gap-1.5 border-t border-border/45 pt-2 text-[11px] font-medium text-primary transition hover:text-primary/80"
              onClick={() => setDetailExpanded((value) => !value)}
            >
              {t(detailExpanded ? "pet.longTask.collapseResult" : "pet.longTask.expandResult")}
              <ChevronDown
                size={12}
                aria-hidden="true"
                className={`transition-transform ${detailExpanded ? "rotate-180" : ""}`}
              />
            </button>
          )}
        </div>
      )}
      {task.nextAction && (
        <div className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
          <Clock3 size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-medium text-foreground">{t("pet.longTask.nextAction")}</span>{" "}
            {task.nextAction}
          </span>
        </div>
      )}

      {task.artifacts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label={t("pet.longTask.artifacts")}>
          {task.artifacts.slice(0, 6).map((artifact) => (
            <button
              key={`${artifact.kind}:${artifact.reference}`}
              type="button"
              className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border/55 bg-background px-2 py-1 text-[11px] text-muted-foreground transition hover:text-foreground disabled:cursor-default"
              disabled={artifact.kind !== "session" && artifact.kind !== "result"}
              title={artifact.reference}
              onClick={() => onOpenSession?.(task.sessionId)}
            >
              <ExternalLink size={11} aria-hidden="true" />
              <span className="truncate">{artifact.label}</span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/45 pt-2.5">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
          onClick={() => onOpenSession?.(task.sessionId)}
        >
          <ExternalLink size={12} aria-hidden="true" />
          {t("pet.longTask.openSession")}
        </button>
        {recentEvents.length > 0 && (
          <button
            type="button"
            aria-expanded={historyOpen}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
            onClick={() => setHistoryOpen((value) => !value)}
          >
            <History size={12} aria-hidden="true" />
            {t("pet.longTask.history")}
            <ChevronDown
              size={11}
              aria-hidden="true"
              className={`transition-transform ${historyOpen ? "rotate-180" : ""}`}
            />
          </button>
        )}
        <span className="min-w-2 flex-1" />
        {actions.map((action) => {
          const Icon = ACTION_ICON[action];
          return (
            <button
              key={action}
              type="button"
              data-pet-long-task-control={action}
              disabled={busy}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] transition disabled:opacity-50 ${
                action === "cancel"
                  ? "text-status-err hover:bg-status-err/10"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
              onClick={() => onControl(task.id, action)}
            >
              {busy ? (
                <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />
              ) : (
                <Icon size={12} aria-hidden="true" />
              )}
              {t(`pet.longTask.action.${action}`)}
            </button>
          );
        })}
      </div>

      {historyOpen && (
        <ol className="mt-2 space-y-1.5 rounded-xl bg-muted/35 p-2.5">
          {recentEvents.map((event) => (
            <li key={event.id} className="flex items-start gap-2 text-[11px] leading-4">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/55" />
              <span className="min-w-0 text-muted-foreground">
                <span className="font-medium text-foreground">
                  {t(`pet.longTask.event.${event.kind}`)}
                </span>
                {event.message ? ` — ${event.message}` : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

export function PetLongTaskSection({
  onOpenSession,
}: {
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useT();
  const { longTasks, longTaskBusyIds, longTaskError, controlLongTask } = useOptionalPetState();
  const activeCount = longTasks.tasks.filter(
    (task) =>
      task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled",
  ).length;
  const [open, setOpen] = React.useState(activeCount > 0);
  React.useEffect(() => {
    if (activeCount > 0) setOpen(true);
  }, [activeCount]);
  if (longTasks.tasks.length === 0 && !longTaskError) return null;
  return (
    <section
      data-pet-long-tasks="durable"
      className="rounded-2xl border border-border/60 bg-background/45 p-1"
    >
      <h3>
        <button
          type="button"
          aria-expanded={open}
          className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left transition hover:bg-muted/55"
          onClick={() => setOpen((value) => !value)}
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Clock3 size={16} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">{t("pet.longTask.title")}</span>
            <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
              {activeCount > 0
                ? t("pet.longTask.activeSummary", { count: activeCount })
                : t("pet.longTask.noActive")}
            </span>
          </span>
          <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-semibold text-primary">
            {longTasks.tasks.length}
          </span>
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={`text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </h3>
      {open && (
        <div className="space-y-2 px-1.5 pb-1.5 pt-2">
          {longTaskError && (
            <p className="rounded-xl bg-status-err/10 px-3 py-2 text-xs text-status-err">
              {longTaskError}
            </p>
          )}
          {longTasks.tasks.slice(0, 24).map((task) => (
            <PetLongTaskCard
              key={task.id}
              task={task}
              busy={longTaskBusyIds.has(task.id)}
              onOpenSession={onOpenSession}
              onControl={(taskId, action) => void controlLongTask(taskId, action)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
