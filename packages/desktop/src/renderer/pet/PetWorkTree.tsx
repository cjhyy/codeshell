import React from "react";
import {
  CheckCircle2,
  ChevronDown,
  CircleDot,
  FolderKanban,
  Inbox,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useT } from "../i18n";
import type { PetSessionEmptyState } from "./SessionStatusSection";
import { RISK_TONE, type PetWorkGroup, type PetWorkItem, type PetWorkMap } from "./petWorkMap";

const STATE_DOT: Record<PetWorkItem["state"], string> = {
  "needs-action": "bg-status-warn",
  "follow-up": "bg-status-warn",
  running: "bg-status-running animate-pulse motion-reduce:animate-none",
  queued: "bg-status-running",
  failed: "bg-status-err",
  cancelled: "bg-muted-foreground",
  completed: "bg-status-ok",
  idle: "bg-muted-foreground",
};

const STATE_BADGE: Record<PetWorkItem["state"], string> = {
  "needs-action": "bg-status-warn/10 text-status-warn",
  "follow-up": "bg-status-warn/10 text-status-warn",
  running: "bg-status-running/10 text-status-running",
  queued: "bg-status-running/10 text-status-running",
  failed: "bg-status-err/10 text-status-err",
  cancelled: "bg-muted text-muted-foreground",
  completed: "bg-status-ok/10 text-status-ok",
  idle: "bg-muted text-muted-foreground",
};

const BRANCH_META: Record<PetWorkGroup, { Icon: LucideIcon; icon: string; count: string }> = {
  running: {
    Icon: CircleDot,
    icon: "bg-status-running/10 text-status-running",
    count: "bg-status-running/10 text-status-running",
  },
  pending: {
    Icon: CircleDot,
    icon: "bg-status-warn/10 text-status-warn",
    count: "bg-status-warn/10 text-status-warn",
  },
  "follow-up": {
    Icon: Sparkles,
    icon: "bg-status-warn/10 text-status-warn",
    count: "bg-status-warn/10 text-status-warn",
  },
  completed: {
    Icon: CheckCircle2,
    icon: "bg-status-ok/10 text-status-ok",
    count: "bg-status-ok/10 text-status-ok",
  },
  other: {
    Icon: Inbox,
    icon: "bg-muted text-muted-foreground",
    count: "bg-muted text-muted-foreground",
  },
};

