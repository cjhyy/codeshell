import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * CC Room — lists this project's Claude Code (external `claude` CLI) sessions
 * and the CC-backed scheduled tasks. Gated on CLI availability: if `claude`
 * isn't on PATH we render a muted install prompt with a re-detect button.
 *
 * Thin client: talks only to `window.codeshell.ccRoom.*`. The interfaces below
 * mirror the core types (CCAvailability / DiscoveredSession / CronJob +
 * CCTaskMeta) the preload returns — we can't import core in the renderer, so we
 * declare the shapes locally.
 */
interface DiscoveredSession {
  sessionId: string;
  firstMessage: string;
  lastModified: number;
  messageCount: number;
}

interface Availability {
  available: boolean;
  command?: string;
  version?: string;
  reason?: "not-found" | "not-executable";
}

interface CCTaskRow {
  job: { id: string; name: string; schedule: string; prompt?: string; cwd?: string };
  meta: { kind?: string; continuation?: string; goal?: string; sessionId?: string } | undefined;
}

export function CCRoomView({ cwd }: { cwd: string | null }) {
  const [avail, setAvail] = useState<Availability | null>(null);
  const [sessions, setSessions] = useState<DiscoveredSession[]>([]);
  const [tasks, setTasks] = useState<CCTaskRow[]>([]);

  const refresh = useCallback(() => {
    if (cwd) {
      void window.codeshell.ccRoom.listSessions(cwd).then(setSessions);
    } else {
      setSessions([]);
    }
    void window.codeshell.ccRoom.listTasks().then(setTasks);
  }, [cwd]);

  useEffect(() => {
    void window.codeshell.ccRoom.probe().then(setAvail);
  }, []);

  useEffect(() => {
    if (avail?.available) refresh();
  }, [avail?.available, refresh]);

  // Loading (probe in flight).
  if (avail === null) {
    return <div className="p-4 text-sm text-muted-foreground">正在检测 Claude Code CLI…</div>;
  }

  // Gated state — CLI not available.
  if (!avail.available) {
    return (
      <div className="flex flex-col gap-2 p-4 text-muted-foreground">
        <p>未检测到 Claude Code CLI。</p>
        <p className="text-sm">
          请先安装 <code className="rounded bg-muted px-1 py-0.5 text-xs">claude</code> 并确保它在 PATH 中。
        </p>
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void window.codeshell.ccRoom.probe(true).then(setAvail)}
          >
            重新检测
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="min-w-0 truncate text-base font-semibold">
          Claude Code 会话
          {cwd && <span className="ml-1 font-normal text-muted-foreground">· {cwd}</span>}
        </h2>
        <Button
          size="sm"
          className="shrink-0"
          title="新开 session（后续迭代接入对话视图）"
          onClick={() => {
            // Placeholder: a full conversation view is a later iteration.
            console.log("[CCRoom] 新开 session requested for", cwd);
          }}
        >
          新开 session
        </Button>
      </div>

      {/* Sessions */}
      <section className="flex flex-col gap-2">
        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">该项目下还没有 Claude Code 会话。</p>
        ) : (
          sessions.map((s) => (
            <Card
              key={s.sessionId}
              className="flex cursor-pointer items-center justify-between gap-3 p-3 hover:bg-accent"
              onClick={() => {
                // Placeholder: opening a session is a later iteration.
                console.log("[CCRoom] open session", s.sessionId);
              }}
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{s.firstMessage || "(无消息)"}</div>
                <div className="text-xs text-muted-foreground">
                  {s.messageCount} 条消息 · {new Date(s.lastModified).toLocaleString()}
                </div>
              </div>
              <code className="shrink-0 text-xs text-muted-foreground">{s.sessionId.slice(0, 8)}</code>
            </Card>
          ))
        )}
      </section>

      {/* Scheduled CC tasks */}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">定时任务</h3>
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">没有定时任务。</p>
        ) : (
          tasks.map((t) => (
            <Card key={t.job.id} className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <div className="truncate font-medium">{t.job.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {[t.job.schedule, t.meta?.kind, t.meta?.continuation].filter(Boolean).join(" · ")}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={async () => {
                  await window.codeshell.ccRoom.deleteTask(t.job.id);
                  refresh();
                }}
              >
                删除
              </Button>
            </Card>
          ))
        )}
      </section>
    </div>
  );
}
