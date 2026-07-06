import React, { useEffect, useRef, useState } from "react";
import { FolderTree, Globe, GitCompare, SquareTerminal, X, Plus, Maximize2, Minimize2, ServerCog, Bot } from "lucide-react";
import type { PanelTab } from "../view";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { FilesPanel } from "./FilesPanel";
import { BrowserPanel } from "./BrowserPanel";
import type { Anchor } from "../chat/anchors";
import { ReviewPanel } from "./ReviewPanel";
import { TerminalPanel } from "./TerminalPanel";
import { BackgroundShellPanel } from "./BackgroundShellPanel";
import { CCRoomView } from "../cc-room/CCRoomView";
import { useT, type TFunction } from "../i18n/I18nProvider";

export interface OpenTab {
  id: string;
  kind: PanelTab;
}

/** Session-scoped panel context captured per bucket so a kept-mounted hidden
 *  bucket renders against ITS session's cwd/diff/anchors, not the live one. */
interface BucketCtx {
  cwd: string | null;
  repoId: string | null;
  reviewFiles?: string[];
  reviewDiff?: string;
  engineSessionId?: string | null;
  browserAnchors?: Anchor[];
}

/** Monotonic tab-id counter; module-level so ids stay unique across remounts. */
let panelTabSeq = 0;

interface Props {
  cwd: string | null;
  repoId: string | null;
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
  /** Bucket that the controlled tabs/activeId currently belong to. */
  tabsBucket?: string;
  /** Controlled active tab id. */
  activeId: string | null;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
  /**
   * The active session bucket (repo+session key). Panel BODIES for every bucket
   * the user has visited stay MOUNTED (hidden via display:none when not the
   * active bucket) so switching sessions and back keeps each session's browser
   * <webview> / terminal pty / etc. alive instead of tearing them down. The tab
   * strip and all tab mutations operate on the active bucket's `tabs` only.
   */
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
}

const KINDS: { kind: PanelTab; Icon: typeof FolderTree }[] = [
  { kind: "files", Icon: FolderTree },
  { kind: "browser", Icon: Globe },
  { kind: "review", Icon: GitCompare },
  { kind: "terminal", Icon: SquareTerminal },
  { kind: "shells", Icon: ServerCog },
  { kind: "ccRoom", Icon: Bot },
];

const META: Record<PanelTab, { Icon: typeof FolderTree }> = {
  files: { Icon: FolderTree },
  browser: { Icon: Globe },
  review: { Icon: GitCompare },
  terminal: { Icon: SquareTerminal },
  shells: { Icon: ServerCog },
  ccRoom: { Icon: Bot },
};

