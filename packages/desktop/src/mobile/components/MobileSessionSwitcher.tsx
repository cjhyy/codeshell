import { useState, type ReactNode } from "react";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

export type MobileSessionTab = "sessions" | "cc";

export function initialMobileSessionTab(activeRoom?: unknown): MobileSessionTab {
  return activeRoom ? "cc" : "sessions";
}

export function MobileSessionSwitcher({
  activeRoom,
  sessionsContent,
  ccContent,
}: {
  activeRoom?: unknown;
  sessionsContent: ReactNode;
  ccContent: ReactNode;
}) {
  const { t } = useT();
  const [tab, setTab] = useState<MobileSessionTab>(() => initialMobileSessionTab(activeRoom));
  return (
    <MobileSessionSwitcherView
      tab={tab}
      onTabChange={setTab}
      labels={{
        sessions: t("mobile.sidePane.localTab"),
        cc: t("mobile.sidePane.ccTab"),
      }}
      sessionsContent={sessionsContent}
      ccContent={ccContent}
    />
  );
}

export function MobileSessionSwitcherView({
  tab,
  onTabChange,
  labels,
  sessionsContent,
  ccContent,
}: {
  tab: MobileSessionTab;
  onTabChange: (tab: MobileSessionTab) => void;
  labels: Record<MobileSessionTab, string>;
  sessionsContent: ReactNode;
  ccContent: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border/70 px-3 py-2">
        <div
          className="mobile-tab-strip grid grid-cols-2 gap-1 rounded-full p-0.5"
          role="tablist"
        >
          {(["sessions", "cc"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-pressed={tab === id}
              data-tab={id}
              onClick={() => onTabChange(id)}
              className={cn(
                "min-w-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                tab === id ? "bg-primary/15 text-primary" : "text-muted-foreground",
              )}
            >
              <span className="block truncate">{labels[id]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden" role="tabpanel">
        {tab === "sessions" ? sessionsContent : ccContent}
      </div>
    </div>
  );
}
