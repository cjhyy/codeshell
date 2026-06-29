import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Plus, RefreshCw, Send, X } from "lucide-react";
import type { RoomPublic, RoomMessageWire } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useT, type TFunction } from "../i18n/I18nProvider";

/**
 * Rooms panel — resident Claude Code (stream-json) sessions, dual-ended with
 * the phone. Desktop and phone drive the SAME RoomManager / process /
 * messages.jsonl, so a room opened on the phone shows here and vice-versa, with
 * shared context. Two views: room list (+ create from a recent project) and an
 * in-room conversation (history + live stream + composer).
 */
export function RoomsPanel() {
  const { t } = useT();
  const [rooms, setRooms] = useState<RoomPublic[]>([]);
  const [projects, setProjects] = useState<{ path: string; name: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [cliKind, setCliKind] = useState<"claude-code" | "codex">("claude-code");
  const [active, setActive] = useState<RoomPublic | null>(null);
  const [messages, setMessages] = useState<RoomMessageWire[]>([]);
  const [input, setInput] = useState("");
  const seqRef = useRef(0);
  const feedRef = useRef<HTMLDivElement>(null);
  // Monotonic token bumped on every enter()/leave(); a history load that resolves
  // after the room changed (or another enter started) is dropped instead of
  // clobbering the now-current feed.
  const enterTokenRef = useRef(0);

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
    await window.codeshell.rooms.create({ name: project.name, cwd: project.path, kind: cliKind });
    setCreating(false);
    await refreshRooms();
  }

  async function enter(room: RoomPublic) {
    const token = ++enterTokenRef.current;
    setActive(room);
    setMessages([]);
    seqRef.current = 0;
    await window.codeshell.rooms.open(room.id);
    const history = await window.codeshell.rooms.history(room.id, 0);
    // A newer enter()/leave() happened during the await → this load is stale, drop it.
    if (enterTokenRef.current !== token) return;
    // Messages may have arrived via onMessage while history was loading. Merge by
    // seq (history is authoritative for what it covers; keep any live message with a
    // higher seq) so a mid-load push isn't overwritten and lost from the feed.
    setMessages((live) => {
      const bySeq = new Map<number, RoomMessageWire>();
      for (const m of history) bySeq.set(m.seq, m);
      for (const m of live) if (!bySeq.has(m.seq)) bySeq.set(m.seq, m);
      return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    });
    const maxSeq = Math.max(seqRef.current, ...history.map((m) => m.seq), 0);
    seqRef.current = maxSeq;
  }

  function leave() {
    enterTokenRef.current++;
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
    // No optimistic echo: main persists the user message and pushes it back via
    // onMessage (with its real seq). Echoing here too would double it.
    await window.codeshell.rooms.send(active.id, text);
  }

  // ── Room list view ────────────────────────────────────────────────────
  if (!active) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-sm font-medium">{t("panels.rooms.listTitle")}</span>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={refreshRooms} title={t("panels.common.refresh")}>
            <RefreshCw className="size-4" />
          </Button>
          <Button size="sm" onClick={startCreate}>
            <Plus className="size-4" /> {t("panels.common.create")}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-2">
          {creating && (
            <div className="rounded-lg border border-border p-3">
              <p className="mb-2 text-xs text-muted-foreground">{t("panels.rooms.pickCli")}</p>
              <div className="mb-3 flex gap-1.5">
                {(["claude-code", "codex"] as const).map((k) => (
                  <Button
                    key={k}
                    size="sm"
                    variant={cliKind === k ? "default" : "outline"}
                    onClick={() => setCliKind(k)}
                  >
                    {k === "codex" ? "Codex" : "Claude Code"}
                  </Button>
                ))}
              </div>
              <p className="mb-2 text-xs text-muted-foreground">{t("panels.rooms.pickProject")}</p>
              {projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("panels.rooms.noProjects")}</p>
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
                {t("panels.common.cancel")}
              </Button>
            </div>
          )}
          {rooms.length === 0 && !creating ? (
            <p className="p-4 text-center text-sm text-muted-foreground">{t("panels.rooms.empty")}</p>
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
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="min-w-0 truncate font-medium">{r.name}</span>
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                        {r.kind === "codex" ? "Codex" : "Claude"}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[10px]",
                          danger ? "bg-status-err/15 text-status-err" : "bg-primary/15 text-primary",
                        )}
                      >
                        {danger ? t("panels.rooms.dangerous") : r.permissionMode}
                      </span>
                      {r.open && <span className="shrink-0 text-[10px] text-status-ok">{t("panels.rooms.running")}</span>}
                    </div>
                    <div className="break-all text-xs text-muted-foreground">{r.cwd}</div>
                  </div>
                  <Button size="sm" variant="ghost" className="shrink-0" onClick={(e) => void closeRoom(r, e)} title={t("panels.rooms.closeRoom")}>
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
        <Button size="sm" variant="ghost" className="shrink-0" onClick={leave}>
          <ArrowLeft className="size-4" />
        </Button>
        <span className="shrink-0 text-sm font-medium">{active.name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{active.cwd}</span>
      </div>
      <div ref={feedRef} className="min-h-0 flex-1 overflow-y-auto p-3 space-y-2">
        {messages.filter((m) => m.type !== "room_created").map((m, i) => (
          <RoomMsg key={`${m.seq}-${i}`} m={m} t={t} />
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
          placeholder={t("panels.rooms.composerPlaceholder", { name: active.name })}
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

function RoomMsg({ m, t }: { m: RoomMessageWire; t: TFunction }) {
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
        <span className="text-primary">{t("panels.rooms.tool", { tool: m.tool ?? "" })}</span>
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
    return <div className="text-xs italic text-status-err">{m.text || t("panels.rooms.error")}</div>;
  }
  if (m.type === "agent_exit") {
    return <div className="text-xs italic text-muted-foreground">{t("panels.rooms.agentExited")}</div>;
  }
  return null; // turn_end and others: no bubble
}
