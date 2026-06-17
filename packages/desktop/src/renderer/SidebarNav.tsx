import React from "react";
import {
  MessageSquare,
  ListChecks,
  ShieldAlert,
  Activity,
  ScrollText,
  Settings,
  Workflow,
  KeyRound,
} from "./ui/icons";
import { Badge } from "./ui/Badge";
import type { ViewMode } from "./view";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "./i18n/I18nProvider";

interface NavBadges {
  approvals?: number;
  runs?: number;
}

interface Props {
  active: ViewMode;
  onSelect: (v: ViewMode) => void;
  badges?: NavBadges;
}

/** ViewModes that appear in the nav (each has a `misc.nav.<id>` dict key). */
type NavId =
  | "chat"
  | "sessions"
  | "approvals"
  | "runs"
  | "automation"
  | "credentials"
  | "logs"
  | "settings";

interface Item {
  id: NavId;
  Icon: React.ComponentType<{ size?: number }>;
  badge?: keyof NavBadges;
}

const ITEMS: Item[] = [
  { id: "chat", Icon: MessageSquare },
  { id: "sessions", Icon: ListChecks },
  { id: "approvals", Icon: ShieldAlert, badge: "approvals" },
  { id: "runs", Icon: Activity, badge: "runs" },
  { id: "automation", Icon: Workflow },
  { id: "credentials", Icon: KeyRound },
  { id: "logs", Icon: ScrollText },
  { id: "settings", Icon: Settings },
];

export function SidebarNav({ active, onSelect, badges = {} }: Props) {
  const { t } = useT();
  return (
    <nav className="flex flex-col gap-1">
      {ITEMS.map(({ id, Icon, badge }) => {
        const label = t(`misc.nav.${id}`);
        const count = badge ? badges[badge] ?? 0 : 0;
        return (
          <Button
            key={id}
            variant="ghost"
            className={cn(
              "h-9 justify-start gap-2 px-2 text-muted-foreground",
              active === id && "bg-accent text-foreground",
            )}
            onClick={() => onSelect(id)}
            aria-current={active === id ? "page" : undefined}
          >
            <Icon size={14} />
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            {count > 0 && <Badge count={count} />}
          </Button>
        );
      })}
    </nav>
  );
}
