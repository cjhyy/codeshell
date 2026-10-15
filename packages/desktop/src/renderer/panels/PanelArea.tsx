import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  CircleOff,
  Plus,
  Maximize2,
  Minimize2,
  PanelsTopLeft,
  LoaderCircle,
  AppWindow,
  LayoutGrid,
} from "lucide-react";
import type { PanelTab } from "../view";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Anchor } from "../chat/anchors";
import { useT } from "../i18n/I18nProvider";
import { resolvePanelVisibility } from "./panelVisibility";
import {
  getEnabledPanelEntries,
  getPanelEntry,
  panelEntryTitle,
  PANEL_REGISTRY,
} from "./PanelRegistry";
import {
  PanelWorkspaceRootConsumer,
  panelWorkspacePresentation,
} from "./PanelWorkspaceRootConsumer";
import type { PanelWorkspaceState } from "./usePanelWorkspaceRoot";
import type { OpenCliSessionRequest } from "../cc-room/types";
import type { TrackedProject } from "../projects";
import {
  DesktopPanelLifecycleBoundary,
  type DesktopBuiltinPanelAppHost,
} from "./DesktopBuiltinPanelApp";
import { PanelTabStrip } from "./PanelTabStrip";
import { useReviewAvailability } from "./useReviewAvailability";
import type { SubagentSelection } from "../subagents/SubagentNavigation";
import { useToast } from "../ui/ToastProvider";
import type { PanelAppStateChange } from "./PanelAppHost";
import { PanelLauncher } from "./PanelLauncher";
import { PANEL_LAUNCHER_KIND } from "./panelLauncherKind";

export interface OpenTab {
  id: string;
  kind: PanelTab;
}

/** Monotonic tab-id counter; module-level so ids stay unique across remounts. */
let panelTabSeq = 0;

interface Props {
  /** Registered repository root used only as the main-workspace fallback. */
  projectPath: string | null;
  project?: TrackedProject | null;
  /**
   * When true the whole dock is visually hidden. Normal close uses display:none
   * so the dock occupies no width; keepActiveBodyLive uses an invisible absolute
   * box instead, avoiding display:none because Electron <webview> can blank
   * after an ancestor is removed from layout.
   */
  hidden?: boolean;
  /**
   * Keep the active panel body live for lifecycle decisions even while the dock
   * is visually hidden. Used when a full-page non-chat view (Extensions,
   * Settings-like surfaces) temporarily covers the chat area: the user did not
   * close the dock, so BrowserPanel should not start its idle-evict timer.
   */
  keepActiveBodyLive?: boolean;
  /** Called when the dock should close (last tab closed). */
  onClose: () => void;
  /** Restore keyboard focus to the host's dock toggle after closing the focused last tab. */
  onRestoreFocus?: () => void;
  /** Controlled open tabs (owned by App so they survive a close→reopen). */
  tabs: OpenTab[];
  setTabs: React.Dispatch<React.SetStateAction<OpenTab[]>>;
  /** Controlled active tab id. */
  activeId: string | null;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
  /** Owning session bucket (repo+session key). One PanelArea is mounted per bucket. */
  bucket: string;
  /**
   * Bumped by the parent to request opening a tab of `requestKind`. Every time
   * the nonce changes we open (or focus) a tab of that kind. This is the single
   * source for creating tabs, so opening the dock can't double-create.
   */
  requestNonce: number;
  /** Kind to open/focus; null opens the dock on the card landing (no tab). */
  requestKind: PanelTab | null;
  /** Files for a review tab to focus (from a chat "files changed" card). */
  reviewFiles?: string[];
  /** The originating turn's diff snapshot — survives later commits (TODO 2.3a). */
  reviewDiff?: string;
  /** File a chat path-link asked to reveal in the Files panel (nonce re-fires). */
  revealFile?: { path: string; cwd: string | null; nonce: number; consumed?: boolean };
  /** A Files panel reveals the requested file and reports the nonce back, so the
   *  parent marks it consumed (no timing race — see App.onRevealConsumed). */
  onRevealConsumed?: (nonce: number) => void;
  /** URL a chat http(s)-link asked the Browser panel to open (nonce re-fires). */
  openUrl?: { url: string; nonce: number };
  /** DriveAgent external CLI conversation to open directly. */
  openCliSession?: OpenCliSessionRequest;
  subagentSelection?: SubagentSelection;
  /** Parent-owned one-shot consumption for DriveAgent deep-link requests. */
  onOpenCliSessionConsumed?: (nonce: number) => void;
  /** Active engine sessionId — the background-shell panel queries shells by it (TODO 3.2). */
  engineSessionId?: string | null;
  /** Whether this panel bucket currently owns an in-flight top-level turn. */
  busy?: boolean;
  /** Session execution settings used by installed Panel Apps. */
  modelKey?: string | null;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "dontAsk";
  planMode?: boolean;
  hasGoal?: boolean;
  /** Controlled dock width (px). The divider on the left edge resizes it. */
  width: number;
  /** Drag the divider: report the new width (parent clamps + persists). */
  onResizeStart: (startX: number, startWidth: number, target: HTMLElement) => void;
  /** Attach an on-disk image to the composer by absolute path (TODO 2.1). */
  onAttachImage?: (absPath: string) => void;
  /** Active session's browser anchors — echoed by the browser panel (圈选统一). */
  browserAnchors?: Anchor[];
  /** Remove a browser anchor (and its composer chip) by id. */
  onRemoveBrowserAnchor?: (anchorId: string) => void;
  /** Update a browser anchor's comment by id. */
  onUpdateBrowserAnchor?: (anchorId: string, comment: string) => void;
  /** Trusted built-in Panel App services. Installed apps use their scoped bridge. */
  builtinPanelAppHost?: DesktopBuiltinPanelAppHost;
}

