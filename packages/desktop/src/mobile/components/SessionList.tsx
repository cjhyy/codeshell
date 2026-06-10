import { Plus, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@ui/button";
import type { MobileSessionMeta } from "@protocol";
import { relativeTime, groupByProject } from "@mobile/lib/format";

/** The desktop sessions the phone can open + drive, GROUPED BY PROJECT (cwd). */
export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onNew,
  onRefresh,
}: {
  sessions: MobileSessionMeta[];
  activeSessionId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRefresh: () => void;
}) {
  const groups = groupByProject(sessions);
  return (
    <div className="flex h-full flex-col">
      <div className="mobile-side-header flex items-center gap-2 px-3 py-3">
        <div>
          <h2 className="text-sm font-semibold leading-5">会话</h2>
          <p className="text-[11px] text-muted-foreground">{sessions.length} 个可接管</p>
        </div>
        <div className="ml-auto flex gap-1.5">
          <Button
            aria-label="刷新会话"
            className="mobile-icon-button size-8"
            size="icon"
            variant="outline"
            onClick={onRefresh}
          >
            <RefreshCw />
          </Button>
          <Button size="sm" onClick={onNew}>
            <Plus />
            新建
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {sessions.length === 0 ? (
          <p className="mobile-glass rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            还没有会话。点「新建」开一个,或在桌面端开始。
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.cwd || "__none__"} className="mb-3">
              {/* Project header — sticky so you always know which project the
                  sessions below belong to while scrolling a long list. */}
              <div
                className="sticky top-0 z-10 flex items-center gap-2 bg-background/90 px-1 py-1.5 backdrop-blur"
                title={g.cwd}
              >
                <span className="truncate text-[11px] font-semibold uppercase text-muted-foreground">
                  {g.name}
                </span>
                <span className="rounded-full bg-muted/70 px-1.5 text-[10px] text-muted-foreground">
                  {g.items.length}
                </span>
              </div>
              <ul className="flex flex-col gap-1.5">
                {g.items.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(s.id)}
                      className={cn(
                        "mobile-list-item flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left",
                        s.id === activeSessionId && "active",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {s.title}
                        </span>
                        {s.origin === "automation" && (
                          <span className="rounded-full border border-status-running/35 bg-status-running/10 px-1.5 text-[10px] text-status-running">
                            自动
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="truncate">{s.cwd || "无项目路径"}</span>
                        <span className="ml-auto shrink-0">{relativeTime(s.updatedAt)}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
