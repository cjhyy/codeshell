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
import { QuotaPanel } from "./QuotaPanel";

/**
 * CC Room — lists this project's external coding-agent CLI sessions for the
 * selected CLI (Claude Code or Codex). Gated on CLI availability: if the chosen
 * CLI isn't on PATH we render a muted install prompt with a re-detect button.
 *
 * Both CLIs drive the SAME RoomManager (kind="claude-code"|"codex"); the room
 * renders through the CLI-blind CCConversationView. Only discovery + probe
 * differ per CLI, dispatched on `cliKind` below.
 *
 * Thin client: talks only to `window.codeshell.ccRoom.*`. The interfaces below
 * mirror the core types (CCAvailability / DiscoveredSession) the preload returns
 * — we can't import core in the renderer, so we declare the shapes locally.
 *
 * Scheduled tasks are NOT shown here: scheduling is generic (CronCreate), so
 * cron jobs — including ones that drive these CLIs — live in the Automation
 * view, not in a CLI-specific task list.
 */
type CliKind = "claude-code" | "codex";
const CLI_LABEL: Record<CliKind, string> = { "claude-code": "Claude Code", codex: "Codex" };
const CLI_COMMAND: Record<CliKind, string> = { "claude-code": "claude", codex: "codex" };
const CLI_KINDS: CliKind[] = ["claude-code", "codex"];

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

export function CCRoomView({ cwd, active = true }: { cwd: string | null; active?: boolean }) {
  const [cliKind, setCliKind] = useState<CliKind>("claude-code");
  const [avail, setAvail] = useState<Availability | null>(null);
  const [sessions, setSessions] = useState<DiscoveredSession[]>([]);
  // Total session count (unbounded) vs the bounded default we show. When total >
  // shown and not expanded, offer "load more" (TODO room-list convergence).
  const [total, setTotal] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [conv, setConv] = useState<{ roomId: string; sessionId: string; mode: string } | null>(
    null,
  );
  const [picking, setPicking] = useState<{ sessionId: string } | null>(null);

  const probeFor = useCallback(
    (kind: CliKind, force = false) =>
      kind === "codex"
        ? window.codeshell.ccRoom.codexProbe(force)
        : window.codeshell.ccRoom.probe(force),
    [],
  );

  const openWithMode = useCallback(
    async (mode: "default" | "acceptEdits" | "bypassPermissions") => {
      if (!cwd || !picking) return;
      const { roomId } = await window.codeshell.ccRoom.openSession(
        picking.sessionId,
        cwd,
        mode,
        cliKind,
      );
      setConv({ roomId, sessionId: picking.sessionId, mode });
      setPicking(null);
    },
    [cwd, picking, cliKind],
  );

  const refresh = useCallback(
    (all = false) => {
      if (!cwd) {
        setSessions([]);
        setTotal(0);
        return;
      }
      const list =
        cliKind === "codex"
          ? window.codeshell.ccRoom.listCodexSessions(cwd, all)
          : window.codeshell.ccRoom.listSessions(cwd, all);
      void list.then((res) => {
        setSessions(res.sessions);
        setTotal(res.total);
      });
    },
    [cwd, cliKind],
  );

  // Re-probe whenever the selected CLI changes. setAvail(null) shows the loading
  // state and avoids briefly listing the other CLI's sessions under the new kind.
  useEffect(() => {
    setAvail(null);
    setSessions([]);
    setExpanded(false);
    void probeFor(cliKind).then(setAvail);
  }, [cliKind, probeFor]);

  useEffect(() => {
    if (avail?.available) refresh();
  }, [avail?.available, refresh]);

  const label = CLI_LABEL[cliKind];

  const cliSwitch = (
    <div className="flex gap-1.5">
      {CLI_KINDS.map((k) => (
        <Button
          key={k}
          size="sm"
          variant={cliKind === k ? "default" : "outline"}
          onClick={() => setCliKind(k)}
        >
          {CLI_LABEL[k]}
        </Button>
      ))}
    </div>
  );

  // Loading (probe in flight).
  if (avail === null) {
    return (
      <div className="flex flex-col gap-3 p-4">
        {cliSwitch}
        <div className="text-sm text-muted-foreground">正在检测 {label} CLI…</div>
      </div>
    );
  }

  // Gated state — CLI not available.
  if (!avail.available) {
    return (
      <div className="flex flex-col gap-3 p-4">
        {cliSwitch}
        <div className="flex flex-col gap-2 text-muted-foreground">
          <p>未检测到 {label} CLI。</p>
          <p className="text-sm">
            请先安装{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">{CLI_COMMAND[cliKind]}</code>{" "}
            并确保它在 PATH 中。
          </p>
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void probeFor(cliKind, true).then(setAvail)}
            >
              重新检测
            </Button>
          </div>
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
        cliKind={cliKind}
        cliLabel={CLI_LABEL[cliKind]}
        active={active}
        onBack={() => setConv(null)}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      {cliSwitch}
      <div className="flex items-center justify-between gap-2">
        <h2 className="min-w-0 truncate text-base font-semibold">
          {label} 会话
          {cwd && <span className="ml-1 font-normal text-muted-foreground">· {cwd}</span>}
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          <QuotaPanel which={cliKind === "codex" ? "codex" : "claude"} />
          <Button
            size="sm"
            disabled={!cwd}
            title="新开 session"
            onClick={() => setPicking({ sessionId: "" })}
          >
            新开 session
          </Button>
        </div>
      </div>

      {/* Sessions */}
      <section className="flex flex-col gap-2">
        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">该项目下还没有 {label} 会话。</p>
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
                  {/* messageCount isn't tracked for codex (would need a full scan) → omit it there. */}
                  {s.messageCount > 0 && <span>{s.messageCount} 条消息 · </span>}
                  {new Date(s.lastModified).toLocaleString()}
                </div>
              </div>
              <code className="shrink-0 text-xs text-muted-foreground">
                {s.sessionId.slice(0, 8)}
              </code>
            </Card>
          ))
        )}
        {!expanded && total > sessions.length && (
          <Button
            variant="ghost"
            size="sm"
            className="self-center text-muted-foreground"
            onClick={() => {
              setExpanded(true);
              refresh(true);
            }}
          >
            加载更多（还有 {total - sessions.length} 个更早的会话）
          </Button>
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
