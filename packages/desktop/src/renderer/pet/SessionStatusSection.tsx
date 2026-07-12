import type { PetSessionProjection } from "@cjhyy/code-shell-core";
import React from "react";
import { useT, type TFunction } from "../i18n";

export type PetSessionDisplayState =
  | "waiting"
  | "running"
  | "queued"
  | "idle"
  | "dormant"
  | "terminal"
  | "unknown";

export type PetSessionEmptyState =
  | "loading"
  | "empty"
  | "reclaimed"
  | "disconnected"
  | "stale"
  | "reconciling";

const STATE_TONE: Record<PetSessionDisplayState, string> = {
  waiting: "bg-status-warn text-status-warn",
  running: "bg-status-running text-status-running",
  queued: "bg-status-info text-status-info",
  idle: "bg-status-ok text-status-ok",
  dormant: "bg-muted-foreground text-muted-foreground",
  terminal: "bg-muted-foreground text-muted-foreground",
  unknown: "bg-muted-foreground text-muted-foreground",
};

export function sessionDisplayState(session: PetSessionProjection): PetSessionDisplayState {
  if (session.phase === "waiting-decision" || session.pendingDecisionCount > 0) return "waiting";
  return session.runState;
}

export function formatPetRelativeTime(t: TFunction, timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return t("pet.session.justNow");
  if (minutes < 60) return t("pet.session.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("pet.session.hoursAgo", { count: hours });
  return t("pet.session.daysAgo", { count: Math.floor(hours / 24) });
}

function bounded(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function SessionRow({ session, now }: { session: PetSessionProjection; now: number }) {
  const { t } = useT();
  const state = sessionDisplayState(session);
  const stateLabel = t(`pet.session.state.${state}`);
  const title = bounded(session.title, 80) ?? t("pet.session.untitled");
  const workspace = bounded(session.workspaceDisplayName, 48);
  const summary = bounded(session.summary, 120);
  const shortId = session.agentSessionId.slice(-8);
  const animated = state === "running" ? " animate-pulse motion-reduce:animate-none" : "";

  return (
    <li className="flex min-w-0 items-start gap-2 border-b border-border/60 px-2 py-2 last:border-b-0">
      <span
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${STATE_TONE[state]}${animated}`}
        aria-label={t("pet.session.stateAria", { state: stateLabel })}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate font-medium" title={session.title}>
            {title}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{stateLabel}</span>
        </div>
        <div className="flex min-w-0 gap-1 text-xs text-muted-foreground">
          {workspace && (
            <span className="max-w-40 truncate" title={session.workspaceDisplayName}>
              {workspace}
            </span>
          )}
          {workspace && <span aria-hidden="true">·</span>}
          <span className="font-mono">{shortId}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={new Date(session.lastActivityAt).toISOString()}>
            {formatPetRelativeTime(t, session.lastActivityAt, now)}
          </time>
        </div>
        {summary && (
          <p className="truncate text-xs text-muted-foreground" title={session.summary}>
            {summary}
          </p>
        )}
      </div>
    </li>
  );
}

export function SessionStatusSection({
  sessions,
  emptyState = "empty",
  now = Date.now(),
}: {
  sessions: readonly PetSessionProjection[];
  emptyState?: PetSessionEmptyState;
  now?: number;
}) {
  const { t } = useT();
  return (
    <section aria-labelledby="pet-session-heading" className="min-w-0">
      <h3
        id="pet-session-heading"
        className="px-2 py-1 text-xs font-semibold text-muted-foreground"
      >
        {t("pet.session.title")}
      </h3>
      {sessions.length > 0 ? (
        <ul className="divide-y-0" data-density="compact-list">
          {sessions.map((session) => (
            <SessionRow key={session.agentSessionId} session={session} now={now} />
          ))}
        </ul>
      ) : emptyState === "loading" ? (
        <div
          className="space-y-2 px-2 py-3"
          role="status"
          aria-label={t("pet.session.empty.loading")}
        >
          <span className="block h-3 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <span className="block h-3 w-1/2 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        </div>
      ) : (
        <p className="px-2 py-3 text-sm text-muted-foreground" role="status">
          {t(`pet.session.empty.${emptyState}`)}
        </p>
      )}
    </section>
  );
}
