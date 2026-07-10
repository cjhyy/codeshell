import React, { useEffect, useRef, useState } from "react";
import { X, Plus, Maximize2, Minimize2 } from "lucide-react";
import type { PanelTab } from "../view";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import type { Anchor } from "../chat/anchors";
import { useT } from "../i18n/I18nProvider";
import { resolvePanelVisibility } from "./panelVisibility";
import {
  getEnabledPanelEntries,
  getPanelEntry,
  type PanelAvailabilityContext,
} from "./PanelRegistry";
import { usePanelWorkspaceRoot } from "./usePanelWorkspaceRoot";
import type { OpenCliSessionRequest } from "../cc-room/types";

export interface OpenTab {
  id: string;
  kind: PanelTab;
}

/** Monotonic tab-id counter; module-level so ids stay unique across remounts. */
let panelTabSeq = 0;

interface Props {
  /** Registered repository root used only as the main-workspace fallback. */
  repoPath: string | null;
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
  /** Parent-owned one-shot consumption for DriveAgent deep-link requests. */
  onOpenCliSessionConsumed?: (nonce: number) => void;
  /** Active engine sessionId — the background-shell panel queries shells by it (TODO 3.2). */
  engineSessionId?: string | null;
  /** Controlled dock width (px). The divider on the left edge resizes it. */
  width: number;
  /** Drag the divider: report the new width (parent clamps + persists). */
  onResizeStart: (startX: number, startWidth: number) => void;
  /** Attach an on-disk image to the composer by absolute path (TODO 2.1). */
  onAttachImage?: (absPath: string) => void;
  /** Active session's browser anchors — echoed by the browser panel (圈选统一). */
  browserAnchors?: Anchor[];
  /** Remove a browser anchor (and its composer chip) by id. */
  onRemoveBrowserAnchor?: (anchorId: string) => void;
  /** Update a browser anchor's comment by id. */
  onUpdateBrowserAnchor?: (anchorId: string, comment: string) => void;
  /** Render an isolated quick-chat tab body owned by this panel bucket. */
  renderQuickChatPanel?: (args: {
    ownerBucket: string;
    tabId: string;
    cwd: string | null;
  }) => React.ReactNode;
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
export function PanelArea({
  repoPath,
  hidden = false,
  keepActiveBodyLive = false,
  onClose,
  requestNonce,
  requestKind,
  reviewFiles,
  reviewDiff,
  revealFile,
  onRevealConsumed,
  openUrl,
  openCliSession,
  onOpenCliSessionConsumed,
  engineSessionId,
  width,
  onResizeStart,
  onAttachImage,
  browserAnchors,
  onRemoveBrowserAnchor,
  onUpdateBrowserAnchor,
  renderQuickChatPanel,
  tabs,
  setTabs,
  activeId,
  setActiveId,
  bucket,
}: Props) {
  const { t } = useT();
  const workspace = usePanelWorkspaceRoot(engineSessionId ?? null, repoPath);
  const cwd = workspace.root;
  const panelAvailability: PanelAvailabilityContext = {
    cwd,
    engineSessionId: engineSessionId ?? null,
  };
  const enabledPanels = getEnabledPanelEntries(panelAvailability);
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
  const activeTabs = tabs.filter((tb) =>
    seenTabIds.has(tb.id) ? false : (seenTabIds.add(tb.id), true),
  );
  const candidateActiveId = activeId;
  const visibleActiveId =
    candidateActiveId && activeTabs.some((tb) => tb.id === candidateActiveId)
      ? candidateActiveId
      : (activeTabs[0]?.id ?? null);

  // Maximized = overlay the chat column (incl. composer) for more room (TODO
  // 2.4). Resets each open (local) — chat/composer state lives in App.
  const [maximized, setMaximized] = useState(false);

  const addTab = (kind: PanelTab): void => {
    const tab = { id: mkId(kind), kind };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  };

  const closeTab = (id: string): void => {
    const idx = activeTabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
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
    openedNonce.current = requestNonce;
    // null kind = open the dock on the card landing without creating a tab.
    if (requestKind === null) return;
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
  }, [requestNonce, requestKind]);

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
            opacity: 0,
            pointerEvents: "none",
          }
      : { display: "none" }
    : maximized
      ? undefined
      : { width };

  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-col bg-background",
        maximized ? "absolute inset-0 z-30 shrink" : "shrink-0 border-l border-border",
      )}
      // Closed docks use display:none so BrowserPanel may idle-evict. Temporary
      // full-page views keep the dock invisible but laid out enough for webview
      // guests to stay alive instead of returning blank after display:none.
      style={panelStyle}
      aria-hidden={hidden || undefined}
    >
      {/* Drag handle on the left edge to resize the dock — hidden when maximized. */}
      {!maximized && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("panels.area.resizeWidth")}
          onMouseDown={(e) => {
            e.preventDefault();
            onResizeStart(e.clientX, width);
          }}
          className="absolute left-0 top-0 z-20 h-full w-1 -translate-x-1/2 cursor-col-resize hover:bg-primary/40"
        />
      )}
      {/* Tab strip */}
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-1.5 py-1">
        {activeTabs.map((tab) => {
          const entry = getPanelEntry(tab.kind);
          const Icon = entry.icon;
          const label = t(entry.label);
          const active = tab.id === visibleActiveId;
          return (
            <div
              key={tab.id}
              className={cn(
                "group flex shrink-0 items-center gap-1.5 rounded-md py-1 pl-2.5 pr-1.5 text-xs font-medium transition-colors",
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              <Button
                type="button"
                variant="ghost"
                className="h-auto gap-1.5 p-0 hover:bg-transparent"
                onClick={() => setActiveId(tab.id)}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </Button>
              <Button
                type="button"
                aria-label={t("panels.common.closeTab")}
                variant="ghost"
                size="icon"
                className="h-5 w-5 opacity-0 hover:bg-background/60 group-hover:opacity-100"
                onClick={() => closeTab(tab.id)}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          );
        })}

        {/* + menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              aria-label={t("panels.area.newTab")}
              size="icon"
              variant="ghost"
              className="ml-0.5 h-7 w-7 shrink-0 text-muted-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {enabledPanels.map((entry) => {
              const Icon = entry.icon;
              return (
                <DropdownMenuItem key={entry.key} onSelect={() => addTab(entry.key)}>
                  <Icon className="mr-2 h-4 w-4" />
                  <span className="flex-1">{t(entry.label)}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex-1" />
        <Button
          type="button"
          onClick={() => setMaximized((v) => !v)}
          aria-label={maximized ? t("panels.area.restore") : t("panels.area.maximize")}
          title={maximized ? t("panels.area.restoreTitle") : t("panels.area.maximizeTitle")}
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0 text-muted-foreground"
        >
          {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </Button>
        {/* No close-whole-panel ✕ — close tabs to close the dock (the last tab
            closing calls onClose). Keeps one consistent "close" affordance. */}
      </div>

      {/* Bodies. This PanelArea belongs to exactly one session bucket. App keeps
          one mounted PanelArea per bucket, so no body here ever changes owner
          during a session switch. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {activeTabs.length === 0 && <PanelLanding entries={enabledPanels} onPick={addTab} />}
        {activeTabs.map((panelTab) => {
          const activeTab = panelTab.id === visibleActiveId;
          const visibility = resolvePanelVisibility({ hidden, keepActiveBodyLive, activeTab });
          return (
            <Slot key={panelTab.id} active={activeTab}>
              {!workspace.ready && !cwd ? (
                <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
                  {t("panels.common.loading")}
                </div>
              ) : (
                <PanelBody
                  tab={panelTab}
                  bucket={bucket}
                  visible={visibility.lifecycleVisible}
                  foregroundVisible={visibility.foregroundVisible}
                  cwd={cwd}
                  reviewFiles={reviewFiles}
                  reviewDiff={reviewDiff}
                  engineSessionId={engineSessionId}
                  browserAnchors={browserAnchors}
                  revealFile={revealFile}
                  onRevealConsumed={onRevealConsumed}
                  openUrl={openUrl}
                  openCliSession={openCliSession}
                  onOpenCliSessionConsumed={onOpenCliSessionConsumed}
                  onAttachImage={onAttachImage}
                  onRemoveBrowserAnchor={onRemoveBrowserAnchor}
                  onUpdateBrowserAnchor={onUpdateBrowserAnchor}
                  renderQuickChatPanel={renderQuickChatPanel}
                />
              )}
            </Slot>
          );
        })}
      </div>
    </div>
  );
}

/** Empty-dock landing: a card grid to open one of the registered panels. */
function PanelLanding({
  entries,
  onPick,
}: {
  entries: ReturnType<typeof getEnabledPanelEntries>;
  onPick: (k: PanelTab) => void;
}) {
  const { t } = useT();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="grid w-full max-w-md grid-cols-2 gap-3">
        {entries.map((entry) => {
          const Icon = entry.icon;
          return (
            <Button
              key={entry.key}
              type="button"
              onClick={() => onPick(entry.key)}
              variant="outline"
              className="flex h-auto flex-col items-center gap-2 rounded-lg bg-card px-4 py-6 text-center hover:border-primary/50"
            >
              <Icon className="h-7 w-7 text-muted-foreground" />
              <span className="text-sm font-medium text-foreground">{t(entry.label)}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function PanelBody({
  tab,
  bucket,
  visible,
  foregroundVisible,
  cwd,
  reviewFiles,
  reviewDiff,
  revealFile,
  onRevealConsumed,
  openUrl,
  openCliSession,
  onOpenCliSessionConsumed,
  engineSessionId,
  onAttachImage,
  browserAnchors,
  onRemoveBrowserAnchor,
  onUpdateBrowserAnchor,
  renderQuickChatPanel,
}: {
  tab: OpenTab;
  bucket: string;
  visible: boolean;
  foregroundVisible: boolean;
  cwd: string | null;
  reviewFiles?: string[];
  reviewDiff?: string;
  revealFile?: { path: string; cwd: string | null; nonce: number; consumed?: boolean };
  onRevealConsumed?: (nonce: number) => void;
  openUrl?: { url: string; nonce: number };
  openCliSession?: OpenCliSessionRequest;
  onOpenCliSessionConsumed?: (nonce: number) => void;
  engineSessionId?: string | null;
  onAttachImage?: (absPath: string) => void;
  browserAnchors?: Anchor[];
  onRemoveBrowserAnchor?: (anchorId: string) => void;
  onUpdateBrowserAnchor?: (anchorId: string, comment: string) => void;
  renderQuickChatPanel?: (args: {
    ownerBucket: string;
    tabId: string;
    cwd: string | null;
  }) => React.ReactNode;
}) {
  return getPanelEntry(tab.kind).render({
    tabId: tab.id,
    bucket,
    visible,
    foregroundVisible,
    cwd,
    reviewFiles,
    reviewDiff,
    revealFile,
    onRevealConsumed,
    openUrl,
    openCliSession,
    onOpenCliSessionConsumed,
    engineSessionId: engineSessionId ?? null,
    onAttachImage,
    browserAnchors,
    onRemoveBrowserAnchor,
    onUpdateBrowserAnchor,
    renderQuickChatPanel,
  });
}

/** A mounted-but-hideable container. Hidden panels keep their state/DOM. */
function Slot({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn("absolute inset-0 flex min-h-0 flex-col", active ? "z-10" : "-z-10 opacity-0")}
      aria-hidden={!active}
      style={active ? undefined : { pointerEvents: "none" }}
    >
      {children}
    </div>
  );
}
