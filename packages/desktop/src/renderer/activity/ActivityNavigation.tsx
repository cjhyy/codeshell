import React from "react";
import { Activity, History, ListTodo, MessageSquare, ScrollText, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import type { TranslationKey } from "../i18n/dict";
import type { ActivityPage } from "../settings/SettingsMenu";

const PAGES = [
  { page: "task_inbox", label: "taskInbox.title", Icon: ListTodo },
  { page: "sessions", label: "auto.sessions.title", Icon: MessageSquare },
  { page: "runs", label: "auto.runs.title", Icon: Activity },
  { page: "approvals", label: "auto.approvals.title", Icon: ShieldCheck },
  { page: "logs", label: "auto.logs.title", Icon: ScrollText },
] as const satisfies ReadonlyArray<{ page: ActivityPage; label: TranslationKey; Icon: unknown }>;

export function isActivityPage(page: string): page is ActivityPage {
  return PAGES.some((entry) => entry.page === page);
}

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
      className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/70 bg-background px-3 py-2 sm:px-5"
    >
      <History size={15} aria-hidden className="mx-2 shrink-0 text-muted-foreground" />
      {PAGES.filter((entry) => entry.page !== "task_inbox" || taskInboxEnabled).map(
        ({ page: target, label, Icon }) => (
          <Button
            key={target}
            type="button"
            size="sm"
            variant={target === page ? "secondary" : "ghost"}
            aria-current={target === page ? "page" : undefined}
            className="h-8 gap-1.5 rounded-lg px-2.5 text-xs"
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
