import React, { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Square, Terminal } from "lucide-react";
import type { BackgroundShellInfo } from "../../preload/types";

/**
 * Background-shell dock panel (TODO 3.2 二期). Lists the current session's
 * background shells (Bash run_in_background), shows one's output on demand, and
 * can stop one. Pull-based: a manual refresh + a light 3s poll while running —
 * background shells deliberately don't stream into the UI (the core design
 * keeps them out of context; the agent pulls via BashOutput).
 */
export function BackgroundShellPanel({ sessionId }: { sessionId: string | null }) {
  const [shells, setShells] = useState<BackgroundShellInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // Mirror of `selected` for the poll tick, so reading the current selection
  // doesn't force the interval to re-arm on every selection change.
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  const [output, setOutput] = useState<{ header: string; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setShells([]);
      return;
    }
    try {
      const res = await window.codeshell.listBackgroundShells(sessionId);
      const next = res?.shells ?? [];
      setShells(next);
      // The selected shell may have vanished (worker recycled / shell finished
      // and was reaped) — drop its now-stale selection + output so the body
      // doesn't keep showing a frozen "exit 0" header next to an empty list.
      // Functional updater reads the LATEST selection without adding it to this
      // callback's deps (which would re-arm the poll interval every selection).
      setSelected((cur) => {
        const vanished = !!cur && !next.some((s) => s.shellId === cur);
        if (vanished) setOutput(null);
        return vanished ? null : cur;
      });
      setError(null);
    } catch (e) {
      // Don't leave stale "running" rows frozen on a failed refresh — the most
      // common failure is the worker having recycled (its in-RAM shell registry
      // is gone), in which case there genuinely are no shells to show. (#7)
      setShells([]);
      setSelected(null);
      setOutput(null);
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [sessionId]);

  // Always load once on mount / session change.
  useEffect(() => {
    void refresh();
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
          setOutput({ header: "", text: `读取输出失败：${String(e instanceof Error ? e.message : e)}` });
        }
      } finally {
        if (withSpinner) setLoading(false);
      }
    },
    [sessionId],
  );

  const viewOutput = (shellId: string) => {
    setSelected(shellId);
    void fetchOutput(shellId, true);
  };

  const anyRunning = shells.some((s) => s.status === "running");

  // Light 3s poll, but only while there's a running shell AND the tab is
  // visible — a finished list never changes, and a hidden tab (PanelArea keeps
  // all tabs mounted via CSS) shouldn't keep polling. A running shell with an
  // open output view also gets its output re-pulled so live jobs (e.g. a
  // download's progress bar) actually move instead of showing a frozen tail.
  useEffect(() => {
    if (!anyRunning) return;
    const tick = (): void => {
      if (document.visibilityState !== "visible") return;
      void refresh();
      const cur = selectedRef.current;
      if (cur && shells.some((s) => s.shellId === cur && s.status === "running")) {
        void fetchOutput(cur, false);
      }
    };
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, [anyRunning, refresh, fetchOutput, shells]);

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
        当前会话还没启动(发一条消息后才有后台 shell)
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-2 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          后台 Shell（{shells.length}）
        </span>
        <button
          type="button"
          title="刷新"
          aria-label="刷新"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => void refresh()}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {error && <div className="px-2 py-1 text-xs text-status-err">{error}</div>}

      {shells.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-muted-foreground">
          <Terminal className="h-6 w-6" />
          <div className="text-xs">没有后台命令</div>
          <div className="text-[11px]">Bash(run_in_background) 启动的命令会出现在这里</div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <ul className="m-0 list-none p-0">
            {shells.map((s) => (
              <li key={s.shellId} className="border-b border-border/60">
                <div
                  className={`flex items-center gap-2 px-2 py-1.5 text-xs ${
                    selected === s.shellId ? "bg-accent" : "hover:bg-accent/40"
                  }`}
                >
                  <StatusDot status={s.status} />
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left font-mono text-foreground"
                    title={s.command}
                    onClick={() => void viewOutput(s.shellId)}
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
                      title="已产出输出量"
                    >
                      {formatBytes(s.totalBytes)}
                    </span>
                  )}
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {s.status === "running"
                      ? "运行中"
                      : s.signal
                        ? `signal ${s.signal}`
                        : `exit ${s.exitCode ?? "?"}`}
                  </span>
                  {s.status === "running" && (
                    <button
                      type="button"
                      title="停止"
                      aria-label="停止"
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-status-err"
                      onClick={() => void kill(s.shellId)}
                    >
                      <Square className="h-3 w-3" />
                    </button>
                  )}
                </div>
                {selected === s.shellId && (
                  <div className="bg-background px-2 py-1">
                    {loading ? (
                      <div className="text-[11px] text-muted-foreground">读取中…</div>
                    ) : (
                      <>
                        {output?.header && (
                          <div className="mb-1 font-mono text-[10px] text-muted-foreground">
                            {output.header}
                          </div>
                        )}
                        <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground">
                          {output?.text || "(无输出)"}
                        </pre>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
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
