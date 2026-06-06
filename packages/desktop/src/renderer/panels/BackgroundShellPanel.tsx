import React, { useCallback, useEffect, useState } from "react";
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
  const [output, setOutput] = useState<{ header: string; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setShells([]);
      return;
    }
    try {
      const { shells } = await window.codeshell.listBackgroundShells(sessionId);
      setShells(shells);
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [sessionId]);

  // Initial load + light poll while any shell is running (cheap list call).
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const viewOutput = async (shellId: string) => {
    if (!sessionId) return;
    setSelected(shellId);
    setLoading(true);
    try {
      const res = await window.codeshell.backgroundShellOutput(sessionId, shellId);
      setOutput(res);
    } catch (e) {
      setOutput({ header: "", text: `读取输出失败：${String(e instanceof Error ? e.message : e)}` });
    } finally {
      setLoading(false);
    }
  };

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

function StatusDot({ status }: { status: BackgroundShellInfo["status"] }) {
  const cls =
    status === "running"
      ? "bg-status-running animate-pulse"
      : status === "killed"
        ? "bg-status-warn"
        : "bg-muted-foreground";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} />;
}
