import React from "react";
import {
  MessageSquare,
  ListChecks,
  ShieldAlert,
  Activity,
  Plug,
  ScrollText,
  Settings,
} from "./ui/icons";
import { Badge } from "./ui/Badge";
import type { ViewMode } from "./view";

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
  { id: "logs", label: "日志", Icon: ScrollText },
  { id: "settings", label: "设置", Icon: Settings },
];

export function SidebarNav({ active, onSelect, badges = {} }: Props) {
  return (
    <nav className="sidebar-nav">
      {ITEMS.map(({ id, label, Icon, badge }) => {
        const count = badge ? badges[badge] ?? 0 : 0;
        return (
          <button
            key={id}
            className={`sidebar-nav-item${active === id ? " active" : ""}`}
            onClick={() => onSelect(id)}
            aria-current={active === id ? "page" : undefined}
          >
            <Icon size={14} />
            <span className="sidebar-nav-label">{label}</span>
            {count > 0 && <Badge count={count} />}
          </button>
        );
      })}
    </nav>
  );
}
