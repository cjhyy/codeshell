import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, RefreshCw, Square, Terminal, Film, CheckCircle2, XCircle } from "lucide-react";
import type { BackgroundShellInfo, BackgroundWorkInfo } from "../../preload/types";
import { useT, type TFunction } from "../i18n/I18nProvider";

type AgentStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * Unified background-work panel. Lists ALL of the current session's background
 * work, grouped by kind: background shells (Bash run_in_background), background
 * sub-agents (Agent run_in_background / auto-handed-off), and background jobs
 * (video generation, drive-claude-code). Shells are interactive — select to
 * pull their output, stop to kill — while sub-agents and jobs are read-only
 * status rows (their own surfaces own the detail).
 *
 * Pull-based with two refresh triggers so the list stays live without the user
 * toggling the panel: (1) a `codeshell:files-changed`-style turn-complete event
 * that catches newly-spawned work the instant a turn finishes, and (2) a light
 * 3s poll while anything is running (so a download's byte counter / a shell's
 * tail actually move). Background work deliberately doesn't stream into the UI
 * (core keeps it out of context; the agent pulls via BashOutput) — this panel
 * is the human's window onto it.
 */
export function BackgroundShellPanel({ sessionId }: { sessionId: string | null }) {
  const { t } = useT();
  const [items, setItems] = useState<BackgroundWorkInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // Which finished job's result detail is expanded (click to toggle).
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  // Mirror of `selected` for the poll tick, so reading the current selection
  // doesn't force the interval to re-arm on every selection change.
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  const [output, setOutput] = useState<{ header: string; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Drives the manual refresh-button spinner. Separate from `loading` (which is
  // per-shell-output) so the top button gives its own feedback — auto-refresh
  // (turn-complete / poll) was the only signal before, leaving the manual click
  // with no visible response (TODO-background-panel #1).
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setItems([]);
      return;
    }
    try {
      const res = await window.codeshell.listBackgroundWork(sessionId);
      const next = res?.items ?? [];
      setItems(next);
      // The selected shell may have vanished (worker recycled / shell reaped) —
      // drop its now-stale selection + output so the body doesn't keep showing a
      // frozen header next to a list that no longer contains it. Functional
      // updater reads the LATEST selection without adding it to this callback's
      // deps (which would re-arm the poll interval on every selection change).
      setSelected((cur) => {
        const vanished = !!cur && !next.some((i) => i.kind === "shell" && i.shell.shellId === cur);
        if (vanished) setOutput(null);
        return vanished ? null : cur;
      });
      setError(null);
    } catch (e) {
      // Don't leave stale "running" rows frozen on a failed refresh — the most
      // common failure is the worker having recycled (its in-RAM registries are
      // gone), in which case there genuinely is no background work to show. (#7)
      setItems([]);
      setSelected(null);
      setOutput(null);
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [sessionId]);

  // Manual refresh from the top button — spins the icon until the fetch settles
  // so the click has visible feedback. Guards against a double-spin if clicked
  // mid-refresh.
  const manualRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  // Load once on mount / session change.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Refresh the instant a turn finishes: that's when newly-spawned background
  // work (a shell / sub-agent / video job kicked off during the turn) becomes
  // visible. App dispatches this same event for the Files panel; reusing it
  // means the list no longer waits for the next poll tick — and works even when
  // nothing was running before (so the running-only poll wouldn't have fired).
  useEffect(() => {
    const onChanged = (): void => void refresh();
    window.addEventListener("codeshell:files-changed", onChanged);
    return () => window.removeEventListener("codeshell:files-changed", onChanged);
  }, [refresh]);

  const fetchOutput = useCallback(
    async (shellId: string, withSpinner: boolean) => {
      if (!sessionId) return;
      if (withSpinner) setLoading(true);
      try {
        const res = await window.codeshell.backgroundShellOutput(sessionId, shellId);
        setOutput(res);
      } catch (e) {
        // Only surface the error if the user explicitly opened it; a silent
        // poll refresh shouldn't clobber a good view with an error string.
        if (withSpinner) {
          setOutput({
            header: "",
            text: t("panels.shells.readOutputFailed", {
              error: String(e instanceof Error ? e.message : e),
            }),
          });
        }
      } finally {
        if (withSpinner) setLoading(false);
      }
    },
    [sessionId, t],
  );

  const viewOutput = (shellId: string) => {
    setSelected(shellId);
    void fetchOutput(shellId, true);
  };

  // Split into the three categories once per items change.
  const shells = useMemo(
    () =>
      items
        .filter((i): i is Extract<BackgroundWorkInfo, { kind: "shell" }> => i.kind === "shell")
        .map((i) => i.shell),
    [items],
  );
  const agents = useMemo(
    () => items.filter((i): i is Extract<BackgroundWorkInfo, { kind: "subagent" }> => i.kind === "subagent"),
    [items],
  );
  const jobs = useMemo(
    () => items.filter((i): i is Extract<BackgroundWorkInfo, { kind: "job" }> => i.kind === "job"),
    [items],
  );

  const anyRunning =
    shells.some((s) => s.status === "running") ||
    agents.some((a) => a.status === "running") ||
    jobs.some((j) => j.status === "running");

  // Mirror the latest shells + callbacks into refs so the poll interval below can
  // read them without listing them as effect deps. Otherwise `refresh`(dep
  // [sessionId]), `fetchOutput`(dep [sessionId, t]) and `shells` change on every
  // session switch / locale change / list update, tearing down and re-arming the
  // 3s interval — which stalls live output for up to ~6s. The interval should
  // re-arm ONLY when `anyRunning` flips.
  const shellsRef = useRef(shells);
  const refreshRef = useRef(refresh);
  const fetchOutputRef = useRef(fetchOutput);
  useEffect(() => { shellsRef.current = shells; }, [shells]);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  useEffect(() => { fetchOutputRef.current = fetchOutput; }, [fetchOutput]);

  // Light 3s poll, but only while there's running work AND the tab is visible —
  // a finished list never changes, and a hidden tab (PanelArea keeps all tabs
  // mounted via CSS) shouldn't keep polling. A running shell with an open output
  // view also gets its output re-pulled so live jobs (e.g. a download's progress
  // bar) actually move instead of showing a frozen tail.
  useEffect(() => {
    if (!anyRunning) return;
    const tick = (): void => {
      if (document.visibilityState !== "visible") return;
      void refreshRef.current();
      const cur = selectedRef.current;
      if (cur && shellsRef.current.some((s) => s.shellId === cur && s.status === "running")) {
        void fetchOutputRef.current(cur, false);
      }
    };
    const timer = setInterval(tick, 3000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  const kill = async (shellId: string) => {
    if (!sessionId) return;
    try {
      await window.codeshell.killBackgroundShell(sessionId, shellId);
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  if (!sessionId) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        {t("panels.shells.notStarted")}
      </div>
    );
  }

  const total = shells.length + agents.length + jobs.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-2 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          {t("panels.shells.title", { count: total })}
        </span>
        <button
          type="button"
          title={t("panels.common.refresh")}
          aria-label={t("panels.common.refresh")}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
          onClick={() => void manualRefresh()}
          disabled={refreshing}
        >
          <RefreshCw className={`h-3.5 w-3.5${refreshing ? " animate-spin" : ""}`} />
        </button>
      </div>

      {error && <div className="px-2 py-1 text-xs text-status-err">{error}</div>}

      {total === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-muted-foreground">
          <Terminal className="h-6 w-6" />
          <div className="text-xs">{t("panels.shells.none")}</div>
          <div className="text-[11px]">{t("panels.shells.noneHint")}</div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {/* Background commands (shells) — interactive: click to view output, stop to kill. */}
          {shells.length > 0 && (
            <Section title={t("panels.shells.sectionShells")}>
              <ul className="m-0 list-none p-0">
                {shells.map((s) => (
                  <ShellRow
                    key={s.shellId}
                    shell={s}
                    selected={selected === s.shellId}
                    loading={loading}
                    output={output}
                    onView={() => void viewOutput(s.shellId)}
                    onKill={() => void kill(s.shellId)}
                    t={t}
                  />
                ))}
              </ul>
            </Section>
          )}

          {/* Background sub-agents — read-only status rows. */}
          {agents.length > 0 && (
            <Section title={t("panels.shells.sectionAgents")}>
              <ul className="m-0 list-none p-0">
                {agents.map((a) => (
                  <li key={a.agentId} className="border-b border-border/60">
                    <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
                      <AgentStatusDot status={a.status} />
                      <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-foreground" title={a.description}>
                        {a.description || a.name || a.agentType || a.agentId}
                      </span>
                      {a.agentType && (
                        <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                          {a.agentType}
                        </span>
                      )}
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {agentStatusLabel(t, a.status)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Background jobs (video render, drive-claude-code) — read-only. */}
          {jobs.length > 0 && (
            <Section title={t("panels.shells.sectionJobs")}>
              <ul className="m-0 list-none p-0">
                {jobs.map((j) => {
                  const done = j.status !== "running";
                  const changed = j.changedFiles ?? [];
                  const expandable = done && (!!j.finalText || changed.length > 0);
                  const isOpen = expandedJobId === j.jobId;
                  const statusLabel =
                    j.status === "completed"
                      ? t("panels.shells.jobCompleted")
                      : j.status === "failed"
                        ? t("panels.shells.jobFailed")
                        : t("panels.shells.jobRunning");
                  return (
                    <li key={j.jobId} className="border-b border-border/60">
                      <div
                        className={`flex items-center gap-2 px-2 py-1.5 text-xs ${expandable ? "cursor-pointer hover:bg-muted/40" : ""}`}
                        onClick={expandable ? () => setExpandedJobId(isOpen ? null : j.jobId) : undefined}
                      >
                        {j.status === "running" ? (
                          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-status-running" />
                        ) : j.status === "completed" ? (
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-status-ok" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5 shrink-0 text-status-err" />
                        )}
                        <Film className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-foreground" title={j.description}>
                          {j.description}
                        </span>
                        {changed.length > 0 && (
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {t("panels.shells.jobChangedFiles", { count: changed.length })}
                          </span>
                        )}
                        <span className="shrink-0 text-[10px] text-muted-foreground">{statusLabel}</span>
                      </div>
                      {isOpen && (
                        <div className="border-t border-border/60 bg-muted/30">
                          {changed.length > 0 && (
                            <ul className="m-0 list-none px-2 py-1.5 text-[11px] text-muted-foreground">
                              {changed.map((f) => (
                                <li key={f} className="truncate" title={f}>
                                  {f}
                                </li>
                              ))}
                            </ul>
                          )}
                          {j.finalText && (
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words px-2 py-1.5 text-[11px] text-muted-foreground">
                              {j.finalText}
                            </pre>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

/** A labeled group of background-work rows. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="sticky top-0 z-10 bg-background/95 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
        {title}
      </div>
      {children}
    </div>
  );
}

/** One interactive shell row (click to view output, stop to kill). */
function ShellRow({
  shell: s,
  selected,
  loading,
  output,
  onView,
  onKill,
  t,
}: {
  shell: BackgroundShellInfo;
  selected: boolean;
  loading: boolean;
  output: { header: string; text: string } | null;
  onView: () => void;
  onKill: () => void;
  t: TFunction;
}) {
  return (
    <li className="border-b border-border/60">
      <div
        className={`flex items-center gap-2 px-2 py-1.5 text-xs ${
          selected ? "bg-accent" : "hover:bg-accent/40"
        }`}
      >
        <StatusDot status={s.status} />
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left font-mono text-foreground"
          title={s.command}
          onClick={onView}
        >
          {s.command}
        </button>
        {s.detectedPort != null && (
          <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
            :{s.detectedPort}
          </span>
        )}
        {s.totalBytes != null && s.totalBytes > 0 && (
          <span
            className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums"
            title={t("panels.shells.outputSize")}
          >
            {formatBytes(s.totalBytes)}
          </span>
        )}
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {s.status === "running"
            ? t("panels.shells.running")
            : s.signal
              ? t("panels.shells.signal", { signal: s.signal })
              : t("panels.shells.exit", { code: s.exitCode ?? "?" })}
        </span>
        {s.status === "running" && (
          <button
            type="button"
            title={t("panels.common.stop")}
            aria-label={t("panels.common.stop")}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-status-err"
            onClick={onKill}
          >
            <Square className="h-3 w-3" />
          </button>
        )}
      </div>
      {selected && (
        <div className="bg-background px-2 py-1">
          {loading ? (
            <div className="text-[11px] text-muted-foreground">{t("panels.shells.readingOutput")}</div>
          ) : (
            <>
              {output?.header && (
                <div className="mb-1 font-mono text-[10px] text-muted-foreground">{output.header}</div>
              )}
              <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground">
                {output?.text || t("panels.shells.noOutput")}
              </pre>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function agentStatusLabel(t: TFunction, status: AgentStatus): string {
  switch (status) {
    case "running":
      return t("panels.shells.agentRunning");
    case "completed":
      return t("panels.shells.agentCompleted");
    case "failed":
      return t("panels.shells.agentFailed");
    case "cancelled":
      return t("panels.shells.agentCancelled");
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function StatusDot({ status }: { status: BackgroundShellInfo["status"] }) {
  const cls =
    status === "running"
      ? "bg-status-running animate-pulse"
      : status === "killed"
        ? "bg-status-warn"
        : "bg-muted-foreground";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} />;
}

function AgentStatusDot({ status }: { status: AgentStatus }) {
  const cls =
    status === "running"
      ? "bg-status-running animate-pulse"
      : status === "completed"
        ? "bg-status-ok"
        : status === "failed"
          ? "bg-status-err"
          : "bg-status-warn";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} />;
}
