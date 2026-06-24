import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/**
 * CCConversationView — one resident Claude Code (external CLI) conversation:
 * disk history (loaded once) + live room messages (streamed) + inline approval
 * cards. Thin client: talks only to `window.codeshell.ccRoom.*`; the shapes
 * below mirror the preload wire types since the renderer can't import core.
 */
interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
  tools?: { name: string; summary: string }[];
}
interface RoomMessage {
  seq: number;
  from: string;
  type: string;
  text?: string;
  tool?: string;
  summary?: string;
  reason?: string;
  isError?: boolean;
}
interface ApprovalReq {
  roomId: string;
  requestId: string;
  toolName: string;
  displayName?: string;
  input: unknown;
  description?: string;
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
  const [history, setHistory] = useState<HistoryMessage[]>([]);
  const [live, setLive] = useState<RoomMessage[]>([]);
  const [pending, setPending] = useState<ApprovalReq[]>([]);
  const [input, setInput] = useState("");

  useEffect(() => {
    if (sessionId && cwd) {
      void window.codeshell.ccRoom
        .readHistory(cwd, sessionId, 20)
        .then((r) => setHistory(r.messages));
    }
    void window.codeshell.ccRoom
      .roomHistory(roomId)
      .then((m) => setLive(m as RoomMessage[]));
    const offMsg = window.codeshell.ccRoom.onRoomMessage(({ roomId: rid, msg }) => {
      if (rid === roomId) setLive((p) => [...p, msg as RoomMessage]);
    });
    const offApp = window.codeshell.ccRoom.onApprovalRequest((req) => {
      if (req.roomId === roomId) setPending((p) => [...p, req]);
    });
    return () => {
      offMsg();
      offApp();
    };
  }, [roomId, cwd, sessionId]);

  const send = useCallback(() => {
    const t = input.trim();
    if (!t) return;
    void window.codeshell.ccRoom.send(roomId, t);
    setInput("");
  }, [input, roomId]);

  const decide = (req: ApprovalReq, allow: boolean) => {
    void window.codeshell.ccRoom.respondApproval(
      roomId,
      req.requestId,
      allow ? { behavior: "allow" } : { behavior: "deny", message: "denied by user" },
    );
    setPending((p) => p.filter((r) => r.requestId !== req.requestId));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border p-2">
        <div className="text-sm font-medium">
          CC 会话 ·{" "}
          <code className="text-xs text-muted-foreground">
            {(sessionId || roomId).slice(0, 8)}
          </code>{" "}
          · {mode}
        </div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          返回
        </Button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {history.length > 0 && <div className="text-xs text-muted-foreground">— 历史 —</div>}
        {history.map((m, i) => (
          <div key={`h${i}`} className="opacity-70">
            <span className="text-xs font-semibold">{m.role}: </span>
            <span className="whitespace-pre-wrap text-sm">{m.text}</span>
            {m.tools?.map((t, j) => (
              <div key={j} className="text-xs text-muted-foreground">
                🔧 {t.name} {t.summary}
              </div>
            ))}
          </div>
        ))}
        {live.length > 0 && <div className="text-xs text-muted-foreground">— 实时 —</div>}
        {live.map((m) => (
          <div key={m.seq} className="text-sm">
            <span className="text-xs font-semibold">{m.from}: </span>
            {m.type === "text" && <span className="whitespace-pre-wrap">{m.text}</span>}
            {m.type === "tool" && (
              <span className="text-muted-foreground">
                🔧 {m.tool} {m.summary}
              </span>
            )}
            {m.type === "tool_result" && (
              <span className={m.isError ? "text-status-err" : "text-muted-foreground"}>
                ↳ {m.summary}
              </span>
            )}
            {m.type === "turn_end" && (
              <span className="text-xs text-muted-foreground">（完成）</span>
            )}
            {m.type === "error" && <span className="text-status-err">{m.text}</span>}
            {m.type === "approval" && (
              <span className="text-status-warn">需审批：{m.tool}</span>
            )}
          </div>
        ))}
        {pending.map((req) => (
          <Card key={req.requestId} className="space-y-1 p-3">
            <div className="text-sm font-medium">
              请求执行工具：{req.displayName ?? req.toolName}
            </div>
            {req.description && (
              <div className="text-xs text-muted-foreground">{req.description}</div>
            )}
            <pre className="mt-1 overflow-x-auto rounded bg-muted p-1 text-xs">
              {JSON.stringify(req.input, null, 2).slice(0, 400)}
            </pre>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => decide(req, true)}>
                允许
              </Button>
              <Button size="sm" variant="outline" onClick={() => decide(req, false)}>
                拒绝
              </Button>
            </div>
          </Card>
        ))}
      </div>
      <div className="flex gap-2 border-t border-border p-2">
        <Input
          className="flex-1"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
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
