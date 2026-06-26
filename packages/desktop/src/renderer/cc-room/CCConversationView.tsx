import { useEffect, useReducer, useState, useCallback } from "react";
import { Bot, ChevronDown, ChevronRight, ShieldAlert, TerminalSquare, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/Markdown";
import {
  reduceStream,
  initialChatState,
  type ChatItem,
  type ChatState,
} from "@/lib/streamReducer";
import { roomMsgToEvent, ccHistoryToEvents } from "@/lib/messageMappers";

/**
 * CCConversationView — one resident Claude Code (external CLI) conversation.
 *
 * Renders through the SAME stream reducer + mappers the phone uses
 * (src/renderer/lib), so the desktop and mobile CC views share ONE rendering
 * logic: disk history (ccHistoryToEvents) + live room messages (roomMsgToEvent)
 * fold into ChatItem[], tools pair by id, AskUserQuestion surfaces real options.
 * Thin client: talks only to `window.codeshell.ccRoom.*`.
 */
interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
  tools?: { name: string; summary: string }[];
}
interface RoomMessageWire {
  seq: number;
  from: string;
  type: string;
  text?: string;
  tool?: string;
  summary?: string;
  reason?: string;
  isError?: boolean;
  toolId?: string;
}
interface ApprovalReq {
  roomId: string;
  requestId: string;
  toolName: string;
  displayName?: string;
  input: unknown;
  description?: string;
  /** AskUserQuestion only: parsed by main, so the card renders a choice list.
   *  The chosen label is sent back as the decision's `answer`; main bakes it
   *  into the CLI's `answers` record. */
  askUser?: { question: string; header?: string; options: string[]; multiSelect: boolean };
}

type ChatAction =
  | { kind: "raw"; raw: unknown }
  | { kind: "replayHistory"; messages: unknown }
  | { kind: "replayLive"; messages: RoomMessageWire[] };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.kind) {
    case "raw":
      return reduceStream(state, action.raw);
    case "replayHistory":
      // Disk backlog (the original CC transcript) is the conversation's base —
      // a full reset, so it must be dispatched before the live replay.
      return ccHistoryToEvents(action.messages).reduce(reduceStream, initialChatState());
    case "replayLive":
      // Live room messages already observed before mount — fold on top of base.
      return action.messages.map(roomMsgToEvent).reduce(reduceStream, state);
  }
}

