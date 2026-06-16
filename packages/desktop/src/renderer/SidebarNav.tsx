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

interface NavBadges {
  approvals?: number;
  runs?: number;
}

interface Props {
  active: ViewMode;
  onSelect: (v: ViewMode) => void;
  badges?: NavBadges;
}

interface Item {
  id: ViewMode;
  label: string;
  Icon: React.ComponentType<{ size?: number }>;
  badge?: keyof NavBadges;
}

const ITEMS: Item[] = [
  { id: "chat", label: "对话", Icon: MessageSquare },
  { id: "sessions", label: "会话", Icon: ListChecks },
  { id: "approvals", label: "审批", Icon: ShieldAlert, badge: "approvals" },
  { id: "runs", label: "运行", Icon: Activity, badge: "runs" },
  { id: "automation", label: "自动化", Icon: Workflow },
  { id: "credentials", label: "凭证", Icon: KeyRound },
  { id: "logs", label: "日志", Icon: ScrollText },
  { id: "settings", label: "设置", Icon: Settings },
];

export function SidebarNav({ active, onSelect, badges = {} }: Props) {
  return (
    <nav className="flex flex-col gap-1">
      {ITEMS.map(({ id, label, Icon, badge }) => {
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
