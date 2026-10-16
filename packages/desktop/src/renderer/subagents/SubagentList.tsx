import React, { useEffect, useId, useMemo, useState } from "react";
import { Bot, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, type TFunction } from "../i18n/I18nProvider";

export interface SubagentListItem {
  id: string;
  title: string;
  status: "active" | "paused" | "completed" | "failed" | "cancelled";
  startedAt?: number;
  endedAt?: number;
  updatedAt?: number;
}

interface Props {
  items: readonly SubagentListItem[];
  active?: boolean;
  loading?: boolean;
  error?: string | null;
  onSelect: (id: string) => void;
}

const groups = [
  { status: "active", label: "msg.agent.running" },
  { status: "completed", label: "msg.agent.completed" },
  { status: "failed", label: "msg.agent.failed" },
  { status: "paused", label: "msg.agent.paused" },
  { status: "cancelled", label: "msg.agent.cancelled" },
] as const;

const avatarTones = [
  "bg-violet-500/12 text-violet-600 dark:text-violet-300",
  "bg-sky-500/12 text-sky-600 dark:text-sky-300",
  "bg-emerald-500/12 text-emerald-600 dark:text-emerald-300",
  "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  "bg-rose-500/12 text-rose-600 dark:text-rose-300",
] as const;

function avatarTone(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return avatarTones[hash % avatarTones.length]!;
}

function validStamp(value?: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 8.64e15;
}

function compactDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function relativeTime(stamp: number, now: number, formatter: Intl.RelativeTimeFormat): string {
  const seconds = (stamp - now) / 1000;
  const span = Math.abs(seconds);
  if (span < 60) return formatter.format(Math.trunc(seconds), "second");
  if (span < 3600) return formatter.format(Math.trunc(seconds / 60), "minute");
  if (span < 86400) return formatter.format(Math.trunc(seconds / 3600), "hour");
  if (span < 365 * 86400) return formatter.format(Math.trunc(seconds / 86400), "day");
  return formatter.format(Math.trunc(seconds / (365 * 86400)), "year");
}

function itemTime(
  item: SubagentListItem,
  now: number,
  t: TFunction,
  relative: Intl.RelativeTimeFormat,
  absolute: Intl.DateTimeFormat,
): { text: string; title: string; kind: "elapsed" | "completed" | "ended" | "updated" } | null {
  const started = validStamp(item.startedAt) ? item.startedAt : undefined;
  const ended = validStamp(item.endedAt) ? item.endedAt : undefined;
  const endKind = item.status === "completed" ? "completed" : "ended";
  const endLabel = item.status === "completed" ? "msg.agent.completedAt" : "msg.agent.endedAt";
  if (item.status === "active" && started !== undefined) {
    const text = compactDuration(now - started);
    return {
      text,
      kind: "elapsed",
      title: [
        t("msg.agent.elapsedTime", { time: text }),
        t("msg.agent.startedAt", { time: absolute.format(started) }),
      ].join(" · "),
    };
  }
  if (ended !== undefined)
    return {
      text: relativeTime(ended, now, relative),
      title: [
        t(endLabel, { time: absolute.format(ended) }),
        ...(started !== undefined && ended >= started
          ? [t("msg.agent.elapsedTime", { time: compactDuration(ended - started) })]
          : []),
      ].join(" · "),
      kind: endKind,
    };
  if (validStamp(item.updatedAt))
    return {
      text: relativeTime(item.updatedAt, now, relative),
      title: t("msg.agent.updatedAt", { time: absolute.format(item.updatedAt) }),
      kind: "updated",
    };
  return null;
}

/** The parent owns catalog scope and navigation; this list only presents known children. */
export function SubagentList({ items, active = true, loading = false, error, onSelect }: Props) {
  const { t, lang } = useT();
  const id = useId();
  const [now, setNow] = useState(() => Date.now());
  const relative = useMemo(
    () =>
      new Intl.RelativeTimeFormat(lang === "zh" ? "zh-CN" : "en", {
        numeric: "auto",
        style: "short",
      }),
    [lang],
  );
  const absolute = useMemo(
    () =>
      new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", {
        dateStyle: "medium",
        timeStyle: "medium",
      }),
    [lang],
  );
  const hasLiveElapsed = items.some(
    (item) => item.status === "active" && validStamp(item.startedAt),
  );
  const hasRelativeTime = items.some((item) => {
    if (item.status === "active" && validStamp(item.startedAt)) return false;
    return validStamp(item.endedAt) || validStamp(item.updatedAt);
  });
  const interval = hasLiveElapsed ? 1000 : hasRelativeTime ? 60_000 : null;

  useEffect(() => {
    if (!active || interval === null) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") setNow(Date.now());
    }, interval);
    return () => clearInterval(timer);
  }, [active, interval]);

  return (
    <section
      data-subagent-list=""
      tabIndex={-1}
      aria-label={t("msg.agent.listTitle")}
      aria-busy={loading || undefined}
      aria-hidden={!active || undefined}
      inert={!active || undefined}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-3 py-4"
    >
      {error && (
        <div role="alert" className="break-words text-sm text-status-err [overflow-wrap:anywhere]">
          {t("msg.agent.listError", { error })}
        </div>
      )}
      {loading && (
        <div
          role="status"
          className={
            items.length > 0 ? "sr-only" : "flex items-center gap-2 text-sm text-muted-foreground"
          }
        >
          <LoaderCircle
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          {t("msg.agent.listLoading")}
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <div role="status" className="text-sm text-muted-foreground">
          {t("msg.agent.listEmpty")}
        </div>
      )}
      {groups.map(({ status, label }) => {
        const members = items.filter((item) => item.status === status);
        if (members.length === 0) return null;
        return (
          <section
            key={status}
            data-subagent-list-status={status}
            aria-labelledby={`${id}-${status}`}
            className="min-w-0"
          >
            <h2
              id={`${id}-${status}`}
              className={cn(
                "mb-2 flex items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground",
                status === "failed" && "text-status-err",
              )}
            >
              <span>{t(label)}</span>
              <span aria-hidden="true">·</span>
              <span>{members.length}</span>
            </h2>
            <ul className="min-w-0 space-y-1">
              {members.map((item, index) => {
                const title = item.title.trim() || t("msg.agent.fallbackName");
                const time = itemTime(item, now, t, relative, absolute);
                return (
                  <li key={item.id} className="min-w-0">
                    <button
                      type="button"
                      data-subagent-list-id={item.id}
                      onClick={() => {
                        if (active) onSelect(item.id);
                      }}
                      disabled={!active}
                      aria-label={t("msg.agent.listOpenConversation", { title })}
                      aria-describedby={time ? `${id}-${status}-${index}-time` : undefined}
                      title={title}
                      className={cn(
                        "flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none",
                        status === "active" && "bg-muted/60 hover:bg-muted/80",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex size-7 shrink-0 items-center justify-center rounded-full",
                          avatarTone(item.id),
                        )}
                      >
                        <Bot className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 w-full max-w-full break-words text-sm leading-5 text-foreground [overflow-wrap:anywhere]">
                          {title}
                        </span>
                      </span>
                      {time && (
                        <span
                          id={`${id}-${status}-${index}-time`}
                          data-subagent-time-kind={time.kind}
                          title={time.title}
                          aria-label={time.title}
                          className="max-w-24 shrink-0 break-words text-right text-xs leading-5 tabular-nums text-muted-foreground"
                        >
                          {time.text}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
