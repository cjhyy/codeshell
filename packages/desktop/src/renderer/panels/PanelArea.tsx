import React, { useEffect, useRef, useState } from "react";
import { FolderTree, Globe, GitCompare, SquareTerminal, X, Plus } from "lucide-react";
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
import { ReviewPanel } from "./ReviewPanel";
import { TerminalPanel } from "./TerminalPanel";

interface Props {
  cwd: string | null;
  repoId: string | null;
  onClose: () => void;
  /**
   * Bumped by the parent to request opening a tab of `requestKind`. Every time
   * the nonce changes we open (or focus) a tab of that kind. This is the single
   * source for creating tabs, so opening the dock can't double-create.
   */
  requestNonce: number;
  requestKind: PanelTab;
  /** Files for a review tab to focus (from a chat "files changed" card). */
  reviewFiles?: string[];
  /** Controlled dock width (px). The divider on the left edge resizes it. */
  width: number;
  /** Drag the divider: report the new width (parent clamps + persists). */
  onResizeStart: (startX: number, startWidth: number) => void;
}

interface OpenTab {
  id: string;
  kind: PanelTab;
}

const KINDS: { kind: PanelTab; label: string; Icon: typeof FolderTree; hint?: string }[] = [
  { kind: "files", label: "文件", Icon: FolderTree, hint: "⌘⇧E" },
  { kind: "browser", label: "浏览器", Icon: Globe, hint: "⌘T" },
  { kind: "review", label: "审查", Icon: GitCompare, hint: "⌃⇧G" },
  { kind: "terminal", label: "终端", Icon: SquareTerminal, hint: "⌃`" },
];

const META: Record<PanelTab, { label: string; Icon: typeof FolderTree }> = {
  files: { label: "文件", Icon: FolderTree },
  browser: { label: "浏览器", Icon: Globe },
  review: { label: "审查", Icon: GitCompare },
  terminal: { label: "终端", Icon: SquareTerminal },
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
  width,
  onResizeStart,
}: Props) {
  const seq = useRef(0);
  const mkId = (kind: PanelTab): string => `${kind}-${(seq.current += 1)}`;

  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

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
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-background"
      style={{ width }}
    >
      {/* Drag handle on the left edge to resize the dock. */}
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
            {KINDS.map(({ kind, label, Icon, hint }) => (
              <DropdownMenuItem key={kind} onSelect={() => addTab(kind)}>
                <Icon className="mr-2 h-4 w-4" />
                <span className="flex-1">{label}</span>
                {hint && <span className="ml-4 text-xs text-muted-foreground">{hint}</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭面板"
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Bodies — all mounted, toggled via display. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {tabs.map((t) => (
          <Slot key={t.id} active={t.id === activeId}>
            <PanelBody tab={t} cwd={cwd} repoId={repoId} reviewFiles={reviewFiles} />
          </Slot>
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
}: {
  tab: OpenTab;
  cwd: string | null;
  repoId: string | null;
  reviewFiles?: string[];
}) {
  switch (tab.kind) {
    case "files":
      return <FilesPanel cwd={cwd} />;
    case "browser":
      return <BrowserPanel cwd={cwd} />;
    case "review":
      return <ReviewPanel cwd={cwd} files={reviewFiles} />;
    case "terminal":
      // Per-tab session id so multiple terminals are independent shells.
      return <TerminalPanel cwd={cwd} sessionId={`term:${repoId ?? "no-repo"}:${tab.id}`} />;
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
