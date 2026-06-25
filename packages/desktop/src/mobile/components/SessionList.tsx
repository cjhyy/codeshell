import { useState } from "react";
import { Loader2, Plus, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@ui/button";
import type { MobileProjectMeta, MobileSessionMeta } from "@protocol";
import { basename, relativeTime, groupByProject, projectForCwd } from "@mobile/lib/format";

function sameCwd(a?: string | null, b?: string | null): boolean {
  const norm = (v?: string | null): string => (v ?? "").replace(/[/\\]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** The desktop sessions the phone can open + drive, GROUPED BY PROJECT (cwd).
 *  When a project is selected (activeProjectCwd) only that project's sessions
 *  render; other projects collapse into a switcher (mirrors the desktop sidebar
 *  "current project / other projects" split). */
export function SessionList({
  sessions,
  projects,
  activeSessionId,
  currentCwd,
  activeProjectCwd,
  onSelect,
  onSelectProject,
  onNew,
  onRefresh,
  loading,
}: {
  sessions: MobileSessionMeta[];
  projects: MobileProjectMeta[];
  activeSessionId?: string;
  currentCwd?: string | null;
  activeProjectCwd?: string | null;
  onSelect: (id: string) => void;
  onSelectProject?: (cwd: string) => void;
  onNew: (cwd?: string | null, name?: string) => void;
  onRefresh: () => void;
  loading?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const allGroups = groupByProject(sessions, projects);
  // When a project is selected, show only its group; otherwise show all (so the
  // screen is never empty on first load before a project is picked).
  const currentGroup = activeProjectCwd
    ? allGroups.find((g) => sameCwd(g.cwd, activeProjectCwd) || sameCwd(projectForCwd(g.cwd, projects)?.path, activeProjectCwd))
    : undefined;
  const groups = currentGroup ? [currentGroup] : activeProjectCwd ? [] : allGroups;
  const currentProject = projectForCwd(currentCwd, projects);
  const currentProjectCwd = currentProject?.path ?? currentCwd;
  const currentKnown = currentCwd !== undefined;
  const otherProjects = currentProject
    ? projects.filter((p) => p.path !== currentProject.path)
    : projects;
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
            disabled={loading}
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
          <Button size="sm" onClick={() => setCreating((c) => !c)}>
            {creating ? <X /> : <Plus />}
            {creating ? "取消" : "新建"}
          </Button>
        </div>
      </div>
      {creating && (
        <div className="border-b border-border/70 bg-black/12 p-2">
          <p className="mb-1.5 px-1 text-[11px] text-muted-foreground">新会话默认使用当前目录</p>
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => {
                onNew(currentKnown ? currentProjectCwd : undefined, currentProject?.name);
                setCreating(false);
              }}
              className="mobile-list-item flex flex-col rounded-lg px-2.5 py-2 text-left text-sm"
            >
              <span className="font-medium text-foreground">
                {currentProjectCwd
                  ? `当前项目 · ${currentProject?.name ?? basename(currentProjectCwd)}`
                  : currentKnown
                    ? "无项目对话"
                    : "当前桌面目录"}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {currentProjectCwd || (currentKnown ? "不绑定 repo" : "跟随桌面当前 cwd")}
              </span>
            </button>
            {otherProjects.length > 0 && (
              <>
                <p className="px-1 pt-2 text-[11px] text-muted-foreground">其他项目</p>
                {otherProjects.map((p) => (
                  <button
                    key={p.path}
                    type="button"
                    onClick={() => {
                      onNew(p.path, p.name);
                      setCreating(false);
                    }}
                    className="mobile-list-item flex flex-col rounded-lg px-2.5 py-2 text-left text-sm"
                  >
                    <span className="font-medium text-foreground">{p.name}</span>
                    <span className="truncate text-[11px] text-muted-foreground">{p.path}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}
      {onSelectProject && projects.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto border-b border-border/70 px-2 py-1.5">
          {projects.map((p) => (
            <button
              key={p.path}
              type="button"
              onClick={() => onSelectProject(p.path)}
              className={cn(
                "shrink-0 rounded-full border px-2.5 py-1 text-[11px]",
                sameCwd(p.path, activeProjectCwd)
                  ? "border-primary bg-primary/15 text-foreground"
                  : "border-border/70 text-muted-foreground",
              )}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading && sessions.length === 0 ? (
          <p className="mobile-glass flex items-center justify-center gap-2 rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-status-running" />
            正在加载会话…
          </p>
        ) : sessions.length === 0 ? (
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
