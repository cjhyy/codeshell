import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { CCConversationView } from "./CCConversationView";

/**
 * CC Room — lists this project's Claude Code (external `claude` CLI) sessions.
 * Gated on CLI availability: if `claude` isn't on PATH we render a muted install
 * prompt with a re-detect button.
 *
 * Thin client: talks only to `window.codeshell.ccRoom.*`. The interfaces below
 * mirror the core types (CCAvailability / DiscoveredSession) the preload returns
 * — we can't import core in the renderer, so we declare the shapes locally.
 *
 * Scheduled tasks are NOT shown here: scheduling is generic (CronCreate), so
 * cron jobs — including ones that drive Claude Code — live in the Automation
 * view, not in a CC-specific task list.
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

export function CCRoomView({ cwd }: { cwd: string | null }) {
  const [avail, setAvail] = useState<Availability | null>(null);
  const [sessions, setSessions] = useState<DiscoveredSession[]>([]);
  const [conv, setConv] = useState<{ roomId: string; sessionId: string; mode: string } | null>(
    null,
  );
  const [picking, setPicking] = useState<{ sessionId: string } | null>(null);

  const openWithMode = useCallback(
    async (mode: "default" | "acceptEdits" | "bypassPermissions") => {
      if (!cwd || !picking) return;
      const { roomId } = await window.codeshell.ccRoom.openSession(picking.sessionId, cwd, mode);
      setConv({ roomId, sessionId: picking.sessionId, mode });
      setPicking(null);
    },
    [cwd, picking],
  );

  const refresh = useCallback(() => {
    if (cwd) {
      void window.codeshell.ccRoom.listSessions(cwd).then(setSessions);
    } else {
      setSessions([]);
    }
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

  // A conversation is open — render it in place of the list.
  if (conv) {
    return (
      <CCConversationView
        roomId={conv.roomId}
        cwd={cwd}
        sessionId={conv.sessionId}
        mode={conv.mode}
        onBack={() => setConv(null)}
      />
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
          disabled={!cwd}
          title="新开 session"
          onClick={() => setPicking({ sessionId: "" })}
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
              onClick={() => setPicking({ sessionId: s.sessionId })}
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

      <Dialog open={picking !== null} onOpenChange={(o) => !o && setPicking(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>选择权限模式</DialogTitle>
            <DialogDescription>
              default = 工具调用需你逐个批准；acceptEdits = 自动接受编辑；bypassPermissions =
              全自动放行（谨慎）。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Button onClick={() => void openWithMode("default")}>default</Button>
            <Button variant="outline" onClick={() => void openWithMode("acceptEdits")}>
              acceptEdits
            </Button>
            <Button variant="outline" onClick={() => void openWithMode("bypassPermissions")}>
              bypassPermissions
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
