import { useCallback, useEffect, useRef, useState } from "react";
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
import type { OpenCliSessionRequest, RoomCliKind } from "./types";
import { useToast } from "../ui/ToastProvider";
import { useT } from "../i18n/I18nProvider";

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
type CliKind = RoomCliKind;
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

export function CCRoomView({
  cwd,
  active = true,
  openRequest,
  onOpenRequestConsumed,
}: {
  cwd: string | null;
  active?: boolean;
  openRequest?: OpenCliSessionRequest;
  onOpenRequestConsumed?: (nonce: number) => void;
}) {
  const { t } = useT();
  const toast = useToast();
  const tRef = useRef(t);
  const toastRef = useRef(toast);
  const consumeRef = useRef(onOpenRequestConsumed);
  tRef.current = t;
  toastRef.current = toast;
  consumeRef.current = onOpenRequestConsumed;
  const [cliKind, setCliKind] = useState<CliKind>("claude-code");
  const cliKindRef = useRef<CliKind>(cliKind);
  const cwdRef = useRef(cwd);
  cliKindRef.current = cliKind;
  cwdRef.current = cwd;
  const [avail, setAvail] = useState<Availability | null>(null);
  const [sessions, setSessions] = useState<DiscoveredSession[]>([]);
  // Total session count (unbounded) vs the bounded default we show. When total >
  // shown and not expanded, offer "load more" (TODO room-list convergence).
  const [total, setTotal] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [conv, setConv] = useState<{
    roomId: string;
    sessionId: string;
    mode: string;
    cwd: string;
    cliKind: CliKind;
  } | null>(null);
  const [picking, setPicking] = useState<{ sessionId: string } | null>(null);
  const lastOpenRequestNonceRef = useRef(-1);
  const pendingOpenRequestRef = useRef<OpenCliSessionRequest | null>(null);
  const probeSequenceRef = useRef(0);
  const probeForceRef = useRef(false);
  const [probeRevision, setProbeRevision] = useState(0);
  const listSequenceRef = useRef(0);

  const probeFor = useCallback(
    (kind: CliKind, force = false) =>
      kind === "codex"
        ? window.codeshell.ccRoom.codexProbe(force)
        : window.codeshell.ccRoom.probe(force),
    [],
  );

  useEffect(() => {
    const isFreshRequest =
      !!openRequest &&
      !openRequest.consumed &&
      lastOpenRequestNonceRef.current !== openRequest.nonce;
    if (isFreshRequest) {
      lastOpenRequestNonceRef.current = openRequest.nonce;
      pendingOpenRequestRef.current = openRequest;
      consumeRef.current?.(openRequest.nonce);
      setPicking(null);
      if (cliKind !== openRequest.cliKind) {
        setAvail(null);
        setCliKind(openRequest.cliKind);
        return;
      }
    }

    const linkedRequest =
      pendingOpenRequestRef.current?.cliKind === cliKind ? pendingOpenRequestRef.current : null;
    const sequence = probeSequenceRef.current + 1;
    probeSequenceRef.current = sequence;
    const force = probeForceRef.current;
    probeForceRef.current = false;
    let cancelled = false;
    let probeResolved = false;
    setAvail(null);
    setSessions([]);
    setExpanded(false);
    void probeFor(cliKind, force)
      .then(async (availability) => {
        if (cancelled || probeSequenceRef.current !== sequence) return;
        probeResolved = true;
        setAvail(availability);
        if (!linkedRequest) return;
        if (!availability.available) {
          if (pendingOpenRequestRef.current?.nonce === linkedRequest.nonce) {
            pendingOpenRequestRef.current = null;
          }
          toastRef.current({
            message: tRef.current("panels.room.cliUnavailable"),
            variant: "error",
          });
          return;
        }
        const linked = await window.codeshell.ccRoom.openLinkedSession(
          linkedRequest.externalSessionId,
          linkedRequest.cwd,
          linkedRequest.cliKind,
        );
        if (
          cancelled ||
          probeSequenceRef.current !== sequence ||
          pendingOpenRequestRef.current?.nonce !== linkedRequest.nonce
        ) {
          return;
        }
        pendingOpenRequestRef.current = null;
        setConv({
          roomId: linked.roomId,
          sessionId: linkedRequest.externalSessionId,
          mode: linked.mode,
          cwd: linkedRequest.cwd,
          cliKind: linkedRequest.cliKind,
        });
      })
      .catch((error) => {
        if (cancelled || probeSequenceRef.current !== sequence) return;
        if (pendingOpenRequestRef.current?.nonce === linkedRequest?.nonce) {
          pendingOpenRequestRef.current = null;
        }
        if (!probeResolved) setAvail({ available: false });
        toastRef.current({
          message: tRef.current("panels.room.openLinkedFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
          variant: "error",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [cliKind, openRequest?.nonce, probeFor, probeRevision]);

  const requestProbe = useCallback((force = false) => {
    probeForceRef.current = force;
    setProbeRevision((revision) => revision + 1);
  }, []);

  const openWithMode = useCallback(
    async (mode: "default" | "acceptEdits" | "bypassPermissions") => {
      if (!cwd || !picking) return;
      const { roomId } = await window.codeshell.ccRoom.openSession(
        picking.sessionId,
        cwd,
        mode,
        cliKind,
      );
      setConv({ roomId, sessionId: picking.sessionId, mode, cwd, cliKind });
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
      const sequence = listSequenceRef.current + 1;
      listSequenceRef.current = sequence;
      const requestKind = cliKind;
      const requestCwd = cwd;
      void list.then((res) => {
        if (
          listSequenceRef.current !== sequence ||
          requestKind !== cliKindRef.current ||
          requestCwd !== cwdRef.current
        ) {
          return;
        }
        setSessions(res.sessions);
        setTotal(res.total);
      });
    },
    [cwd, cliKind],
  );

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
          onClick={() => {
            pendingOpenRequestRef.current = null;
            setCliKind(k);
          }}
        >
          {CLI_LABEL[k]}
        </Button>
      ))}
    </div>
  );

  // A successfully established conversation is authoritative. Availability
  // replies from any older probe must never cover it with a stale gate.
  if (conv) {
    return (
      <CCConversationView
        roomId={conv.roomId}
        cwd={conv.cwd}
        sessionId={conv.sessionId}
        mode={conv.mode}
        cliKind={conv.cliKind}
        cliLabel={CLI_LABEL[conv.cliKind]}
        active={active}
        onBack={() => setConv(null)}
      />
    );
  }

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
            <Button variant="outline" size="sm" onClick={() => requestProbe(true)}>
              重新检测
            </Button>
          </div>
        </div>
      </div>
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
