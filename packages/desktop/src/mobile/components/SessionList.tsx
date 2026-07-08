import { useState } from "react";
import { Loader2, Plus, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@ui/button";
import { useT } from "@/i18n";
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
  unreadSessionIds,
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
  unreadSessionIds?: ReadonlySet<string>;
}) {
  const { t, lang } = useT();
  const [creating, setCreating] = useState(false);
  const allGroups = groupByProject(sessions, projects, lang);
  // When a project is selected, show only its group; otherwise show all (so the
  // screen is never empty on first load before a project is picked).
  const currentGroup = activeProjectCwd
    ? allGroups.find(
        (g) =>
          sameCwd(g.cwd, activeProjectCwd) ||
          sameCwd(projectForCwd(g.cwd, projects)?.path, activeProjectCwd),
      )
    : undefined;
  const groups = currentGroup ? [currentGroup] : activeProjectCwd ? [] : allGroups;
  const currentProject = projectForCwd(currentCwd, projects);
  const currentProjectCwd = currentProject?.path ?? currentCwd;
  const currentKnown = currentCwd !== undefined;
  const otherProjects = currentProject
    ? projects.filter((p) => p.path !== currentProject.path)
    : projects;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mobile-side-header flex items-center gap-2 px-3 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold leading-5">
            {t("mobile.sessionList.title")}
          </h2>
          <p className="text-[11px] text-muted-foreground">
            {t("mobile.sessionList.takeoverCount", { count: sessions.length })}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 gap-1.5">
          <Button
            aria-label={t("mobile.sessionList.refreshAria")}
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
            {creating ? t("common.cancel") : t("mobile.sessionList.new")}
          </Button>
        </div>
      </div>
      {creating && (
        <div className="mobile-create-panel border-b border-border/70 bg-black/12 p-2">
          <p className="mb-1.5 px-1 text-[11px] text-muted-foreground">
            {t("mobile.sessionList.createHint")}
          </p>
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => {
                onNew(currentKnown ? currentProjectCwd : undefined, currentProject?.name);
                setCreating(false);
              }}
              className="mobile-list-item flex w-full min-w-0 flex-col rounded-lg px-2.5 py-2 text-left text-sm"
            >
              <span className="truncate font-medium text-foreground">
                {currentProjectCwd
                  ? t("mobile.sessionList.currentProject", {
                      name: currentProject?.name ?? basename(currentProjectCwd),
                    })
                  : currentKnown
                    ? t("mobile.sessionList.noProjectConversation")
                    : t("mobile.sessionList.desktopCwd")}
              </span>
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                {currentProjectCwd ||
                  (currentKnown
                    ? t("mobile.sessionList.unboundRepo")
                    : t("mobile.sessionList.followsDesktopCwd"))}
              </span>
            </button>
            {otherProjects.length > 0 && (
              <>
                <p className="px-1 pt-2 text-[11px] text-muted-foreground">
                  {t("mobile.sessionList.otherProjects")}
                </p>
                {otherProjects.map((p) => (
                  <button
                    key={p.path}
                    type="button"
                    onClick={() => {
                      onNew(p.path, p.name);
                      setCreating(false);
                    }}
                    className="mobile-list-item flex w-full min-w-0 flex-col rounded-lg px-2.5 py-2 text-left text-sm"
                  >
                    <span className="truncate font-medium text-foreground">{p.name}</span>
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                      {p.path}
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}
      {onSelectProject && projects.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto overscroll-x-contain border-b border-border/70 px-2 py-1.5">
          {projects.map((p) => (
            <button
              key={p.path}
              type="button"
              onClick={() => onSelectProject(p.path)}
              className={cn(
                "max-w-44 shrink-0 truncate rounded-full border px-2.5 py-1 text-[11px]",
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
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
        {loading && sessions.length === 0 ? (
          <p className="mobile-glass flex items-center justify-center gap-2 rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-status-running" />
            {t("mobile.sessionList.loading")}
          </p>
        ) : sessions.length === 0 ? (
          <p className="mobile-glass rounded-lg px-3 py-6 text-center text-xs text-muted-foreground">
            {t("mobile.sessionList.empty")}
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.cwd || "__none__"} className="mb-3 min-w-0">
              {/* Project header — sticky so you always know which project the
                  sessions below belong to while scrolling a long list. */}
              <div
                className="sticky top-0 z-10 flex min-w-0 items-center gap-2 bg-background/90 px-1 py-1.5 backdrop-blur"
                title={g.cwd}
              >
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase text-muted-foreground">
                  {g.name}
                </span>
                <span className="shrink-0 rounded-full bg-muted/70 px-1.5 text-[10px] text-muted-foreground">
                  {g.items.length}
                </span>
              </div>
              <ul className="flex flex-col gap-1.5">
                {g.items.map((s) => {
                  const unread = Boolean(unreadSessionIds?.has(s.id) && s.id !== activeSessionId);
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => onSelect(s.id)}
                        className={cn(
                          "mobile-list-item flex w-full min-w-0 flex-col gap-1 rounded-lg px-3 py-2.5 text-left",
                          s.id === activeSessionId && "active",
                        )}
                      >
                        <div className="flex w-full min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                            {s.title}
                          </span>
                          {unread && (
                            <span
                              role="status"
                              aria-label={t("mobile.sessionList.unreadAria")}
                              title={t("mobile.sessionList.unreadAria")}
                              className="size-2 shrink-0 rounded-full bg-primary"
                            />
                          )}
                          {s.origin === "automation" && (
                            <span className="shrink-0 rounded-full border border-status-running/35 bg-status-running/10 px-1.5 text-[10px] text-status-running">
                              {t("mobile.sessionList.automation")}
                            </span>
                          )}
                        </div>
                        <div className="flex w-full min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                          <span className="min-w-0 flex-1 truncate">
                            {s.cwd || t("mobile.sessionList.noProjectPath")}
                          </span>
                          <span className="ml-auto shrink-0">
                            {relativeTime(s.updatedAt, Date.now(), lang)}
                          </span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
