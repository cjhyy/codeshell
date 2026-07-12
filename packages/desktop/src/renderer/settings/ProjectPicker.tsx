import React from "react";
import { ChevronRight, FolderGit2, Globe } from "lucide-react";
import { projectLabel, type TrackedProject } from "../projects";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";

/**
 * A list of projects (projects) the user can click to drill into. Used by the
 * 钩子 and 记忆 settings pages: pick a project first, then view/edit that
 * project's hooks / memory. Reuses the same `projects` list as the sidebar.
 *
 * When `includeGlobal` is set (memory page), a "全局" row is rendered at the
 * top — selecting it calls `onSelect(null)`, meaning the global / user level
 * (which has no project dimension).
 */
export function ProjectPicker({
  projects,
  includeGlobal = false,
  globalLabel,
  globalHint,
  emptyHint,
  onSelect,
}: {
  projects: TrackedProject[];
  includeGlobal?: boolean;
  globalLabel?: string;
  globalHint?: string;
  emptyHint?: string;
  onSelect: (path: string | null) => void;
}) {
  const { t } = useT();
  const resolvedGlobalLabel = globalLabel ?? t("settingsX.projectPicker.global");
  const resolvedEmptyHint = emptyHint ?? t("settingsX.projectPicker.empty");
  const ordered = React.useMemo(
    () =>
      projects.slice().sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return projectLabel(a).localeCompare(projectLabel(b));
      }),
    [projects],
  );

  return (
    <ul className="flex flex-col gap-1.5" role="list">
      {includeGlobal && (
        <Row
          icon={<Globe size={15} />}
          title={resolvedGlobalLabel}
          hint={globalHint}
          onClick={() => onSelect(null)}
        />
      )}
      {ordered.length === 0 && !includeGlobal ? (
        <li className="rounded-md border border-border bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
          {resolvedEmptyHint}
        </li>
      ) : (
        ordered.map((repo) => (
          <Row
            key={repo.id}
            icon={<FolderGit2 size={15} />}
            title={projectLabel(repo)}
            hint={repo.path}
            onClick={() => onSelect(repo.path)}
          />
        ))
      )}
    </ul>
  );
}

function Row({
  icon,
  title,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "group flex w-full items-center gap-3 rounded-md border border-border bg-card px-4 py-3 text-left transition-colors",
          "hover:bg-accent/60",
        )}
      >
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
          {hint && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
        </span>
        <ChevronRight
          size={16}
          className="ml-auto shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        />
      </button>
    </li>
  );
}