function WorkBranch({
  group,
  items,
  onOpen,
  onDismiss,
}: {
  group: PetWorkGroup;
  items: readonly PetWorkItem[];
  onOpen?: (item: PetWorkItem) => void;
  onDismiss?: (item: PetWorkItem) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = React.useState(false);
  const { Icon, icon, count } = BRANCH_META[group];
  if (items.length === 0) return null;
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group/branch rounded-2xl"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-xl px-2 py-2 transition hover:bg-muted/55">
        <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${icon}`}>
          <Icon size={14} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 text-sm font-medium">{t(`pet.work.branch.${group}`)}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums ${count}`}
        >
          {items.length}
        </span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className="text-muted-foreground transition-transform group-open/branch:rotate-180"
        />
      </summary>
      <ul className="space-y-1 px-1 pb-2 pt-0.5">
        {items.map((item) => {
          const navigationDisabled = Boolean(item.external && !item.navigation.external);
          return (
            <li key={item.id}>
              <div className="group/item flex min-w-0 items-start rounded-xl border border-transparent bg-background/45 transition hover:border-border/65 hover:bg-background hover:shadow-sm">
                <button
                  type="button"
                  data-pet-work-open={item.id}
                  disabled={navigationDisabled}
                  title={navigationDisabled ? t("pet.work.externalUnavailable") : undefined}
                  className="flex min-w-0 flex-1 items-start gap-2.5 rounded-l-xl px-3 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => !navigationDisabled && onOpen?.(item)}
                >
                  <span className="relative mt-1.5 flex h-2.5 w-2.5 shrink-0 items-center justify-center">
                    <span
                      className={`h-2 w-2 rounded-full ${STATE_DOT[item.state]}`}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-start gap-2">
                      <span
                        className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                        title={item.title}
                      >
                        {item.title}
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATE_BADGE[item.state]}`}
                      >
                        {t(`pet.work.state.${item.state}`)}
                      </span>
                      {item.external && (
                        <span className="shrink-0 rounded border border-border px-1 text-[10px] uppercase text-muted-foreground">
                          {item.external.cli}
                        </span>
                      )}
                      {item.risk && (
                        <span
                          className={`shrink-0 rounded px-1 text-[10px] ${RISK_TONE[item.risk.level]}`}
                        >
                          {t(`pet.session.risk.${item.risk.level}`)}
                          {item.risk.toolName ? ` · ${item.risk.toolName}` : ""}
                        </span>
                      )}
                    </span>
                    {item.detail && (
                      <span
                        className="mt-0.5 block truncate text-xs leading-5 text-muted-foreground"
                        title={item.detail}
                      >
                        {item.detail}
                      </span>
                    )}
                  </span>
                </button>
                {onDismiss && (
                  <button
                    type="button"
                    data-pet-work-dismiss={item.id}
                    aria-label={t("pet.work.dismissItemAria", { title: item.title })}
                    title={t("pet.work.dismissItemHint")}
                    className="mr-1 mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground/65 opacity-70 transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/item:opacity-100"
                    onClick={() => onDismiss(item)}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export function PetWorkTree({
  workMap,
  emptyState = "empty",
  defaultOpen = false,
  onOpen,
  onDismiss,
  onClearCompleted,
  onRestoreDismissed,
}: {
  workMap: PetWorkMap;
  emptyState?: PetSessionEmptyState;
  defaultOpen?: boolean;
  onOpen?: (item: PetWorkItem) => void;
  onDismiss?: (item: PetWorkItem) => void;
  onClearCompleted?: () => void;
  onRestoreDismissed?: () => void;
}) {
  const { t } = useT();
  const [drawerOpen, setDrawerOpen] = React.useState(defaultOpen);
  const drawerId = React.useId();
  React.useEffect(() => {
    if (defaultOpen) setDrawerOpen(true);
  }, [defaultOpen]);
  const hasVisibleWork = workMap.groups.length > 0;
  const visibleItemCount = workMap.groups.reduce(
    (count, group) =>
      count + group.buckets.reduce((bucketCount, bucket) => bucketCount + bucket.items.length, 0),
    0,
  );
  const drawerSubtitle =
    emptyState === "loading"
      ? t("pet.work.loading")
      : emptyState === "error" ||
          emptyState === "reconciling" ||
          emptyState === "disconnected" ||
          emptyState === "stale"
        ? t(`pet.session.empty.${emptyState}`)
        : hasVisibleWork
          ? t("pet.work.subtitle")
          : t("pet.work.empty");
  return (
    <section
      data-pet-work-tree="workspace-work-map"
      aria-labelledby="pet-work-tree-heading"
      className="rounded-2xl border border-border/60 bg-background/45 p-1"
    >
      <h3>
        <button
          type="button"
          data-pet-work-drawer="toggle"
          aria-expanded={drawerOpen}
          aria-controls={drawerId}
          className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left transition hover:bg-muted/55"
          onClick={() => setDrawerOpen((current) => !current)}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Inbox size={16} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span id="pet-work-tree-heading" className="block text-sm font-semibold tracking-tight">
              {t("pet.work.title")}
            </span>
            <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
              {drawerSubtitle}
            </span>
          </span>
          {visibleItemCount > 0 && (
            <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-semibold text-primary">
              {t("pet.work.workspaceItemCount", { count: visibleItemCount })}
            </span>
          )}
          <ChevronDown
            size={15}
            aria-hidden="true"
            className={`shrink-0 text-muted-foreground transition-transform ${drawerOpen ? "rotate-180" : ""}`}
          />
        </button>
      </h3>
      {drawerOpen && (
        <div id={drawerId} data-pet-work-drawer-content="open" className="px-1.5 pb-1.5 pt-2">
          {(workMap.counts.completed > 0 || workMap.dismissedCount > 0) &&
            emptyState !== "loading" && (
              <div className="mb-2 flex flex-wrap items-center justify-end gap-1 px-1">
                {workMap.counts.completed > 0 && onClearCompleted && (
                  <button
                    type="button"
                    data-pet-work-clear="completed"
                    title={t("pet.work.clearCompletedHint")}
                    className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    onClick={onClearCompleted}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                    {t("pet.work.clearCompleted")}
                  </button>
                )}
                {workMap.dismissedCount > 0 && onRestoreDismissed && (
                  <button
                    type="button"
                    data-pet-work-restore="dismissed"
                    className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    onClick={onRestoreDismissed}
                  >
                    <RotateCcw size={13} aria-hidden="true" />
                    {t("pet.work.restoreDismissed", { count: workMap.dismissedCount })}
                  </button>
                )}
              </div>
            )}
          {emptyState === "loading" ? (
            <div
              className="space-y-3 rounded-2xl border border-border/55 bg-background/55 p-4"
              role="status"
              aria-label={t("pet.work.loading")}
            >
              <span className="block h-4 w-2/3 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
              <span className="block h-4 w-1/2 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
              <span className="block h-16 w-full animate-pulse rounded-xl bg-muted/75 motion-reduce:animate-none" />
            </div>
          ) : hasVisibleWork ? (
            <ul className="space-y-3">
              {workMap.groups.map((group) => {
                const itemCount = group.buckets.reduce(
                  (count, bucket) => count + bucket.items.length,
                  0,
                );
                return (
                  <li
                    key={group.workspace ?? "__unassigned__"}
                    className="rounded-2xl border border-border/60 bg-background/55 p-2 shadow-[0_1px_2px_hsl(var(--cs-foreground)/0.035)]"
                  >
                    <div className="flex items-center gap-3 px-2 py-2">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <FolderKanban size={17} aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                        {group.workspace ?? t("pet.work.unassignedWorkspace")}
                      </span>
                      <span className="rounded-full bg-muted px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
                        {t("pet.work.workspaceItemCount", { count: itemCount })}
                      </span>
                    </div>
                    <div className="space-y-0.5">
                      {group.buckets.map((bucket) => (
                        <WorkBranch
                          key={bucket.group}
                          group={bucket.group}
                          items={bucket.items}
                          onOpen={onOpen}
                          onDismiss={onDismiss}
                        />
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div
              className="flex min-h-36 flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 bg-background/40 px-6 text-center"
              role="status"
            >
              <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <Inbox size={20} aria-hidden="true" />
              </span>
              <p className="max-w-sm text-sm leading-6 text-muted-foreground">{drawerSubtitle}</p>
            </div>
          )}
          {workMap.hiddenCount > 0 && emptyState !== "loading" && (
            <div className="mt-3 rounded-xl bg-muted/45 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
              <p>{t("pet.work.hidden", { count: workMap.hiddenCount })}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