export function CCConversationView({
  roomId,
  cwd,
  sessionId,
  mode,
  onBack,
}: {
  roomId: string;
  cwd: string | null;
  sessionId: string;
  mode: string;
  onBack: () => void;
}) {
  const [chat, dispatch] = useReducer(chatReducer, undefined, initialChatState);
  const [pending, setPending] = useState<ApprovalReq[]>([]);
  const [input, setInput] = useState("");

  useEffect(() => {
    let cancelled = false;
    // The backlog comes from EXACTLY ONE source, never both (the room's
    // messages.jsonl and the CC disk transcript overlap, so replaying both
    // double-renders turns — the "工具堆叠" / duplicated-feed bug):
    //   - cc session bound → the on-disk CC transcript (readHistory) is the
    //     authoritative backlog; new turns arrive live via onRoomMessage.
    //   - no cc session (plain room) → the room's own messages.jsonl backlog.
    // Mirrors the phone (useRemoteApp's ccHistorySessionRef gate).
    const boot = async () => {
      if (sessionId && cwd) {
        const r = await window.codeshell.ccRoom.readHistory(cwd, sessionId, 50);
        if (!cancelled) {
          dispatch({ kind: "replayHistory", messages: (r as { messages: HistoryMessage[] }).messages });
        }
      } else {
        const live = (await window.codeshell.ccRoom.roomHistory(roomId)) as RoomMessageWire[];
        if (!cancelled) dispatch({ kind: "replayLive", messages: live });
      }
    };
    void boot();

    const offMsg = window.codeshell.ccRoom.onRoomMessage(({ roomId: rid, msg }) => {
      if (rid === roomId) dispatch({ kind: "raw", raw: roomMsgToEvent(msg) });
    });
    const offApp = window.codeshell.ccRoom.onApprovalRequest((req) => {
      if (req.roomId === roomId) {
        setPending((p) => (p.some((r) => r.requestId === req.requestId) ? p : [...p, req]));
      }
    });
    // Another端 (a phone, another window) or a timeout resolved this request —
    // drop the now-stale card so it doesn't linger ("点了还存在").
    const offResolved = window.codeshell.ccRoom.onApprovalResolved(({ requestId }) => {
      setPending((p) => p.filter((r) => r.requestId !== requestId));
    });
    return () => {
      cancelled = true;
      offMsg();
      offApp();
      offResolved();
    };
  }, [roomId, cwd, sessionId]);

  const send = useCallback(() => {
    const t = input.trim();
    if (!t) return;
    // NO local echo: RoomManager.send persists the user line and broadcasts it
    // back as a `room.message`, which onRoomMessage folds into the feed. Echoing
    // locally too would render the user bubble twice (the desktop "1 条消息变 2
    // 条" bug). The broadcast round-trips over loopback ~instantly.
    void window.codeshell.ccRoom.send(roomId, t);
    setInput("");
  }, [input, roomId]);

  const resolve = useCallback(
    (
      req: ApprovalReq,
      decision:
        | { behavior: "allow"; updatedInput?: unknown; answer?: string }
        | { behavior: "deny"; message: string },
    ) => {
      void window.codeshell.ccRoom.respondApproval(roomId, req.requestId, decision);
      setPending((p) => p.filter((r) => r.requestId !== req.requestId));
    },
    [roomId],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border p-2">
        <div className="text-sm font-medium">
          CC 会话 ·{" "}
          <code className="text-xs text-muted-foreground">{(sessionId || roomId).slice(0, 8)}</code> · {mode}
        </div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          返回
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          {chat.items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              还没有消息。发条消息开始对话。
            </p>
          ) : (
            chat.items.map((item) => <MessageRow key={item.id} item={item} />)
          )}
          {pending.map((req) => (
            <CcApprovalCard key={req.requestId} req={req} onResolve={resolve} />
          ))}
        </div>
      </div>

      <div className="flex gap-2 border-t border-border p-2">
        <Input
          className="flex-1"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="发消息给 Claude Code…"
        />
        <Button size="sm" onClick={send}>
          发送
        </Button>
      </div>
    </div>
  );
}

// ── one chat row ───────────────────────────────────────────────────────────
function MessageRow({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end gap-2">
          <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground">
            {item.text}
          </div>
          <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border border-primary/30 bg-primary/15 text-primary">
            <UserRound className="size-3.5" />
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="flex justify-start gap-2">
          <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border border-status-ok/25 bg-status-ok/10 text-status-ok">
            <Bot className="size-3.5" />
          </div>
          <div className="min-w-0 max-w-[90%] rounded-xl rounded-tl-md bg-muted/40 px-3 py-2 text-sm">
            {item.done && item.text ? (
              <Markdown text={item.text} />
            ) : (
              <div className="whitespace-pre-wrap break-words">
                {item.text}
                {!item.done && <span className="ml-0.5 inline-block animate-pulse">▋</span>}
              </div>
            )}
          </div>
        </div>
      );
    case "tool":
      return (
        <div className="ml-9 max-w-[90%]">
          <CcToolCard tool={item} />
        </div>
      );
    case "subagent":
      return (
        <div className="ml-9 flex items-center gap-2 rounded-full border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          <span
            className={cn(
              "size-1.5 rounded-full",
              item.status === "running"
                ? "animate-pulse bg-status-running"
                : item.status === "error"
                  ? "bg-status-err"
                  : "bg-status-ok",
            )}
          />
          <span className="font-medium">子代理</span>
          <span className="truncate">{item.label}</span>
        </div>
      );
    case "system_error":
      return (
        <div className="ml-9 rounded-lg border border-status-err/40 bg-status-err/10 px-3 py-2 text-xs text-status-err">
          {item.text}
        </div>
      );
  }
}

