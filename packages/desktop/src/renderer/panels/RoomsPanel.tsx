import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Plus, RefreshCw, Send, X } from "lucide-react";
import type { RoomPublic, RoomMessageWire } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Rooms panel — resident Claude Code (stream-json) sessions, dual-ended with
 * the phone. Desktop and phone drive the SAME RoomManager / process /
 * messages.jsonl, so a room opened on the phone shows here and vice-versa, with
 * shared context. Two views: room list (+ create from a recent project) and an
 * in-room conversation (history + live stream + composer).
 */
export function RoomsPanel() {
  const [rooms, setRooms] = useState<RoomPublic[]>([]);
  const [projects, setProjects] = useState<{ path: string; name: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [active, setActive] = useState<RoomPublic | null>(null);
  const [messages, setMessages] = useState<RoomMessageWire[]>([]);
  const [input, setInput] = useState("");
  const seqRef = useRef(0);
  const feedRef = useRef<HTMLDivElement>(null);

  const refreshRooms = useCallback(async () => {
    setRooms(await window.codeshell.rooms.list());
  }, []);

  useEffect(() => {
    void refreshRooms();
  }, [refreshRooms]);

  // Live messages for the active room (pushed from main via IPC).
  useEffect(() => {
    const off = window.codeshell.rooms.onMessage(({ roomId, msg }) => {
      if (active && roomId === active.id) {
        setMessages((prev) => [...prev, msg]);
        if (msg.seq) seqRef.current = msg.seq;
      }
    });
    return off;
  }, [active]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [messages]);

  async function startCreate() {
    setProjects(await window.codeshell.rooms.projects());
    setCreating(true);
  }

  async function createFor(project: { path: string; name: string }) {
    await window.codeshell.rooms.create({ name: project.name, cwd: project.path });
    setCreating(false);
    await refreshRooms();
  }

  async function enter(room: RoomPublic) {
    setActive(room);
    setMessages([]);
    seqRef.current = 0;
    await window.codeshell.rooms.open(room.id);
    const history = await window.codeshell.rooms.history(room.id, 0);
    setMessages(history);
    if (history.length) seqRef.current = history[history.length - 1]!.seq;
  }

  function leave() {
    setActive(null);
    setMessages([]);
  }

  async function closeRoom(room: RoomPublic, e: React.MouseEvent) {
    e.stopPropagation();
    await window.codeshell.rooms.close(room.id);
    await refreshRooms();
  }

  async function send() {
    const text = input.trim();
    if (!text || !active) return;
    setInput("");
    await window.codeshell.rooms.send(active.id, text);
    // optimistic echo; the persisted user message also arrives via onMessage
    setMessages((prev) => [
      ...prev,
      { seq: -Date.now(), ts: Date.now(), from: "user", type: "text", text },
    ]);
  }

  // ── Room list view ────────────────────────────────────────────────────
  if (!active) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-sm font-medium">房间 · 常驻 Claude Code</span>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={refreshRooms} title="刷新">
            <RefreshCw className="size-4" />
          </Button>
          <Button size="sm" onClick={startCreate}>
            <Plus className="size-4" /> 新建
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-2">
          {creating && (
            <div className="rounded-lg border border-border p-3">
              <p className="mb-2 text-xs text-muted-foreground">选择项目目录(常驻 CC 在此干活):</p>
              {projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">无最近项目。先在桌面打开一个项目。</p>
              ) : (
                <div className="space-y-1">
                  {projects.map((p) => (
                    <button
                      key={p.path}
                      onClick={() => void createFor(p)}
                      className="block w-full rounded-md border border-border bg-background p-2 text-left text-sm hover:bg-accent"
                    >
                      <div className="font-medium">{p.name}</div>
                      <div className="break-all text-xs text-muted-foreground">{p.path}</div>
                    </button>
                  ))}
                </div>
              )}
              <Button size="sm" variant="ghost" className="mt-2" onClick={() => setCreating(false)}>
                取消
              </Button>
            </div>
          )}
          {rooms.length === 0 && !creating ? (
            <p className="p-4 text-center text-sm text-muted-foreground">还没有房间,点「新建」</p>
          ) : (
            rooms.map((r) => {
              const danger = r.permissionMode === "bypassPermissions";
              return (
                <div
                  key={r.id}
                  onClick={() => void enter(r)}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-background p-3 hover:bg-accent"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{r.name}</span>
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px]",
                          danger ? "bg-status-err/15 text-status-err" : "bg-primary/15 text-primary",
                        )}
                      >
                        {danger ? "dangerous" : r.permissionMode}
                      </span>
                      {r.open && <span className="text-[10px] text-status-ok">●运行中</span>}
                    </div>
                    <div className="break-all text-xs text-muted-foreground">{r.cwd}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={(e) => void closeRoom(r, e)} title="关闭房间">
                    <X className="size-4" />
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  // ── In-room conversation view ─────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button size="sm" variant="ghost" onClick={leave}>
          <ArrowLeft className="size-4" />
        </Button>
        <span className="text-sm font-medium">{active.name}</span>
        <span className="truncate text-xs text-muted-foreground">{active.cwd}</span>
      </div>
      <div ref={feedRef} className="min-h-0 flex-1 overflow-y-auto p-3 space-y-2">
        {messages.filter((m) => m.type !== "room_created").map((m, i) => (
          <RoomMsg key={`${m.seq}-${i}`} m={m} />
        ))}
      </div>
      <div className="flex items-end gap-2 border-t border-border p-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={`在房间「${active.name}」里跟 Claude Code 对话…`}
          className="max-h-32 min-h-9 flex-1 resize-none"
          rows={1}
        />
        <Button size="sm" onClick={() => void send()} disabled={!input.trim()}>
          <Send className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function RoomMsg({ m }: { m: RoomMessageWire }) {
  if (m.from === "user" && m.type === "text") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground whitespace-pre-wrap break-words">
          {m.text}
        </div>
      </div>
    );
  }
  if (m.from === "agent" && m.type === "text") {
    return (
      <div className="flex">
        <div className="max-w-[85%] rounded-lg rounded-bl-sm border border-border bg-background px-3 py-2 text-sm whitespace-pre-wrap break-words">
          {m.text}
        </div>
      </div>
    );
  }
  if (m.from === "agent" && m.type === "tool") {
    return (
      <div className="rounded-md border border-border bg-background p-2 text-xs">
        <span className="text-primary">工具 · {m.tool}</span>
        {m.summary && <div className="mt-1 font-mono break-all text-muted-foreground">{m.summary}</div>}
      </div>
    );
  }
  if (m.from === "agent" && m.type === "tool_result") {
    return (
      <div className={cn("rounded-md border border-border bg-background p-2 text-xs", m.isError && "text-status-err")}>
        <div className="font-mono break-all whitespace-pre-wrap">{m.summary}</div>
      </div>
    );
  }
  if (m.type === "error") {
    return <div className="text-xs italic text-status-err">{m.text || "错误"}</div>;
  }
  if (m.type === "agent_exit") {
    return <div className="text-xs italic text-muted-foreground">常驻 CC 已退出</div>;
  }
  return null; // turn_end and others: no bubble
}
