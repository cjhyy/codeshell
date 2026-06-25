import { useState } from "react";
import { Loader2, Plus, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@ui/button";
import type { MobileProjectMeta, RoomPublic } from "@protocol";
import { basename, projectForCwd, relativeTime } from "@mobile/lib/format";

/** Rooms = resident Claude Code sessions. List + create-from-project + open. */
export function RoomList({
  rooms,
  projects,
  currentCwd,
  activeRoomId,
  onRefresh,
  onOpen,
  onCreate,
  onClose,
  loading,
}: {
  rooms: RoomPublic[];
  projects: MobileProjectMeta[];
  currentCwd?: string | null;
  activeRoomId?: string;
  onRefresh: () => void;
  onOpen: (room: RoomPublic) => void;
  onCreate: (cwd: string, name?: string) => void;
  onClose: (roomId: string) => void;
  loading?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const currentProject = projectForCwd(currentCwd, projects);
  const roomCwd = currentProject?.path ?? currentCwd;
  const currentName = roomCwd ? currentProject?.name ?? basename(roomCwd) : "";
  return (
    <div className="flex h-full flex-col">
      <div className="mobile-side-header flex items-center gap-2 px-3 py-3">
        <div>
          <h2 className="text-sm font-semibold leading-5">房间</h2>
          <p className="max-w-[11rem] truncate text-[11px] text-muted-foreground">
            {roomCwd ? `${currentName} · ${rooms.length} 个` : "当前会话无目录"}
          </p>
        </div>
        <div className="ml-auto flex gap-1.5">
          <Button
            aria-label="刷新房间"
            className="mobile-icon-button size-8"
            size="icon"
            variant="outline"
            onClick={onRefresh}
            disabled={loading}
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
          <Button size="sm" disabled={!roomCwd} onClick={() => setCreating((c) => !c)}>
            {creating ? <X /> : <Plus />}
            {creating ? "取消" : "新建"}
          </Button>
        </div>
      </div>

      {creating && (
        <div className="border-b border-border/70 bg-black/12 p-2">
          <p className="mb-1.5 px-1 text-[11px] text-muted-foreground">
            在当前会话目录创建 Claude Code 房间
          </p>
          <button
            type="button"
            disabled={!roomCwd}
            onClick={() => {
              if (!roomCwd) return;
              onCreate(roomCwd, currentName);
              setCreating(false);
            }}
            className="mobile-list-item flex w-full flex-col rounded-lg px-2.5 py-2 text-left text-sm disabled:opacity-50"
          >
            <span className="font-medium text-foreground">{currentName || "无目录"}</span>
            <span className="truncate text-[11px] text-muted-foreground">
              {roomCwd || "请先选择一个带目录的会话"}
            </span>
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading && rooms.length === 0 ? (
          <p className="mobile-glass flex items-center justify-center gap-2 rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-status-running" />
            正在加载房间…
          </p>
        ) : !roomCwd ? (
          <p className="mobile-glass rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            当前会话没有项目目录。选择一个带 cwd 的会话后,这里会显示对应的 Claude Code 房间。
          </p>
        ) : rooms.length === 0 ? (
          <p className="mobile-glass rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            当前目录还没有房间。新建后会挂一个常驻 Claude Code,上下文连续。
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rooms.map((r) => (
              <li key={r.id}>
                <div
                  className={cn(
                    "mobile-list-item flex items-center gap-2 rounded-lg px-3 py-2.5",
                    r.id === activeRoomId && "active",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onOpen(r)}
                    className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{r.name}</span>
                      <PermBadge mode={r.permissionMode} />
                      {r.open && (
                        <span className="size-1.5 rounded-full bg-status-ok shadow-[0_0_10px_hsl(var(--cs-status-ok))]" />
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="truncate">{basename(r.cwd)}</span>
                      <span className="ml-auto shrink-0">{relativeTime(r.lastActiveAt)}</span>
                    </div>
                  </button>
                  <Button
                    aria-label="关闭房间"
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    onClick={() => onClose(r.id)}
                  >
                    <X />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PermBadge({ mode }: { mode: RoomPublic["permissionMode"] }) {
  if (mode === "bypassPermissions")
    return (
      <span className="rounded-full border border-status-err/60 px-1.5 text-[10px] font-semibold text-status-err">
        危险
      </span>
    );
  if (mode === "acceptEdits")
    return (
      <span className="rounded-full border border-status-warn/50 bg-status-warn/10 px-1.5 text-[10px] text-status-warn">
        自动改
      </span>
    );
  return null;
}
