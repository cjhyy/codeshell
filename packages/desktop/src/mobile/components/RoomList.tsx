import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@ui/button";
import type { RoomPublic } from "@protocol";
import { basename, relativeTime } from "@mobile/lib/format";

/** Rooms = resident Claude Code sessions. List + create-from-project + open. */
export function RoomList({
  rooms,
  projects,
  activeRoomId,
  onRefresh,
  onOpen,
  onCreate,
  onClose,
}: {
  rooms: RoomPublic[];
  projects: { path: string; name: string }[];
  activeRoomId?: string;
  onRefresh: () => void;
  onOpen: (room: RoomPublic) => void;
  onCreate: (cwd: string, name?: string) => void;
  onClose: (roomId: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <h2 className="text-sm font-semibold">房间</h2>
        <span className="text-xs text-muted-foreground">{rooms.length}</span>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={onRefresh}>
            刷新
          </Button>
          <Button size="sm" onClick={() => setCreating((c) => !c)}>
            {creating ? "取消" : "新建"}
          </Button>
        </div>
      </div>

      {creating && (
        <div className="border-b border-border bg-card/50 p-2">
          <p className="mb-1.5 px-1 text-[11px] text-muted-foreground">选一个项目开房间</p>
          {projects.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">没有可选项目</p>
          ) : (
            <div className="flex flex-col gap-1">
              {projects.map((p) => (
                <button
                  key={p.path}
                  type="button"
                  onClick={() => {
                    onCreate(p.path, p.name);
                    setCreating(false);
                  }}
                  className="flex flex-col rounded-md px-2 py-1.5 text-left text-sm active:bg-accent"
                >
                  <span className="font-medium text-foreground">{p.name}</span>
                  <span className="truncate text-[11px] text-muted-foreground">{p.path}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {rooms.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            还没有房间。房间挂一个常驻 Claude Code,上下文连续。
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rooms.map((r) => (
              <li key={r.id} className={cn(r.id === activeRoomId && "bg-accent")}>
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => onOpen(r)}
                    className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{r.name}</span>
                      <PermBadge mode={r.permissionMode} />
                      {r.open && <span className="size-1.5 rounded-full bg-status-ok" />}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="truncate">{basename(r.cwd)}</span>
                      <span className="ml-auto shrink-0">{relativeTime(r.lastActiveAt)}</span>
                    </div>
                  </button>
                  <Button size="sm" variant="ghost" onClick={() => onClose(r.id)}>
                    关
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
      <span className="rounded-full border border-status-warn/50 px-1.5 text-[10px] text-status-warn">
        自动改
      </span>
    );
  return null;
}