/**
 * The right-side panel dock with Codex-style dynamic tabs: a strip of open
 * tabs (each closable) plus a `+` menu to open a new one. The same kind can be
 * opened multiple times (e.g. two terminals) — each tab is its own instance
 * with its own state.
 *
 * All tabs stay MOUNTED (shown/hidden via CSS) so switching never tears down a
 * terminal's xterm or reloads a browser's <webview>.
 */
export function PanelArea(props: Props) {
  return (
    <PanelWorkspaceRootConsumer
      engineSessionId={props.engineSessionId ?? null}
      projectPath={props.projectPath}
    >
      {(workspace) => <ResolvedPanelArea {...props} workspace={workspace} />}
    </PanelWorkspaceRootConsumer>
  );
}

function ResolvedPanelArea({
  projectPath,
  project,
  hidden = false,
  keepActiveBodyLive = false,
  onClose,
  onRestoreFocus,
  requestNonce,
  requestKind,
  reviewFiles,
  reviewDiff,
  revealFile,
  onRevealConsumed,
  openUrl,
  openCliSession,
  subagentSelection,
  onOpenCliSessionConsumed,
  engineSessionId,
  busy = false,
  modelKey = null,
  permissionMode = "default",
  planMode = false,
  hasGoal = false,
  width,
  onResizeStart,
  onAttachImage,
  browserAnchors,
  onRemoveBrowserAnchor,
  onUpdateBrowserAnchor,
  builtinPanelAppHost,
  tabs,
  setTabs,
  activeId,
  setActiveId,
  bucket,
  workspace,
}: Props & { workspace: PanelWorkspaceState }) {
  const { t } = useT();
  const toast = useToast();
  const panelDomId = useId();
  const panelRegistryRevision = useSyncExternalStore(
    PANEL_REGISTRY.subscribe,
    PANEL_REGISTRY.snapshot,
    PANEL_REGISTRY.snapshot,
  );
  const cwd = workspace.root;
  const reviewAvailability = useReviewAvailability(
    engineSessionId ?? null,
    workspace.ready && cwd
      ? JSON.stringify([projectPath, workspace.mainRootId, cwd, project?.roots])
      : null,
    !hidden,
  );
  // A saved turn diff remains useful after a repository is removed. It may
  // open from its chat card, without exposing Git actions in the panel launcher.
  const hasReviewSnapshot = reviewDiff !== undefined;
  const enabledPanels = useMemo(
    () =>
      getEnabledPanelEntries({
        projectPath,
        cwd,
        engineSessionId: engineSessionId ?? null,
        sessionMainRootId: workspace.mainRootId,
        gitReviewAvailable: reviewAvailability.available,
      }),
    [
      cwd,
      engineSessionId,
      panelRegistryRevision,
      projectPath,
      workspace.mainRootId,
      reviewAvailability.available,
    ],
  );
  const enabledPanelIds = useMemo(
    () => new Set(enabledPanels.map((entry) => entry.key)),
    [enabledPanels],
  );
  const pickerPanels = useMemo(
    () => enabledPanels.filter((entry) => !entry.internalOnly),
    [enabledPanels],
  );
  // Fresh, collision-proof tab id. The module counter resets to 0 on a renderer
  // reload, but tabs are persisted per bucket; bump past ids already present in
  // this bucket so restored tabs and newly-opened tabs don't collide.
  const mkId = (kind: PanelTab): string => {
    const existing: OpenTab[] = [...tabs];
    const prefix = `${kind}-`;
    let max = panelTabSeq;
    for (const tb of existing) {
      if (tb.kind !== kind || !tb.id.startsWith(prefix)) continue;
      const n = Number(tb.id.slice(prefix.length));
      if (Number.isFinite(n) && n > max) max = n;
    }
    panelTabSeq = max + 1;
    return `${prefix}${panelTabSeq}`;
  };

  // Dedup defensively: persisted state from older builds can carry duplicate ids.
  const seenTabIds = new Set<string>();
  const activeTabs = tabs.filter((tb) => {
    if (
      (tb.kind !== PANEL_LAUNCHER_KIND &&
        !enabledPanelIds.has(tb.kind) &&
        !(tb.kind === "review" && hasReviewSnapshot)) ||
      seenTabIds.has(tb.id)
    )
      return false;
    seenTabIds.add(tb.id);
    return true;
  });
  const candidateActiveId = activeId;
  const visibleActiveId =
    candidateActiveId && activeTabs.some((tb) => tb.id === candidateActiveId)
      ? candidateActiveId
      : (activeTabs[0]?.id ?? null);
  const activeTab = activeTabs.find((tab) => tab.id === visibleActiveId);
  const pendingTabFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!hidden && pendingTabFocus.current === visibleActiveId) {
      document.getElementById(`${panelDomId}-tab-${visibleActiveId}`)?.focus();
      pendingTabFocus.current = null;
    }
  }, [hidden, panelDomId, visibleActiveId]);
  const activeEntry = activeTab
    ? getPanelEntry(activeTab.kind, {
        projectPath,
        cwd,
        engineSessionId: engineSessionId ?? null,
      })
    : undefined;
  const canOpenWindow = activeEntry?.owner.kind === "panel-app" && !activeEntry.internalOnly;
  const pendingWindows = useRef(
    new Map<string, { appDescriptorId: string; tabId: string; bucket: string; opening: boolean }>(),
  );
  const readyWindowTabs = useRef(new Set<string>());
  const sourceWindowErrors = useRef(new Map<string, string>());
  const [readyWindowTabIds, setReadyWindowTabIds] = useState<ReadonlySet<string>>(new Set());
  const [openingWindowTabIds, setOpeningWindowTabIds] = useState<ReadonlySet<string>>(new Set());
  const openingActiveWindow = Boolean(activeTab && openingWindowTabIds.has(activeTab.id));
  const activeWindowReady = Boolean(activeTab && readyWindowTabIds.has(activeTab.id));
  const finishWindowRequest = useCallback((tabId: string) => {
    pendingWindows.current.delete(tabId);
    setOpeningWindowTabIds(new Set(pendingWindows.current.keys()));
  }, []);
  const failWindowRequest = (tabId: string, detail: string) => {
    if (!pendingWindows.current.has(tabId)) return;
    finishWindowRequest(tabId);
    toast({ message: t("panels.area.openWindowFailed"), detail, variant: "error" });
  };
  const failWindowRequestRef = useRef(failWindowRequest);
  failWindowRequestRef.current = failWindowRequest;

  const openBoundWindow = async (tabId: string): Promise<void> => {
    const intent = pendingWindows.current.get(tabId);
    if (!intent || intent.opening || !readyWindowTabs.current.has(tabId)) return;
    intent.opening = true;
    try {
      await window.codeshell.openPanelAppWindow({
        appDescriptorId: intent.appDescriptorId,
        tabId,
        bucket: intent.bucket,
      });
    } catch (error) {
      if (pendingWindows.current.get(tabId) === intent)
        failWindowRequestRef.current(tabId, error instanceof Error ? error.message : String(error));
    } finally {
      if (pendingWindows.current.get(tabId) === intent) finishWindowRequest(tabId);
    }
  };
  const openBoundWindowRef = useRef(openBoundWindow);
  openBoundWindowRef.current = openBoundWindow;
  const onPanelAppStateChange = useCallback<PanelAppStateChange>((tabId, state, error) => {
    const wasReady = readyWindowTabs.current.has(tabId);
    if (state === "ready") {
      readyWindowTabs.current.add(tabId);
      sourceWindowErrors.current.delete(tabId);
    } else {
      readyWindowTabs.current.delete(tabId);
      // An error removes the guest view, whose cleanup can also report loading.
      // Keep its failure until a successful retry proves this source is ready.
      if (state === "error")
        sourceWindowErrors.current.set(tabId, error ?? "Panel App source failed to load.");
    }
    if (wasReady !== (state === "ready")) setReadyWindowTabIds(new Set(readyWindowTabs.current));
    if (state === "ready") void openBoundWindowRef.current(tabId);
    else if (state === "error")
      failWindowRequestRef.current(tabId, error ?? "Panel App source failed to load.");
  }, []);
  const requestWindow = (tab: OpenTab) => {
    if (pendingWindows.current.has(tab.id)) return;
    pendingWindows.current.set(tab.id, {
      appDescriptorId: tab.kind,
      tabId: tab.id,
      bucket,
      opening: false,
    });
    setOpeningWindowTabIds(new Set(pendingWindows.current.keys()));
    const sourceError = sourceWindowErrors.current.get(tab.id);
    if (sourceError) failWindowRequestRef.current(tab.id, sourceError);
    else void openBoundWindowRef.current(tab.id);
  };
  const openActiveWindow = () => {
    if (canOpenWindow && activeTab && readyWindowTabs.current.has(activeTab.id))
      requestWindow(activeTab);
  };
  const openingWindowKinds = new Set(
    [...pendingWindows.current.values()].map((intent) => intent.appDescriptorId),
  );
  useEffect(() => {
    const liveIds = new Set(activeTabs.map((tab) => tab.id));
    let changed = false;
    for (const id of pendingWindows.current.keys()) {
      if (!liveIds.has(id)) {
        pendingWindows.current.delete(id);
        changed = true;
      }
    }
    for (const id of sourceWindowErrors.current.keys())
      if (!liveIds.has(id)) sourceWindowErrors.current.delete(id);
    if (changed) setOpeningWindowTabIds(new Set(pendingWindows.current.keys()));
  }, [tabs, enabledPanelIds]);
  const sourceScope = JSON.stringify([bucket, projectPath, engineSessionId]);
  const sourceScopeRef = useRef(sourceScope);
  const sourceCwdRef = useRef(cwd);
  useEffect(() => {
    const rootChanged = sourceCwdRef.current !== null && sourceCwdRef.current !== cwd;
    sourceCwdRef.current = cwd;
    if (sourceScopeRef.current === sourceScope && !rootChanged) return;
    sourceScopeRef.current = sourceScope;
    pendingWindows.current.clear();
    readyWindowTabs.current.clear();
    sourceWindowErrors.current.clear();
    setOpeningWindowTabIds(new Set());
    setReadyWindowTabIds(new Set());
  }, [sourceScope, cwd]);
  useEffect(
    () => () => {
      pendingWindows.current.clear();
      readyWindowTabs.current.clear();
      sourceWindowErrors.current.clear();
    },
    [],
  );

  // Maximized = overlay the chat column (incl. composer) for more room (TODO
  // 2.4). Resets each open (local) — chat/composer state lives in App.
  const [maximized, setMaximized] = useState(false);
  const [launcherFocusRequest, setLauncherFocusRequest] = useState(0);

  const openLauncher = (): void => {
    setLauncherFocusRequest((request) => request + 1);
    const existing = activeTabs.find((tab) => tab.kind === PANEL_LAUNCHER_KIND);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const tab = { id: mkId(PANEL_LAUNCHER_KIND), kind: PANEL_LAUNCHER_KIND };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  };

  const addTab = (kind: PanelTab): void => {
    const entry = getPanelEntry(kind, {
      projectPath,
      cwd,
      engineSessionId: engineSessionId ?? null,
    });
    if (!entry || entry.internalOnly || !enabledPanelIds.has(kind)) return;
    const launcherId = activeTab?.kind === PANEL_LAUNCHER_KIND ? activeTab.id : null;
    if (entry.singleton) {
      const existing = activeTabs.find((candidate) => candidate.kind === kind);
      if (existing) {
        if (launcherId) setTabs((prev) => prev.filter((tab) => tab.id !== launcherId));
        pendingTabFocus.current = existing.id;
        setActiveId(existing.id);
        return;
      }
    }
    const tab = { id: mkId(kind), kind };
    pendingTabFocus.current = tab.id;
    setTabs((prev) =>
      launcherId
        ? prev.map((existing) => (existing.id === launcherId ? tab : existing))
        : [...prev, tab],
    );
    setActiveId(tab.id);
  };

  const openLauncherWindow = (kind: string): void => {
    const entry = getPanelEntry(kind, {
      projectPath,
      cwd,
      engineSessionId: engineSessionId ?? null,
    });
    if (
      !entry ||
      entry.owner.kind !== "panel-app" ||
      entry.internalOnly ||
      !enabledPanelIds.has(kind)
    )
      return;
    const pending = [...pendingWindows.current.values()].find(
      (intent) => intent.appDescriptorId === kind,
    );
    if (pending) {
      setActiveId(pending.tabId);
      return;
    }
    const existing = activeTabs.find((tab) => tab.kind === kind);
    const tab = existing ?? { id: mkId(kind), kind };
    requestWindow(tab);
    const launcherId = activeTab?.kind === PANEL_LAUNCHER_KIND ? activeTab.id : null;
    if (!existing) {
      setTabs((previous) =>
        launcherId
          ? previous.map((candidate) => (candidate.id === launcherId ? tab : candidate))
          : [...previous, tab],
      );
    } else if (launcherId)
      setTabs((previous) => previous.filter((candidate) => candidate.id !== launcherId));
    pendingTabFocus.current = tab.id;
    setActiveId(tab.id);
  };

  const closeTab = (id: string): void => {
    const idx = activeTabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    if (pendingWindows.current.has(id)) finishWindowRequest(id);
    readyWindowTabs.current.delete(id);
    sourceWindowErrors.current.delete(id);
    setReadyWindowTabIds(new Set(readyWindowTabs.current));
    const next = activeTabs.filter((t) => t.id !== id);
    setTabs((prev) => prev.filter((t) => t.id !== id));
    if (next.length === 0) {
      onClose(); // closing the last tab closes the dock
      return;
    }
    if (id === visibleActiveId) {
      // Activate the neighbour (prefer the one to the left).
      setActiveId(next[Math.max(0, idx - 1)].id);
    }
  };

  // Single source for opening tabs: react to each new request nonce. Focus an
  // existing tab of that kind if one exists, else open a new one.
  //
  // Dedupe carefully: StrictMode double-invokes BOTH the effect AND the
  // setState updater, so neither a ref-in-effect nor logic-in-updater alone is
  // safe. We compute the new tab id ONCE per nonce (memoized in a ref) so the
  // updater — however many times React calls it — always appends the same
  // object and yields one tab.
  // Open the requested kind once per nonce (including the mount-time nonce, so
  // the dock opens with exactly one tab). Focus an existing tab of that kind if
  // present, else append a new one. `openedNonce` starts at -1 so the very
  // first request is honored; the ref then dedupes StrictMode's double effect.
  const openedNonce = useRef<number>(-1);
  useEffect(() => {
    if (openedNonce.current === requestNonce) return;
    // null kind = open the dock on the card landing without creating a tab.
    if (requestKind === null) {
      openedNonce.current = requestNonce;
      return;
    }
    // A project-bound app registry arrives asynchronously. Do not consume the
    // open request until that project actually exposes the requested panel.
    if (!enabledPanelIds.has(requestKind) && !(requestKind === "review" && hasReviewSnapshot))
      return;
    openedNonce.current = requestNonce;
    const newTab: OpenTab = { id: mkId(requestKind), kind: requestKind };
    setTabs((prev) => {
      const existing = prev.find((t) => t.kind === requestKind);
      if (existing) {
        setActiveId(existing.id);
        return prev;
      }
      if (prev.some((t) => t.id === newTab.id)) return prev; // updater re-run guard
      setActiveId(newTab.id);
      return [...prev, newTab];
    });
  }, [enabledPanelIds, panelRegistryRevision, requestNonce, requestKind, hasReviewSnapshot]);

  const panelStyle: React.CSSProperties | undefined = hidden
    ? keepActiveBodyLive
      ? maximized
        ? { opacity: 0, pointerEvents: "none" }
        : {
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            width,
            maxWidth: "100%",
            opacity: 0,
            pointerEvents: "none",
          }
      : { display: "none" }
    : maximized
      ? undefined
      : { width, maxWidth: "100%" };

  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col",
        maximized ? "absolute inset-0 z-30 shrink" : "shrink-0 border-l border-border/70",
      )}
      // Closed docks use display:none so BrowserPanel may idle-evict. Temporary
      // full-page views keep the dock invisible but laid out enough for webview
      // guests to stay alive instead of returning blank after display:none.
      style={panelStyle}
      data-theme-surface="panel"
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      {/* Drag handle on the left edge to resize the dock — hidden when maximized. */}
      {!maximized && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("panels.area.resizeWidth")}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const target = e.currentTarget.parentElement;
            if (target) onResizeStart(e.clientX, width, target);
          }}
          className="absolute left-0 top-0 z-20 h-full w-1 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-primary/40"
        />
      )}
      {/* Tab strip */}
      <div className="flex h-[var(--cs-titlebar-height,2.75rem)] min-w-0 shrink-0 items-center gap-1 border-b border-border/70 bg-muted/35 px-1.5">
        {activeTabs.length > 0 ? (
          <PanelTabStrip
            tabs={activeTabs.map((tab) => {
              const entry = getPanelEntry(tab.kind, {
                projectPath,
                cwd,
                engineSessionId: engineSessionId ?? null,
              });
              return {
                id: tab.id,
                label:
                  tab.kind === PANEL_LAUNCHER_KIND
                    ? t("panels.area.launcherTitle")
                    : tab.kind === "subagent" && subagentSelection?.label
                      ? subagentSelection.label
                      : entry
                        ? panelEntryTitle(entry, (key) => t(key as never))
                        : t("panels.area.unavailable"),
                icon: tab.kind === PANEL_LAUNCHER_KIND ? LayoutGrid : (entry?.icon ?? CircleOff),
              };
            })}
            activeId={visibleActiveId}
            idPrefix={panelDomId}
            hidden={hidden}
            label={t("panels.area.tabsLabel")}
            closeLabel={t("panels.common.closeTab")}
            onActivate={setActiveId}
            onClose={closeTab}
            onRestoreFocus={hidden ? undefined : onRestoreFocus}
          />
        ) : (
          <div className="flex h-10 min-w-0 flex-1 items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
            <PanelsTopLeft className="size-3.5 shrink-0" />
            <span className="truncate">{t("panels.area.title")}</span>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-0.5 border-l border-border/70 pl-1.5">
          {/* Dock actions stay visible when the tab list overflows. */}
          <Button
            type="button"
            onClick={openLauncher}
            aria-label={t("panels.area.newTab")}
            title={t("panels.area.newTab")}
            data-panel-action="new-tab"
            size="icon"
            variant="ghost"
            className="size-8 shrink-0 rounded-lg text-muted-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          {canOpenWindow && (
            <Button
              type="button"
              onClick={() => void openActiveWindow()}
              disabled={openingActiveWindow || !activeWindowReady}
              aria-label={t("panels.area.openWindow")}
              title={
                activeWindowReady
                  ? t("panels.area.openWindow")
                  : t("panels.area.openWindowPreparing")
              }
              aria-busy={openingActiveWindow || undefined}
              data-panel-action="popout"
              size="sm"
              variant="ghost"
              className="h-8 shrink-0 gap-1.5 rounded-lg px-2 text-muted-foreground"
            >
              {openingActiveWindow ? (
                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <AppWindow className="size-4" />
              )}
              <span>{t("panels.area.openWindowShort")}</span>
            </Button>
          )}
          <Button
            type="button"
            onClick={() => setMaximized((v) => !v)}
            aria-label={maximized ? t("panels.area.restore") : t("panels.area.maximize")}
            title={maximized ? t("panels.area.restoreTitle") : t("panels.area.maximizeTitle")}
            aria-pressed={maximized}
            size="icon"
            variant="ghost"
            className="size-8 shrink-0 rounded-lg text-muted-foreground"
          >
            {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
          {/* No close-whole-panel ✕ — close tabs to close the dock (the last tab
            closing calls onClose). Keeps one consistent "close" affordance. */}
        </div>
      </div>

      {/* Bodies. This PanelArea belongs to exactly one session bucket. App keeps
          one mounted PanelArea per bucket, so no body here ever changes owner
          during a session switch. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {activeTabs.length === 0 && (
          <PanelLauncher
            entries={pickerPanels}
            onPick={addTab}
            onOpenWindow={openLauncherWindow}
            openingWindowKinds={openingWindowKinds}
            active={!hidden}
          />
        )}
        {activeTabs.map((panelTab) => {
          const activeTab = panelTab.id === visibleActiveId;
          if (panelTab.kind === PANEL_LAUNCHER_KIND) {
            return (
              <Slot
                key={panelTab.id}
                active={activeTab}
                panelId={PANEL_LAUNCHER_KIND}
                id={`${panelDomId}-body-${panelTab.id}`}
                labelledBy={`${panelDomId}-tab-${panelTab.id}`}
              >
                <PanelLauncher
                  entries={pickerPanels}
                  onPick={addTab}
                  onOpenWindow={openLauncherWindow}
                  openingWindowKinds={openingWindowKinds}
                  active={activeTab && !hidden}
                  focusRequest={launcherFocusRequest}
                />
              </Slot>
            );
          }
          const visibility = resolvePanelVisibility({ hidden, keepActiveBodyLive, activeTab });
          const workspacePresentation = panelWorkspacePresentation(workspace);
          return (
            <Slot
              key={panelTab.id}
              active={activeTab}
              panelId={panelTab.kind}
              id={`${panelDomId}-body-${panelTab.id}`}
              labelledBy={`${panelDomId}-tab-${panelTab.id}`}
            >
              <DesktopPanelLifecycleBoundary
                entry={getPanelEntry(panelTab.kind, {
                  projectPath,
                  cwd,
                  engineSessionId: engineSessionId ?? null,
                })}
                host={builtinPanelAppHost}
                tabId={panelTab.id}
                bucket={bucket}
                cwd={cwd}
                engineSessionId={engineSessionId ?? null}
                busy={busy}
                visible={visibility.lifecycleVisible}
              >
                {workspacePresentation.mountBody && (
                  <PanelBody
                    tab={panelTab}
                    bucket={bucket}
                    busy={busy}
                    visible={visibility.lifecycleVisible}
                    foregroundVisible={visibility.foregroundVisible}
                    projectPath={projectPath}
                    project={project}
                    cwd={cwd}
                    sessionMainRootId={workspace.mainRootId}
                    gitReviewAvailable={reviewAvailability.available}
                    reviewFiles={reviewFiles}
                    reviewDiff={reviewDiff}
                    engineSessionId={engineSessionId}
                    modelKey={modelKey}
                    permissionMode={permissionMode}
                    planMode={planMode}
                    hasGoal={hasGoal}
                    browserAnchors={browserAnchors}
                    revealFile={revealFile}
                    onRevealConsumed={onRevealConsumed}
                    openUrl={openUrl}
                    openCliSession={openCliSession}
                    subagentSelection={subagentSelection}
                    onOpenCliSessionConsumed={onOpenCliSessionConsumed}
                    onAttachImage={onAttachImage}
                    onRemoveBrowserAnchor={onRemoveBrowserAnchor}
                    onUpdateBrowserAnchor={onUpdateBrowserAnchor}
                    builtinPanelAppHost={builtinPanelAppHost}
                    onPanelAppStateChange={onPanelAppStateChange}
                  />
                )}
              </DesktopPanelLifecycleBoundary>
              {workspacePresentation.showLoading && (
                <div
                  role="status"
                  className="absolute inset-0 z-20 flex min-h-0 flex-1 items-center justify-center gap-2 bg-background text-sm text-muted-foreground"
                >
                  <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                  {t("panels.common.loading")}
                </div>
              )}
            </Slot>
          );
        })}
      </div>
    </div>
  );
}

function PanelBody({
  tab,
  bucket,
  busy,
  visible,
  foregroundVisible,
  projectPath,
  project,
  cwd,
  sessionMainRootId,
  gitReviewAvailable,
  reviewFiles,
  reviewDiff,
  revealFile,
  onRevealConsumed,
  openUrl,
  openCliSession,
  subagentSelection,
  onOpenCliSessionConsumed,
  engineSessionId,
  modelKey,
  permissionMode,
  planMode,
  hasGoal,
  onAttachImage,
  browserAnchors,
  onRemoveBrowserAnchor,
  onUpdateBrowserAnchor,
  builtinPanelAppHost,
  onPanelAppStateChange,
}: {
  tab: OpenTab;
  bucket: string;
  busy: boolean;
  visible: boolean;
  foregroundVisible: boolean;
  projectPath: string | null;
  project?: TrackedProject | null;
  cwd: string | null;
  sessionMainRootId?: string | null;
  gitReviewAvailable: boolean;
  reviewFiles?: string[];
  reviewDiff?: string;
  revealFile?: { path: string; cwd: string | null; nonce: number; consumed?: boolean };
  onRevealConsumed?: (nonce: number) => void;
  openUrl?: { url: string; nonce: number };
  openCliSession?: OpenCliSessionRequest;
  subagentSelection?: SubagentSelection;
  onOpenCliSessionConsumed?: (nonce: number) => void;
  engineSessionId?: string | null;
  modelKey: string | null;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "dontAsk";
  planMode: boolean;
  hasGoal: boolean;
  onAttachImage?: (absPath: string) => void;
  browserAnchors?: Anchor[];
  onRemoveBrowserAnchor?: (anchorId: string) => void;
  onUpdateBrowserAnchor?: (anchorId: string, comment: string) => void;
  builtinPanelAppHost?: DesktopBuiltinPanelAppHost;
  onPanelAppStateChange?: PanelAppStateChange;
}) {
  const entry = getPanelEntry(tab.kind, {
    projectPath,
    cwd,
    engineSessionId: engineSessionId ?? null,
  });
  if (!entry) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {"This panel is unavailable. Its Panel App may be disabled or uninstalled."}
      </div>
    );
  }
  return entry.render({
    tabId: tab.id,
    bucket,
    busy,
    visible,
    foregroundVisible,
    modelKey,
    permissionMode,
    planMode,
    hasGoal,
    projectPath,
    project,
    cwd,
    sessionMainRootId,
    gitReviewAvailable,
    reviewFiles,
    reviewDiff,
    revealFile,
    onRevealConsumed,
    openUrl,
    openCliSession,
    subagentSelection,
    onOpenCliSessionConsumed,
    engineSessionId: engineSessionId ?? null,
    onAttachImage,
    browserAnchors,
    onRemoveBrowserAnchor,
    onUpdateBrowserAnchor,
    builtinPanelAppHost,
    onPanelAppStateChange,
  });
}

/** A mounted-but-hideable container. Hidden panels keep their state/DOM. */
function Slot({
  active,
  children,
  panelId,
  id,
  labelledBy,
}: {
  active: boolean;
  children: React.ReactNode;
  panelId: PanelTab;
  id: string;
  labelledBy: string;
}) {
  return (
    <div
      role="tabpanel"
      id={id}
      aria-labelledby={labelledBy}
      className={cn("absolute inset-0 flex min-h-0 flex-col", active ? "z-10" : "-z-10 opacity-0")}
      aria-hidden={!active}
      inert={!active || undefined}
      data-panel-id={panelId}
      data-panel-active={active ? "true" : "false"}
      style={active ? undefined : { pointerEvents: "none" }}
    >
      {children}
    </div>
  );
}