/** Translated label for a panel kind. */
function kindLabel(t: TFunction, kind: PanelTab): string {
  return t(`panels.kinds.${kind}`);
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
  cwd,
  repoId,
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
  engineSessionId,
  width,
  onResizeStart,
  onAttachImage,
  browserAnchors,
  onRemoveBrowserAnchor,
  onUpdateBrowserAnchor,
  tabs,
  setTabs,
  tabsBucket,
  activeId,
  setActiveId,
  bucket,
}: Props) {
  const { t } = useT();
  // Fresh, collision-proof tab id. The module counter resets to 0 on a renderer
  // reload, but tabs are PERSISTED per bucket — so a naive `${kind}-${++seq}`
  // re-mints ids that already exist on disk (e.g. ccRoom-1), producing duplicate
  // React keys across buckets ("two children with the same key `ccRoom-1`").
  // Guard by bumping the counter past the highest suffix already in use for this
  // kind across EVERY mounted bucket + the active tab list before minting.
  const mkId = (kind: PanelTab): string => {
    const existing: OpenTab[] = [...tabs];
    for (const { tabs: bTabs } of mountedByBucket.current.values()) existing.push(...bTabs);
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

  // Keep panel BODIES mounted across session switches. `mountedByBucket` snaps
  // the active bucket's tabs AND its session-scoped context (cwd/repoId/review
  // files+diff/engineSessionId/anchors) every render; buckets the user has
  // visited stay in the map (their Slots keep rendering, hidden) so a browser/
  // terminal/review for session A survives while session B is on screen — switch
  // back and it's exactly as left. Crucially each bucket renders with ITS OWN
  // captured context, not the live active session's — otherwise a hidden review/
  // files panel would re-render against the wrong cwd/diff and lose its git
  // state. A bucket whose tabs go empty is dropped (panels closed) so we don't
  // leak mounted webviews/ptys.
  const mountedByBucket = useRef<Map<string, { tabs: OpenTab[]; activeId: string | null; ctx: BucketCtx }>>(new Map());
  const ownerBucket = tabsBucket ?? bucket;
  if (ownerBucket === bucket && tabs.length > 0) {
    // Dedup by id defensively: state persisted before the mkId-collision fix can
    // still carry duplicate ids (e.g. two ccRoom-1), which would crash React with
    // "two children with the same key". Keep the first of each id.
    const seen = new Set<string>();
    const dedupedTabs = tabs.filter((tb) => (seen.has(tb.id) ? false : (seen.add(tb.id), true)));
    const snapshotActiveId =
      activeId && dedupedTabs.some((tb) => tb.id === activeId)
        ? activeId
        : dedupedTabs[0]?.id ?? null;
    mountedByBucket.current.set(bucket, {
      tabs: dedupedTabs,
      activeId: snapshotActiveId,
      ctx: { cwd, repoId, reviewFiles, reviewDiff, engineSessionId, browserAnchors },
    });
  } else if (ownerBucket === bucket) {
    mountedByBucket.current.delete(bucket);
  }
  // The active bucket's deduped tabs — used by the tab strip so it can't render
  // duplicate keys either.
  const activeSnapshot = mountedByBucket.current.get(bucket);
  const activeTabs = activeSnapshot?.tabs ?? (ownerBucket === bucket ? tabs : []);
  const candidateActiveId = ownerBucket === bucket ? activeId : activeSnapshot?.activeId ?? activeId;
  const visibleActiveId =
    candidateActiveId && activeTabs.some((tb) => tb.id === candidateActiveId)
      ? candidateActiveId
      : activeTabs[0]?.id ?? null;

  // Maximized = overlay the chat column (incl. composer) for more room (TODO
  // 2.4). Resets each open (local) — chat/composer state lives in App.
  const [maximized, setMaximized] = useState(false);

  const addTab = (kind: PanelTab): void => {
    const tab = { id: mkId(kind), kind };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  };

  const closeTab = (id: string): void => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        onClose(); // closing the last tab closes the dock
        return next;
      }
      if (id === visibleActiveId) {
        // Activate the neighbour (prefer the one to the left).
        setActiveId(next[Math.max(0, idx - 1)].id);
      }
      return next;
    });
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
        : { position: "absolute", top: 0, right: 0, bottom: 0, width, opacity: 0, pointerEvents: "none" }
      : { display: "none" }
    : maximized
      ? undefined
      : { width };

  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-col bg-background",
        maximized
          ? "absolute inset-0 z-30 shrink"
          : "shrink-0 border-l border-border",
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
          const { Icon } = META[tab.kind];
          const label = kindLabel(t, tab.kind);
          const active = tab.id === visibleActiveId;
          return (
            <div
              key={tab.id}
              className={cn(
                "group flex shrink-0 items-center gap-1.5 rounded-md py-1 pl-2.5 pr-1.5 text-xs font-medium transition-colors",
                active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              <Button type="button" variant="ghost" className="h-auto gap-1.5 p-0 hover:bg-transparent" onClick={() => setActiveId(tab.id)}>
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
            {KINDS.map(({ kind, Icon }) => (
              <DropdownMenuItem key={kind} onSelect={() => addTab(kind)}>
                <Icon className="mr-2 h-4 w-4" />
                <span className="flex-1">{kindLabel(t, kind)}</span>
              </DropdownMenuItem>
            ))}
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

      {/* Bodies. We render the panels of EVERY visited bucket (keyed
          bucket:id), but only the ACTIVE bucket's active tab is visible — the
          rest are display:none but stay mounted, so a session's browser/terminal
          survives a switch away and back. The empty-dock landing shows only for
          the active bucket when it has no tabs. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {tabs.length === 0 && <PanelLanding onPick={addTab} />}
        {[...mountedByBucket.current.entries()].flatMap(([b, { tabs: bTabs, ctx }]) =>
          bTabs.map((t) => {
            const onActiveBucket = b === bucket;
            // Each bucket renders with ITS captured session context. Only the
            // ACTIVE bucket also gets the live transient/nonce props (revealFile/
            // openUrl) — those target the session the user is driving now.
            return (
              <Slot key={`${b}:${t.id}`} active={onActiveBucket && t.id === visibleActiveId}>
                {/* A panel body is live when the dock is open and this is the
                    active bucket/tab. A full-page non-chat view may visually
                    hide the dock without closing it; keepActiveBodyLive keeps
                    BrowserPanel from idle-evicting that still-open page. */}
                <PanelBody
                  tab={t}
                  bucket={b}
                  visible={(!hidden || keepActiveBodyLive) && onActiveBucket && t.id === visibleActiveId}
                  cwd={ctx.cwd}
                  repoId={ctx.repoId}
                  reviewFiles={ctx.reviewFiles}
                  reviewDiff={ctx.reviewDiff}
                  engineSessionId={ctx.engineSessionId}
                  browserAnchors={ctx.browserAnchors}
                  revealFile={onActiveBucket ? revealFile : undefined}
                  onRevealConsumed={onActiveBucket ? onRevealConsumed : undefined}
                  openUrl={onActiveBucket ? openUrl : undefined}
                  onAttachImage={onAttachImage}
                  onRemoveBrowserAnchor={onRemoveBrowserAnchor}
                  onUpdateBrowserAnchor={onUpdateBrowserAnchor}
                />
              </Slot>
            );
          }),
        )}
      </div>
    </div>
  );
}

