import React, { useEffect, useRef, useState } from "react";
import { FolderTree, Globe, GitCompare, SquareTerminal, X, Plus, Maximize2, Minimize2, ServerCog, MessagesSquare } from "lucide-react";
import type { PanelTab } from "../view";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { FilesPanel } from "./FilesPanel";
import { BrowserPanel } from "./BrowserPanel";
import type { Anchor } from "../chat/anchors";
import { ReviewPanel } from "./ReviewPanel";
import { TerminalPanel } from "./TerminalPanel";
import { BackgroundShellPanel } from "./BackgroundShellPanel";
import { RoomsPanel } from "./RoomsPanel";

export interface OpenTab {
  id: string;
  kind: PanelTab;
}

/** Monotonic tab-id counter; module-level so ids stay unique across remounts. */
let panelTabSeq = 0;

interface Props {
  cwd: string | null;
  repoId: string | null;
  /** Called when the dock should close (last tab closed). */
  onClose: () => void;
  /** Controlled open tabs (owned by App so they survive a close→reopen). */
  tabs: OpenTab[];
  setTabs: React.Dispatch<React.SetStateAction<OpenTab[]>>;
  /** Controlled active tab id. */
  activeId: string | null;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
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

const KINDS: { kind: PanelTab; label: string; Icon: typeof FolderTree }[] = [
  { kind: "files", label: "文件", Icon: FolderTree },
  { kind: "browser", label: "浏览器", Icon: Globe },
  { kind: "review", label: "审查", Icon: GitCompare },
  { kind: "terminal", label: "终端", Icon: SquareTerminal },
  { kind: "shells", label: "后台 Shell", Icon: ServerCog },
  { kind: "rooms", label: "房间", Icon: MessagesSquare },
];

const META: Record<PanelTab, { label: string; Icon: typeof FolderTree }> = {
  files: { label: "文件", Icon: FolderTree },
  browser: { label: "浏览器", Icon: Globe },
  review: { label: "审查", Icon: GitCompare },
  terminal: { label: "终端", Icon: SquareTerminal },
  shells: { label: "后台 Shell", Icon: ServerCog },
  rooms: { label: "房间", Icon: MessagesSquare },
};

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
  onClose,
  requestNonce,
  requestKind,
  reviewFiles,
  reviewDiff,
  revealFile,
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
  activeId,
  setActiveId,
}: Props) {
  // Module-level id counter (not a per-mount ref) so ids stay unique across a
  // dock close→reopen — tabs live in App now and outlive this component.
  const mkId = (kind: PanelTab): string => `${kind}-${(panelTabSeq += 1)}`;

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
      if (id === activeId) {
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

  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-col bg-background",
        maximized
          ? "absolute inset-0 z-30 shrink"
          : "shrink-0 border-l border-border",
      )}
      style={maximized ? undefined : { width }}
    >
      {/* Drag handle on the left edge to resize the dock — hidden when maximized. */}
      {!maximized && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整面板宽度"
          onMouseDown={(e) => {
            e.preventDefault();
            onResizeStart(e.clientX, width);
          }}
          className="absolute left-0 top-0 z-20 h-full w-1 -translate-x-1/2 cursor-col-resize hover:bg-primary/40"
        />
      )}
      {/* Tab strip */}
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-1.5 py-1">
        {tabs.map((t) => {
          const { label, Icon } = META[t.kind];
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              className={cn(
                "group flex shrink-0 items-center gap-1.5 rounded-md py-1 pl-2.5 pr-1.5 text-xs font-medium transition-colors",
                active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              <button type="button" className="flex items-center gap-1.5" onClick={() => setActiveId(t.id)}>
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
              <button
                type="button"
                aria-label="关闭标签"
                className="rounded p-0.5 opacity-0 hover:bg-background/60 group-hover:opacity-100"
                onClick={() => closeTab(t.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}

        {/* + menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="新建标签"
              className="ml-0.5 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {KINDS.map(({ kind, label, Icon }) => (
              <DropdownMenuItem key={kind} onSelect={() => addTab(kind)}>
                <Icon className="mr-2 h-4 w-4" />
                <span className="flex-1">{label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setMaximized((v) => !v)}
          aria-label={maximized ? "还原面板" : "放大面板"}
          title={maximized ? "还原(覆盖输入区→停靠)" : "放大(覆盖输入区)"}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent"
        >
          {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
        {/* No close-whole-panel ✕ — close tabs to close the dock (the last tab
            closing calls onClose). Keeps one consistent "close" affordance. */}
      </div>

      {/* Bodies — all mounted, toggled via display. Empty dock shows the
          card landing so the user picks what to open. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {tabs.length === 0 ? (
          <PanelLanding onPick={addTab} />
        ) : (
          tabs.map((t) => (
            <Slot key={t.id} active={t.id === activeId}>
              <PanelBody tab={t} cwd={cwd} repoId={repoId} reviewFiles={reviewFiles} reviewDiff={reviewDiff} revealFile={revealFile} openUrl={openUrl} engineSessionId={engineSessionId} onAttachImage={onAttachImage} browserAnchors={browserAnchors} onRemoveBrowserAnchor={onRemoveBrowserAnchor} onUpdateBrowserAnchor={onUpdateBrowserAnchor} />
            </Slot>
          ))
        )}
      </div>
    </div>
  );
}

/** Empty-dock landing: a card grid to open one of the four panels. */
function PanelLanding({ onPick }: { onPick: (k: PanelTab) => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="grid w-full max-w-md grid-cols-2 gap-3">
        {KINDS.map(({ kind, label, Icon }) => (
          <button
            key={kind}
            type="button"
            onClick={() => onPick(kind)}
            className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card px-4 py-6 text-center transition-colors hover:border-primary/50 hover:bg-accent"
          >
            <Icon className="h-7 w-7 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PanelBody({
  tab,
  cwd,
  repoId,
  reviewFiles,
  reviewDiff,
  revealFile,
  openUrl,
  engineSessionId,
  onAttachImage,
  browserAnchors,
  onRemoveBrowserAnchor,
  onUpdateBrowserAnchor,
}: {
  tab: OpenTab;
  cwd: string | null;
  repoId: string | null;
  reviewFiles?: string[];
  reviewDiff?: string;
  revealFile?: { path: string; cwd: string | null; nonce: number; consumed?: boolean };
  openUrl?: { url: string; nonce: number };
  engineSessionId?: string | null;
  onAttachImage?: (absPath: string) => void;
  browserAnchors?: Anchor[];
  onRemoveBrowserAnchor?: (anchorId: string) => void;
  onUpdateBrowserAnchor?: (anchorId: string, comment: string) => void;
}) {
  switch (tab.kind) {
    case "files":
      return <FilesPanel cwd={cwd} onAttachImage={onAttachImage} revealFile={revealFile} />;
    case "browser":
      return <BrowserPanel cwd={cwd} openUrl={openUrl} anchors={browserAnchors} onRemoveAnchor={onRemoveBrowserAnchor} onUpdateAnchor={onUpdateBrowserAnchor} />;
    case "review":
      return <ReviewPanel cwd={cwd} files={reviewFiles} turnDiff={reviewDiff} />;
    case "terminal":
      // Per-tab session id so multiple terminals are independent shells.
      return <TerminalPanel cwd={cwd} sessionId={`term:${repoId ?? "no-repo"}:${tab.id}`} />;
    case "shells":
      return <BackgroundShellPanel sessionId={engineSessionId ?? null} />;
    case "rooms":
      return <RoomsPanel />;
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
