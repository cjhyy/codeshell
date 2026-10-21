import React from "react";
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  FolderKanban,
  Inbox,
  RotateCcw,
  Search,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { PetLatestSessionResult } from "../../preload/types";
import { useT } from "../i18n";
import type { PetSessionEmptyState } from "./SessionStatusSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  groupWorkItems,
  PET_WORK_BRANCH_ORDER,
  RISK_TONE,
  type PetWorkGroup,
  type PetWorkItem,
  type PetWorkMap,
  type PetWorkspaceWorkGroup,
} from "./petWorkMap";

const STATE_DOT: Record<PetWorkItem["state"], string> = {
  "needs-action": "bg-status-warn",
  running: "bg-status-running animate-pulse motion-reduce:animate-none",
  queued: "bg-status-running",
  failed: "bg-status-err",
  cancelled: "bg-muted-foreground",
  completed: "bg-status-ok",
  idle: "bg-muted-foreground",
};

const STATE_BADGE: Record<PetWorkItem["state"], string> = {
  "needs-action": "bg-status-warn/10 text-status-warn",
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

const countItems = (groups: readonly PetWorkspaceWorkGroup[]): number =>
  groups.reduce(
    (count, group) => count + group.buckets.reduce((sum, bucket) => sum + bucket.items.length, 0),
    0,
  );

type LatestResultState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; value: PetLatestSessionResult | null };

/**
 * One work-tree session row. Non-external rows carry an expand affordance
 * that lazily reads the session's latest assistant result (L2 disclosure)
 * over IPC; external-CLI transcripts are deliberately not copied, so external
 * rows get no affordance.
 */