function CcToolCard({ tool }: { tool: Extract<ChatItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const argStr = tool.args ? JSON.stringify(tool.args) : "";
  const hasBody = Boolean(argStr && argStr !== "{}") || Boolean(tool.result);
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border text-xs",
        tool.error && "border-status-err/40",
      )}
    >
      <button
        type="button"
        onClick={() => hasBody && setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            !tool.done ? "animate-pulse bg-status-running" : tool.error ? "bg-status-err" : "bg-status-ok",
          )}
        />
        <span className="font-mono font-medium text-foreground">{tool.name}</span>
        {tool.summary && <span className="truncate text-muted-foreground">· {tool.summary}</span>}
        {hasBody && (
          <span className="ml-auto text-muted-foreground">
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </span>
        )}
      </button>
      {open && hasBody && (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
          {argStr && argStr !== "{}" && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono text-[11px] text-muted-foreground">
              {argStr}
            </pre>
          )}
          {tool.result && (
            <pre
              className={cn(
                "overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono text-[11px]",
                tool.error ? "text-status-err" : "text-foreground/80",
              )}
            >
              {tool.result.length > 4000 ? tool.result.slice(0, 4000) + "\n… (truncated)" : tool.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── approval card (allow/deny + AskUserQuestion options) ─────────────────────
function CcApprovalCard({
  req,
  onResolve,
}: {
  req: ApprovalReq;
  onResolve: (
    req: ApprovalReq,
    decision: { behavior: "allow"; updatedInput?: unknown; answer?: string } | { behavior: "deny"; message: string },
  ) => void;
}) {
  const ask = req.askUser;
  const [free, setFree] = useState("");
  // multiSelect: accumulate chosen labels, confirm together (joined with ", ").
  const [picked, setPicked] = useState<string[]>([]);
  const answer = (label: string) => onResolve(req, { behavior: "allow", answer: label });

  return (
    <div className="rounded-xl border border-status-warn/50 bg-status-warn/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-lg bg-status-warn/15 text-status-warn">
          <ShieldAlert className="size-4" />
        </span>
        <span className="font-mono text-sm font-semibold">{req.displayName ?? req.toolName}</span>
      </div>
      {req.description && <p className="mb-2 text-xs text-muted-foreground">{req.description}</p>}

      {ask ? (
        <div className="flex flex-col gap-2">
          {ask.question && <p className="text-sm">{ask.question}</p>}
          <div className="flex flex-wrap gap-2">
            {ask.options.map((opt) =>
              ask.multiSelect ? (
                <Button
                  key={opt}
                  size="sm"
                  variant={picked.includes(opt) ? "default" : "outline"}
                  onClick={() =>
                    setPicked((p) => (p.includes(opt) ? p.filter((x) => x !== opt) : [...p, opt]))
                  }
                >
                  {opt}
                </Button>
              ) : (
                <Button key={opt} size="sm" variant="outline" onClick={() => answer(opt)}>
                  {opt}
                </Button>
              ),
            )}
          </div>
          {ask.multiSelect && (
            <Button size="sm" disabled={picked.length === 0} onClick={() => answer(picked.join(", "))}>
              确认所选 ({picked.length})
            </Button>
          )}
          <div className="flex gap-2">
            <Input
              className="flex-1"
              value={free}
              onChange={(e) => setFree(e.target.value)}
              placeholder="或输入自定义回答…"
              onKeyDown={(e) => {
                if (e.key === "Enter" && free.trim()) answer(free.trim());
              }}
            />
            <Button size="sm" disabled={!free.trim()} onClick={() => answer(free.trim())}>
              回答
            </Button>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onResolve(req, { behavior: "deny", message: "用户取消" })}
          >
            取消
          </Button>
        </div>
      ) : (
        <>
          <pre className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono text-[11px]">
            {JSON.stringify(req.input, null, 2).slice(0, 600)}
          </pre>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1"
              onClick={() =>
                onResolve(req, {
                  behavior: "allow",
                  updatedInput: (req.input as Record<string, unknown>) ?? {},
                })
              }
            >
              允许
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => onResolve(req, { behavior: "deny", message: "denied by user" })}
            >
              拒绝
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
