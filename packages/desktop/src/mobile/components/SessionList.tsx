import { cn } from "@/lib/utils";
import { Button } from "@ui/button";
import type { MobileSessionMeta } from "@protocol";
import { relativeTime, basename } from "@mobile/lib/format";

/** The list of desktop sessions the phone can open + drive. */
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
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <h2 className="text-sm font-semibold">会话</h2>
        <span className="text-xs text-muted-foreground">{sessions.length}</span>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={onRefresh}>
            刷新
          </Button>
          <Button size="sm" onClick={onNew}>
            新建
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            还没有会话。点「新建」开一个,或在桌面端开始。
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onSelect(s.id)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 px-3 py-2.5 text-left active:bg-accent",
                    s.id === activeSessionId && "bg-accent",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{s.title}</span>
                    {s.origin === "automation" && (
                      <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">
                        自动
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="truncate">{basename(s.cwd) || "无项目"}</span>
                    <span className="ml-auto shrink-0">{relativeTime(s.updatedAt)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
