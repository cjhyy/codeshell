import React from "react";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n";

export interface OverviewModuleCard<Id extends string = string> {
  id: Id;
  label: string;
  Icon: React.ComponentType<{ className?: string; size?: number }>;
}

interface Props<Id extends string> {
  modules: OverviewModuleCard<Id>[];
  onSelect: (id: Id) => void;
}

/** 项目 scope 首屏:该项目可配置模块的导航卡片。 */
export function ProjectOverviewSection<Id extends string>({ modules, onSelect }: Props<Id>) {
  const { t } = useT();
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-base font-semibold">{t("settingsX.projectOverview.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settingsX.projectOverview.subtitle")}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {modules.map(({ id, label, Icon }) => (
          <Button
            key={id}
            type="button"
            variant="outline"
            className="h-auto min-h-20 items-start justify-start gap-3 whitespace-normal p-4 text-left"
            onClick={() => onSelect(id)}
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="size-5" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground">{label}</span>
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}
