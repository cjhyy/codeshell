import React, { useId } from "react";
import { ArrowUpRight, FolderCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n";

export interface OverviewModuleCard<Id extends string = string> {
  id: Id;
  label: string;
  Icon: React.ComponentType<{ className?: string; size?: number }>;
}

interface Props<Id extends string> {
  groups: { title: string; modules: OverviewModuleCard<Id>[] }[];
  onSelect: (id: Id) => void;
}

/** Project-only destinations, grouped exactly as the settings navigation. */
export function ProjectOverviewSection<Id extends string>({ groups, onSelect }: Props<Id>) {
  const { t } = useT();
  const headingId = useId();
  const visibleGroups = groups.filter((group) => group.modules.length > 0);
  return (
    <div className="@container/project-overview min-w-0 space-y-6">
      <p className="text-sm leading-relaxed text-muted-foreground">
        {t("settingsX.projectOverview.subtitle")}
      </p>
      {visibleGroups.length ? (
        <nav aria-label={t("projectConfig.overview.navigation")} className="space-y-6">
          {visibleGroups.map((group, index) => (
            <section key={group.title} aria-labelledby={`${headingId}-${index}`}>
              <h2
                id={`${headingId}-${index}`}
                className="mb-3 flex flex-wrap items-center gap-2 text-sm font-semibold"
              >
                {group.title}
                <span
                  className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground"
                  aria-hidden
                >
                  {group.modules.length}
                </span>
              </h2>
              <div className="grid min-w-0 gap-3 @min-[480px]/project-overview:grid-cols-2">
                {group.modules.map(({ id, label, Icon }) => (
                  <Button
                    key={id}
                    type="button"
                    variant="outline"
                    className="h-auto min-h-20 min-w-0 justify-start gap-3 whitespace-normal rounded-2xl border-border/70 bg-card p-4 text-left hover:border-primary/25 hover:bg-primary/5 focus-visible:ring-ring focus-visible:ring-inset"
                    onClick={() => onSelect(id)}
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon className="size-5" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 break-words text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                      {label}
                    </span>
                    <ArrowUpRight
                      size={15}
                      className="shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  </Button>
                ))}
              </div>
            </section>
          ))}
        </nav>
      ) : (
        <div
          role="status"
          className="rounded-2xl border border-dashed border-border/70 bg-muted/20 p-6 text-center text-sm text-muted-foreground"
        >
          <FolderCog size={24} className="mx-auto mb-3" aria-hidden />
          {t("projectConfig.overview.empty")}
        </div>
      )}
    </div>
  );
}