/** Empty-dock landing: a card grid to open one of the four panels. */
function PanelLanding({ onPick }: { onPick: (k: PanelTab) => void }) {
  const { t } = useT();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="grid w-full max-w-md grid-cols-2 gap-3">
        {KINDS.map(({ kind, Icon }) => (
          <Button
            key={kind}
            type="button"
            onClick={() => onPick(kind)}
            variant="outline"
            className="flex h-auto flex-col items-center gap-2 rounded-lg bg-card px-4 py-6 text-center hover:border-primary/50"
          >
            <Icon className="h-7 w-7 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">{kindLabel(t, kind)}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}

function PanelBody({
  tab,
  bucket,
  visible,
  cwd,
  repoId,
  reviewFiles,
  reviewDiff,
  revealFile,
  onRevealConsumed,
  openUrl,
  engineSessionId,
  onAttachImage,
  browserAnchors,
  onRemoveBrowserAnchor,
  onUpdateBrowserAnchor,
}: {
  tab: OpenTab;
  bucket: string;
  visible: boolean;
  cwd: string | null;
  repoId: string | null;
  reviewFiles?: string[];
  reviewDiff?: string;
  revealFile?: { path: string; cwd: string | null; nonce: number; consumed?: boolean };
  onRevealConsumed?: (nonce: number) => void;
  openUrl?: { url: string; nonce: number };
  engineSessionId?: string | null;
  onAttachImage?: (absPath: string) => void;
  browserAnchors?: Anchor[];
  onRemoveBrowserAnchor?: (anchorId: string) => void;
  onUpdateBrowserAnchor?: (anchorId: string, comment: string) => void;
}) {
  switch (tab.kind) {
    case "files":
      return <FilesPanel cwd={cwd} onAttachImage={onAttachImage} revealFile={revealFile} onRevealConsumed={onRevealConsumed} />;
    case "browser":
      // Per-bucket partition so each chat session's browser is storage/page
      // isolated (bucket = `${repoKey}::${sessionId}`). Sanitize to the chars
      // Electron allows in a partition name (the bucket has `::`, which is fine,
      // but be defensive about anything exotic).
      return <BrowserPanel cwd={cwd} visible={visible} openUrl={openUrl} anchors={browserAnchors} onRemoveAnchor={onRemoveBrowserAnchor} onUpdateAnchor={onUpdateBrowserAnchor} partition={`persist:browser:${bucket.replace(/[^a-zA-Z0-9_:.@-]/g, "_")}`} />;
    case "review":
      return <ReviewPanel cwd={cwd} files={reviewFiles} turnDiff={reviewDiff} />;
    case "terminal":
      // Per-tab session id so multiple terminals are independent shells.
      return <TerminalPanel cwd={cwd} sessionId={`term:${repoId ?? "no-repo"}:${tab.id}`} />;
    case "shells":
      return <BackgroundShellPanel sessionId={engineSessionId ?? null} />;
    case "ccRoom":
      return <CCRoomView cwd={cwd} />;
  }
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
