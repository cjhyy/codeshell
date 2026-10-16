import React from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { ACTIVITY_PAGES, type ActivityPage } from "./activityPages";
export { isActivityPage } from "./activityPages";

export function ActivityNavigation({
  page,
  onNavigate,
  taskInboxEnabled,
}: {
  page: ActivityPage;
  onNavigate: (page: ActivityPage) => void;
  taskInboxEnabled: boolean;
}) {
  const { t } = useT();
  return (
    <nav
      aria-label={t("settingsX.menu.activity")}
      className="flex min-w-0 shrink-0 flex-nowrap items-center gap-1 overflow-x-auto border-b border-border/70 bg-background px-3 py-2 sm:px-5"
    >
      <History size={15} aria-hidden className="mx-2 shrink-0 text-muted-foreground" />
      {ACTIVITY_PAGES.filter((entry) => entry.page !== "task_inbox" || taskInboxEnabled).map(
        ({ page: target, label, Icon }) => (
          <Button
            key={target}
            type="button"
            size="sm"
            variant={target === page ? "secondary" : "ghost"}
            aria-current={target === page ? "page" : undefined}
            className="h-8 shrink-0 gap-1.5 rounded-lg px-2.5 text-xs"
            onClick={() => {
              if (target !== page) onNavigate(target);
            }}
          >
            <Icon size={14} aria-hidden />
            {t(label)}
          </Button>
        ),
      )}
    </nav>
  );
}