function WorkTreeItem({
  item,
  onOpen,
  onDismiss,
  onArchive,
}: {
  item: PetWorkItem;
  onOpen?: (item: PetWorkItem) => void;
  onDismiss?: (item: PetWorkItem) => void;
  onArchive?: (item: PetWorkItem) => Promise<void>;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = React.useState(false);
  const [result, setResult] = React.useState<LatestResultState | null>(null);
  const [archiveBusy, setArchiveBusy] = React.useState(false);
  const [archiveError, setArchiveError] = React.useState(false);
  const fetchSeq = React.useRef(0);
  const panelId = React.useId();
  const navigationDisabled = Boolean(item.external && !item.navigation.external);
  const canExpand = !item.external;
  const canArchive =
    !item.external &&
    item.state !== "running" &&
    item.state !== "queued" &&
    item.state !== "needs-action";
  const archive = async (): Promise<void> => {
    if (!onArchive || archiveBusy) return;
    setArchiveBusy(true);
    setArchiveError(false);
    try {
      await onArchive(item);
    } catch {
      setArchiveError(true);
    } finally {
      setArchiveBusy(false);
    }
  };
  const toggleExpanded = () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    const read = window.codeshell.pet.getLatestResult;
    if (!read) {
      setResult({ status: "error" });
      return;
    }
    setResult({ status: "loading" });
    const seq = ++fetchSeq.current;
    void read(item.navigation.agentSessionId)
      .then((value) => {
        if (fetchSeq.current === seq) setResult({ status: "loaded", value });
      })
      .catch(() => {
        if (fetchSeq.current === seq) setResult({ status: "error" });
      });
  };
  return (
    <li data-pet-work-item={item.id}>
      <div className="group/item min-w-0 rounded-xl transition hover:bg-muted/55 focus-within:bg-muted/45">
        <div className="flex min-w-0 items-start">
          <button
            type="button"
            data-pet-work-open={item.id}
            disabled={navigationDisabled}
            title={navigationDisabled ? t("pet.work.externalUnavailable") : undefined}
            className="flex min-w-0 flex-1 items-start gap-2 rounded-xl px-2 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => !navigationDisabled && onOpen?.(item)}
          >
            <span className="relative mt-1.5 flex h-2.5 w-2.5 shrink-0 items-center justify-center">
              <span
                className={`h-2 w-2 rounded-full ${STATE_DOT[item.state]}`}
                aria-hidden="true"
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block min-w-0">
                <span
                  className="block line-clamp-2 break-words text-[13px] font-medium leading-5 text-foreground"
                  title={item.title}
                >
                  {item.title}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${STATE_BADGE[item.state]}`}
                  >
                    {t(`pet.work.state.${item.state}`)}
                  </span>
                  {item.external && (
                    <span className="rounded border border-border px-1 text-[10px] uppercase text-muted-foreground">
                      {item.external.cli}
                    </span>
                  )}
                  {item.risk && (
                    <span className={`rounded px-1 text-[10px] ${RISK_TONE[item.risk.level]}`}>
                      {t(`pet.session.risk.${item.risk.level}`)}
                      {item.risk.toolName ? ` · ${item.risk.toolName}` : ""}
                    </span>
                  )}
                </span>
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
          {canExpand && (
            <button
              type="button"
              data-pet-work-expand={item.id}
              aria-expanded={expanded}
              aria-controls={panelId}
              aria-label={t(
                expanded ? "pet.work.latestResultCollapseAria" : "pet.work.latestResultExpandAria",
                { title: item.title },
              )}
              className="mt-1 flex h-8 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              onClick={toggleExpanded}
            >
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={`transition-transform ${expanded ? "rotate-180" : ""}`}
              />
            </button>
          )}
          {canArchive && onArchive && (
            <button
              type="button"
              data-pet-work-archive={item.id}
              aria-label={t("pet.work.archiveSessionAria", { title: item.title })}
              title={
                archiveError ? t("pet.work.archiveSessionError") : t("pet.work.archiveSessionHint")
              }
              className={`mt-1 flex h-8 w-7 shrink-0 items-center justify-center rounded-lg transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 ${
                archiveError ? "text-status-err" : "text-muted-foreground/65"
              }`}
              disabled={archiveBusy}
              onClick={() => void archive()}
            >
              {archiveBusy ? (
                <span
                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
                  aria-hidden="true"
                />
              ) : (
                <Archive size={14} aria-hidden="true" />
              )}
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              data-pet-work-dismiss={item.id}
              aria-label={t("pet.work.dismissItemAria", { title: item.title })}
              title={t("pet.work.dismissItemHint")}
              className="mr-1 mt-1 flex h-8 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              onClick={() => onDismiss(item)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        {archiveError && (
          <p role="alert" className="px-3 pb-2 text-xs text-status-err">
            {t("pet.work.archiveSessionError")}
          </p>
        )}
        {canExpand && expanded && (
          <div
            id={panelId}
            data-pet-work-latest-result={item.id}
            className="mx-3 mb-2.5 max-h-48 overflow-y-auto rounded-md bg-muted/50 p-2"
          >
            {!result || result.status === "loading" ? (
              <p className="text-sm text-muted-foreground">{t("pet.work.latestResultLoading")}</p>
            ) : result.status === "error" ? (
              <p className="text-sm text-muted-foreground">{t("pet.work.latestResultError")}</p>
            ) : result.value ? (
              <>
                <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {result.value.text}
                </p>
                {result.value.truncated && (
                  <p className="mt-1 text-xs text-muted-foreground/80">
                    {t("pet.work.latestResultTruncated")}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t("pet.work.latestResultEmpty")}</p>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function WorkBranch({
  group,
  items,
  revealMatches = false,
  focusRequested = false,
  onOpen,
  onDismiss,
  onArchive,
}: {
  group: PetWorkGroup;
  items: readonly PetWorkItem[];
  revealMatches?: boolean;
  focusRequested?: boolean;
  onOpen?: (item: PetWorkItem) => void;
  onDismiss?: (item: PetWorkItem) => void;
  onArchive?: (item: PetWorkItem) => Promise<void>;
}) {
  const { t } = useT();
  const [open, setOpen] = React.useState(
    revealMatches || group === "pending" || group === "running",
  );
  React.useEffect(() => {
    if (revealMatches) setOpen(true);
  }, [revealMatches]);
  React.useEffect(() => {
    if (focusRequested) setOpen(true);
  }, [focusRequested]);
  const { Icon, icon, count } = BRANCH_META[group];
  if (items.length === 0) return null;
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      data-pet-work-branch={group}
      className="group/branch"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-1.5 py-2 outline-none transition hover:bg-muted/55 focus-visible:ring-2 focus-visible:ring-primary/30">
        <span className={`flex h-5 w-5 items-center justify-center rounded-md ${icon}`}>
          <Icon size={12} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 text-xs font-medium">{t(`pet.work.branch.${group}`)}</span>
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
      <ul className="divide-y divide-border/35 pb-2 pt-0.5">
        {items.map((item) => (
          <WorkTreeItem
            key={item.id}
            item={item}
            onOpen={onOpen}
            onDismiss={onDismiss}
            onArchive={onArchive}
          />
        ))}
      </ul>
    </details>
  );
}

export function PetWorkTree({
  workMap,
  emptyState = "empty",
  focusPending = false,
  onOpen,
  onDismiss,
  onArchive,
  onClearCompleted,
  onRestoreDismissed,
}: {
  workMap: PetWorkMap;
  emptyState?: PetSessionEmptyState;
  focusPending?: boolean;
  onOpen?: (item: PetWorkItem) => void;
  onDismiss?: (item: PetWorkItem) => void;
  onArchive?: (item: PetWorkItem) => Promise<void>;
  onClearCompleted?: () => void;
  onRestoreDismissed?: () => void;
}) {
  const { t } = useT();
  const [drawerOpen, setDrawerOpen] = React.useState(true);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<PetWorkGroup | "all">("all");
  const drawerId = React.useId();
  const headingId = React.useId();
  const searchRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (!focusPending) return;
    setDrawerOpen(true);
    setQuery("");
    setFilter("all");
  }, [focusPending]);
  const hasVisibleWork = workMap.groups.length > 0;
  const visibleItemCount = countItems(workMap.groups);
  const search = query.trim().toLocaleLowerCase();
  const filtered = search.length > 0 || filter !== "all";
  // Filters and search read every included item: the display-limited groups
  // omit older rows, which a filter must still be able to reach.
  const allItems = React.useMemo(
    () => workMap.allItems ?? workMap.groups.flatMap((g) => g.buckets.flatMap((b) => b.items)),
    [workMap],
  );
  const sourceGroups = React.useMemo(
    () => (filtered ? groupWorkItems(allItems) : workMap.groups),
    [filtered, allItems, workMap.groups],
  );
  const searching = search.length > 0;
  // Rebuilt when search starts or the items change, not on every keystroke.
  const searchText = React.useMemo(() => {
    if (!searching) return undefined;
    return new Map(
      allItems.map((item) => [
        item.id,
        [
          item.title,
          item.workspace ?? t("pet.work.unassignedWorkspace"),
          item.detail,
          t(`pet.work.state.${item.state}`),
          item.external?.cli,
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase(),
      ]),
    );
  }, [searching, allItems, t]);
  const filteredGroups = sourceGroups
    .map((group) => ({
      ...group,
      buckets: PET_WORK_BRANCH_ORDER.flatMap((kind) => {
        if (filter !== "all" && filter !== kind) return [];
        const bucket = group.buckets.find((candidate) => candidate.group === kind);
        if (!bucket) return [];
        const items = searchText
          ? bucket.items.filter((item) => searchText.get(item.id)?.includes(search))
          : bucket.items;
        return items.length > 0 ? [{ ...bucket, items }] : [];
      }),
    }))
    .filter((group) => group.buckets.length > 0);
  const matchingCount = countItems(filteredGroups);
  // Chip counts always cover all included work, so they do not jump between
  // the display-limited and full sets as a query is typed.
  const totalCount = PET_WORK_BRANCH_ORDER.reduce((sum, kind) => sum + workMap.counts[kind], 0);
  const resetFilters = (): void => {
    setQuery("");
    setFilter("all");
    searchRef.current?.focus();
  };
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
      aria-labelledby={headingId}
      className="min-w-0 rounded-2xl bg-background/45 p-1"
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
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Inbox size={15} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span id={headingId} className="block text-sm font-semibold tracking-tight">
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
        <div id={drawerId} data-pet-work-drawer-content="open" className="px-1.5 pb-1.5 pt-1">
          {hasVisibleWork && emptyState !== "loading" && (
            <div className="mb-3 space-y-2 px-1">
              <div className="flex items-center gap-2 rounded-lg border border-border/65 bg-background px-2.5 focus-within:border-primary/45 focus-within:ring-2 focus-within:ring-primary/10">
                <Search size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                <Input
                  ref={searchRef}
                  type="search"
                  value={query}
                  aria-label={t("pet.work.searchLabel")}
                  placeholder={t("pet.work.searchPlaceholder")}
                  data-pet-work-search="true"
                  className="h-9 min-w-0 flex-1 border-0 bg-transparent px-0 text-xs shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0 [&::-webkit-search-cancel-button]:appearance-none"
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("pet.work.clearSearch")}
                    className="h-7 w-7 shrink-0 text-muted-foreground [&_svg]:size-3"
                    onClick={() => {
                      setQuery("");
                      searchRef.current?.focus();
                    }}
                  >
                    <X aria-hidden="true" />
                  </Button>
                )}
              </div>
              <div
                role="group"
                aria-label={t("pet.work.filterLabel")}
                className="flex flex-wrap gap-1"
              >
                {(["all", ...PET_WORK_BRANCH_ORDER] as const).map((kind) => {
                  const count = kind === "all" ? totalCount : workMap.counts[kind];
                  // The active chip stays even at zero, so the user can see
                  // and leave the filter that emptied the list.
                  if (kind !== "all" && count === 0 && filter !== kind) return null;
                  return (
                    <Button
                      key={kind}
                      type="button"
                      variant="ghost"
                      data-pet-work-filter={kind}
                      aria-pressed={filter === kind}
                      className={cn(
                        "h-auto min-h-7 gap-1.5 rounded-md px-2 text-[11px] font-normal",
                        filter === kind
                          ? "bg-primary/10 font-medium text-primary hover:bg-primary/15 hover:text-primary"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                      onClick={() => setFilter(kind)}
                    >
                      {kind === "all" ? t("pet.work.filterAll") : t(`pet.work.branch.${kind}`)}
                      <span className="text-[10px] tabular-nums opacity-70">{count}</span>
                    </Button>
                  );
                })}
              </div>
              {filtered && (
                <p role="status" className="px-1 text-[11px] text-muted-foreground">
                  {t("pet.work.matchingCount", { count: matchingCount })}
                </p>
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
          ) : filteredGroups.length > 0 ? (
            <ul className="space-y-4">
              {filteredGroups.map((group) => {
                const itemCount = countItems([group]);
                return (
                  <li
                    key={group.workspace ?? "__unassigned__"}
                    className="min-w-0 border-t border-border/50 pt-2"
                  >
                    <div className="flex items-center gap-2 px-1.5 py-2">
                      <FolderKanban
                        size={13}
                        className="shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span
                        className="min-w-0 flex-1 truncate text-[11px] font-semibold text-muted-foreground"
                        title={group.workspace}
                      >
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
                          revealMatches={filtered}
                          focusRequested={focusPending && bucket.group === "pending"}
                          onOpen={onOpen}
                          onDismiss={onDismiss}
                          onArchive={onArchive}
                        />
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : hasVisibleWork && filtered ? (
            <div
              role="status"
              data-pet-work-no-matches="true"
              className="flex min-h-32 flex-col items-center justify-center gap-3 px-4 text-center"
            >
              <Search size={20} className="text-muted-foreground/55" aria-hidden="true" />
              <p className="text-xs text-muted-foreground">{t("pet.work.noMatches")}</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-pet-work-reset="true"
                className="h-auto px-2 py-1.5 text-xs text-primary hover:bg-primary/10 hover:text-primary"
                onClick={resetFilters}
              >
                {t("pet.work.resetFilters")}
              </Button>
            </div>
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
          {(workMap.counts.completed > 0 || workMap.dismissedCount > 0) &&
            emptyState !== "loading" && (
              <div className="mt-3 flex flex-wrap items-center justify-end gap-1 border-t border-border/40 pt-2">
                {workMap.counts.completed > 0 && onClearCompleted && (
                  <button
                    type="button"
                    data-pet-work-clear="completed"
                    title={t("pet.work.clearCompletedHint")}
                    className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    onClick={onClearCompleted}
                  >
                    <Trash2 size={12} aria-hidden="true" />
                    {t("pet.work.clearCompleted")}
                  </button>
                )}
                {workMap.dismissedCount > 0 && onRestoreDismissed && (
                  <button
                    type="button"
                    data-pet-work-restore="dismissed"
                    className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    onClick={onRestoreDismissed}
                  >
                    <RotateCcw size={12} aria-hidden="true" />
                    {t("pet.work.restoreDismissed", { count: workMap.dismissedCount })}
                  </button>
                )}
              </div>
            )}
          {workMap.hiddenCount > 0 && !search && emptyState !== "loading" && (
            <div className="mt-3 rounded-xl bg-muted/45 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
              <p>{t("pet.work.hidden", { count: workMap.hiddenCount })}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
