import React, { useCallback, useEffect, useRef, useState } from "react";
import type { BackgroundWorkInfo } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { CCConversationView } from "./CCConversationView";
import type { OpenCliSessionRequest } from "./types";

type Job = Extract<BackgroundWorkInfo, { kind: "job" }>;
type TaskRequest = OpenCliSessionRequest & { jobId: string; sourceSessionId: string };
type Linked = Awaited<ReturnType<Window["codeshell"]["ccRoom"]["openLinkedSession"]>>;

export function driveAgentTaskIsTerminal(status: Job["status"] | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function taskDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Host verifies the owner and start-time attempt before invoking cancellation. */
export async function stopDriveAgentTask(job: Job): Promise<boolean> {
  const result = await window.codeshell.cancelBackgroundJob(
    job.sourceSession.sessionId,
    job.jobId,
    job.startedAt,
  );
  return result.cancelled;
}

/** One stable job page. Opening it only observes the existing CLI transcript. */
export function DriveAgentTaskView({
  request,
  active,
  onOpenRequestConsumed,
}: {
  request: TaskRequest;
  active: boolean;
  onOpenRequestConsumed?: (nonce: number) => void;
}) {
  const { t, lang } = useT();
  const [job, setJob] = useState<Job | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [linked, setLinked] = useState<Linked | null>(null);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [takenOver, setTakenOver] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const refresh = useCallback(() => setRefreshRevision((value) => value + 1), []);
  const consumeRef = useRef(onOpenRequestConsumed);
  consumeRef.current = onOpenRequestConsumed;

  useEffect(() => {
    if (!request.consumed) consumeRef.current?.(request.nonce);
  }, [request.nonce, request.consumed]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let missingAttempts = 0;
    let reading = false;
    const read = async () => {
      if (cancelled || reading) return;
      if (timer) clearTimeout(timer);
      reading = true;
      let shouldPoll = false;
      try {
        const result = await window.codeshell.listBackgroundWork(request.sourceSessionId, {
          scope: "all",
        });
        if (cancelled) return;
        const found =
          result.items.find(
            (item): item is Job =>
              item.kind === "job" &&
              item.jobId === request.jobId &&
              item.sourceSession.sessionId === request.sourceSessionId,
          ) ?? null;
        setJob(found);
        setReadFailed(false);
        setLoaded(true);
        shouldPoll = found
          ? found.status === "running" || found.status === "cancelling"
          : ++missingAttempts < 10;
      } catch {
        if (cancelled) return;
        setReadFailed(true);
        setLoaded(true);
        shouldPoll = ++missingAttempts < 10;
      } finally {
        reading = false;
        if (!cancelled && shouldPoll) timer = setTimeout(() => void read(), 3000);
      }
    };
    const onChange = () => void read();
    void read();
    window.addEventListener("codeshell:files-changed", onChange);
    const off = window.codeshell.taskInbox?.onChanged?.(onChange);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("codeshell:files-changed", onChange);
      off?.();
    };
  }, [active, request.jobId, request.sourceSessionId, refreshRevision]);

  const externalSessionId = job?.externalSessionId ?? request.externalSessionId;
  const cwd = job?.cwd ?? request.cwd;
  const cliKind =
    job?.cli === "claude" ? "claude-code" : job?.cli === "codex" ? "codex" : request.cliKind;
  const cliLabel = cliKind === "codex" ? "Codex" : "Claude Code";
  useEffect(() => {
    setLinked(null);
    setTakenOver(false);
    setConnectionFailed(false);
  }, [externalSessionId, cwd, cliKind]);

  useEffect(() => {
    if (!active || !externalSessionId || linked) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    setConnectionFailed(false);
    const connect = async () => {
      try {
        const result = await window.codeshell.ccRoom.openLinkedSession(
          externalSessionId,
          cwd,
          cliKind,
        );
        if (!cancelled) setLinked(result);
      } catch {
        if (cancelled) return;
        if (++attempts < 5) timer = setTimeout(() => void connect(), 1500);
        else setConnectionFailed(true);
      }
    };
    void connect();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, externalSessionId, cwd, cliKind, linked, connectionRevision]);

  const status = readFailed ? "unknown" : (job?.status ?? "unknown");
  const terminal = driveAgentTaskIsTerminal(status);
  const running = status === "running" || status === "cancelling";
  useEffect(() => {
    if (!active || !running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, running]);

  const returnToChat = () =>
    window.dispatchEvent(
      new CustomEvent("codeshell:return-from-cli-task", {
        detail: { sourceSessionId: request.sourceSessionId, jobId: request.jobId },
      }),
    );
  const stop = async () => {
    if (!job || stopping || status !== "running") return;
    setStopping(true);
    setActionError(null);
    try {
      if (!(await stopDriveAgentTask(job))) setActionError(t("panels.shells.taskStopUnavailable"));
    } catch (error) {
      setActionError(
        t("panels.shells.taskStopFailed", {
          error: String(error instanceof Error ? error.message : error),
        }),
      );
    } finally {
      setStopping(false);
      refresh();
    }
  };
  const takeOver = async () => {
    if (!linked || !externalSessionId || !terminal) return;
    setActionError(null);
    try {
      // Refresh immediately before takeover; Host independently rejects live owners.
      const latest = await window.codeshell.listBackgroundWork(request.sourceSessionId, {
        scope: "all",
      });
      const current = latest.items.find(
        (item): item is Job =>
          item.kind === "job" &&
          item.jobId === request.jobId &&
          item.sourceSession.sessionId === request.sourceSessionId,
      );
      if (!current || !driveAgentTaskIsTerminal(current.status)) {
        refresh();
        throw new Error(t("panels.shells.taskUnknownTakeover"));
      }
      const result = await window.codeshell.ccRoom.takeOverLinkedSession(
        linked.roomId,
        externalSessionId,
        linked.cwd,
        cliKind,
      );
      setLinked({ ...linked, ...result });
      setTakenOver(true);
    } catch (error) {
      setActionError(
        t("panels.room.takeOverFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  };
  const statusLabel = !loaded
    ? t("panels.shells.taskLoading")
    : status === "completed"
      ? t("panels.shells.jobCompleted")
      : status === "failed"
        ? t("panels.shells.jobFailed")
        : status === "cancelled"
          ? t("panels.shells.jobCancelled")
          : status === "cancelling"
            ? t("panels.shells.jobCancelling")
            : status === "running"
              ? t("panels.shells.jobRunning")
              : t("panels.shells.jobUnknown");
  const progress = job?.progress;
  const clock = job?.finishedAt ?? now;
  const quiet = running && now - (progress?.lastActivityAt ?? job?.startedAt ?? now) >= 60_000;

  return (
    <section aria-label={t("panels.shells.taskProgress")} className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-border px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{cliLabel}</span>
          <span
            data-drive-agent-status={status}
            className={status === "failed" ? "text-status-err" : "text-muted-foreground"}
          >
            {statusLabel}
          </span>
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" onClick={refresh}>
              {t("panels.common.refresh")}
            </Button>
            {status === "running" && job?.canCancel !== false && (
              <Button size="sm" variant="outline" disabled={stopping} onClick={() => void stop()}>
                {stopping ? t("panels.shells.jobCancelling") : t("panels.common.stop")}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={returnToChat}>
              {t("panels.shells.taskBack")}
            </Button>
          </div>
        </div>
        <p
          className="line-clamp-2 break-words font-medium"
          title={job?.description ?? request.title}
        >
          {job?.description ?? request.title ?? request.jobId}
        </p>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground tabular-nums">
          {job && (
            <span>
              {status === "unknown"
                ? t("panels.shells.taskStartedAt", {
                    time: new Date(job.startedAt).toLocaleString(lang === "zh" ? "zh-CN" : "en-US"),
                  })
                : t("panels.shells.taskElapsed", { duration: taskDuration(clock - job.startedAt) })}
            </span>
          )}
          {progress ? (
            <span>
              {!running
                ? t("panels.shells.taskLastActivityAt", {
                    time: new Date(progress.lastActivityAt).toLocaleTimeString(
                      lang === "zh" ? "zh-CN" : "en-US",
                    ),
                  })
                : t("panels.shells.taskLastActivity", {
                    duration: taskDuration(now - progress.lastActivityAt),
                  })}
            </span>
          ) : (
            running && <span>{t("panels.shells.taskNoActivity")}</span>
          )}
          {running && progress?.phase && (
            <span>{t(`panels.shells.taskPhase.${progress.phase}`)}</span>
          )}
        </div>
        {progress?.summary && (
          <p className="break-words text-muted-foreground">{progress.summary}</p>
        )}
        {quiet && <p className="text-status-warn">{t("panels.shells.taskQuiet")}</p>}
        {readFailed && (
          <p className="text-status-warn">{t("panels.shells.taskStatusUnavailable")}</p>
        )}
        {loaded && status === "unknown" && !readFailed && (
          <p className="text-muted-foreground">{t("panels.shells.taskUnknownHint")}</p>
        )}
        {actionError && (
          <p role="alert" className="text-status-err">
            {actionError}
          </p>
        )}
        {!!progress?.recentEvents?.length && (
          <details>
            <summary className="cursor-pointer text-muted-foreground">
              {t("panels.shells.taskEvents", { count: progress.recentEvents.length })}
            </summary>
            <ol className="mt-1 max-h-32 space-y-1 overflow-auto text-muted-foreground">
              {progress.recentEvents.map((event, index) => (
                <li key={`${event.at}:${index}`} className="flex gap-2">
                  <span className="shrink-0 tabular-nums">
                    +{taskDuration(event.at - job!.startedAt)}
                  </span>
                  <span className="break-words">{event.summary}</span>
                </li>
              ))}
            </ol>
          </details>
        )}
        {terminal && job?.finalText && (
          <details>
            <summary className="cursor-pointer">{t("panels.shells.taskResult")}</summary>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words py-2">
              {job.finalText}
            </pre>
          </details>
        )}
      </div>
      {linked && externalSessionId ? (
        <div className="min-h-0 flex-1">
          <CCConversationView
            roomId={linked.roomId}
            cwd={linked.cwd}
            sessionId={externalSessionId}
            mode={linked.mode}
            cliKind={cliKind}
            cliLabel={cliLabel}
            active={active}
            observing={!takenOver}
            hideHeader
            observeHint={
              !terminal
                ? t(running ? "panels.shells.taskRunningHint" : "panels.shells.taskUnknownTakeover")
                : undefined
            }
            onTakeOver={terminal ? takeOver : undefined}
            onBack={returnToChat}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
          <p>
            {connectionFailed
              ? t("panels.shells.taskConnectionFailed")
              : externalSessionId
                ? t("panels.shells.taskConnecting")
                : running || !loaded
                  ? t("panels.shells.taskStarting")
                  : terminal
                    ? t("panels.shells.taskNoTranscript")
                    : t("panels.shells.taskUnknownHint")}
          </p>
          {connectionFailed && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConnectionRevision((value) => value + 1)}
            >
              {t("panels.common.retry")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
