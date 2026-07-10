import { createElement, type ReactNode } from "react";
import {
  Bot,
  FolderTree,
  GitCompare,
  Globe,
  MessageCircle,
  ServerCog,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import type { PanelTab } from "../view";
import type { Anchor } from "../chat/anchors";
import { FilesPanel } from "./FilesPanel";
import { BrowserPanel } from "./BrowserPanel";
import { ReviewPanel } from "./ReviewPanel";
import { TerminalPanel } from "./TerminalPanel";
import { BackgroundShellPanel } from "./BackgroundShellPanel";
import { CCRoomView } from "../cc-room/CCRoomView";
import type { OpenCliSessionRequest } from "../cc-room/types";

export interface PanelAvailabilityContext {
  cwd: string | null;
  engineSessionId: string | null;
}

export interface PanelRenderContext extends PanelAvailabilityContext {
  tabId: string;
  bucket: string;
  /** Active for mounted-panel lifecycle work such as keeping a webview warm. */
  visible: boolean;
  /** Actually visible to the user; hidden session buckets must not own subscriptions. */
  foregroundVisible: boolean;
  reviewFiles?: string[];
  reviewDiff?: string;
  revealFile?: { path: string; cwd: string | null; nonce: number; consumed?: boolean };
  onRevealConsumed?: (nonce: number) => void;
  openUrl?: { url: string; nonce: number };
  openCliSession?: OpenCliSessionRequest;
  onAttachImage?: (absPath: string) => void;
  browserAnchors?: Anchor[];
  onRemoveBrowserAnchor?: (anchorId: string) => void;
  onUpdateBrowserAnchor?: (anchorId: string, comment: string) => void;
  renderQuickChatPanel?: (args: {
    ownerBucket: string;
    tabId: string;
    cwd: string | null;
  }) => ReactNode;
}

type PanelLabel<K extends PanelTab> = `panels.kinds.${K}`;

export interface PanelEntry<K extends PanelTab = PanelTab> {
  readonly key: K;
  readonly label: PanelLabel<K>;
  readonly icon: LucideIcon;
  readonly enabled: (context: PanelAvailabilityContext) => boolean;
  readonly render: (context: PanelRenderContext) => ReactNode;
}

type PanelEntryDefinitions = { [K in PanelTab]: PanelEntry<K> };

// No built-in panel currently has an availability restriction.
const alwaysEnabled = (): boolean => true;

const PANEL_ENTRIES = {
  files: {
    key: "files",
    label: "panels.kinds.files",
    icon: FolderTree,
    enabled: alwaysEnabled,
    render: ({ cwd, onAttachImage, revealFile, onRevealConsumed }) =>
      createElement(FilesPanel, {
        cwd,
        onAttachImage,
        revealFile,
        onRevealConsumed,
      }),
  },
  browser: {
    key: "browser",
    label: "panels.kinds.browser",
    icon: Globe,
    enabled: alwaysEnabled,
    render: ({
      cwd,
      visible,
      openUrl,
      browserAnchors,
      onRemoveBrowserAnchor,
      onUpdateBrowserAnchor,
      bucket,
      engineSessionId,
    }) =>
      createElement(BrowserPanel, {
        cwd,
        visible,
        openUrl,
        anchors: browserAnchors,
        onRemoveAnchor: onRemoveBrowserAnchor,
        onUpdateAnchor: onUpdateBrowserAnchor,
        bucket,
        engineSessionId,
        // Per-bucket partition keeps each chat session's browser storage/page isolated.
        partition: `persist:browser:${bucket.replace(/[^a-zA-Z0-9_:.@-]/g, "_")}`,
      }),
  },
  review: {
    key: "review",
    label: "panels.kinds.review",
    icon: GitCompare,
    enabled: alwaysEnabled,
    render: ({ cwd, reviewFiles, reviewDiff }) =>
      createElement(ReviewPanel, { cwd, files: reviewFiles, turnDiff: reviewDiff }),
  },
  terminal: {
    key: "terminal",
    label: "panels.kinds.terminal",
    icon: SquareTerminal,
    enabled: alwaysEnabled,
    // Per-tab session id keeps multiple terminal tabs independent.
    render: ({ cwd, bucket, tabId }) =>
      createElement(TerminalPanel, { cwd, sessionId: `term:${bucket}:${tabId}` }),
  },
  shells: {
    key: "shells",
    label: "panels.kinds.shells",
    icon: ServerCog,
    enabled: alwaysEnabled,
    render: ({ engineSessionId }) =>
      createElement(BackgroundShellPanel, { sessionId: engineSessionId }),
  },
  ccRoom: {
    key: "ccRoom",
    label: "panels.kinds.ccRoom",
    icon: Bot,
    enabled: alwaysEnabled,
    render: ({ cwd, foregroundVisible, openCliSession }) =>
      createElement(CCRoomView, {
        cwd,
        active: foregroundVisible,
        openRequest: openCliSession,
      }),
  },
  quickChat: {
    key: "quickChat",
    label: "panels.kinds.quickChat",
    icon: MessageCircle,
    enabled: alwaysEnabled,
    render: ({ renderQuickChatPanel, bucket, tabId, cwd }) =>
      renderQuickChatPanel?.({ ownerBucket: bucket, tabId, cwd }) ?? null,
  },
} satisfies PanelEntryDefinitions;

/** Built-in dock panels in their menu/landing display order. */
export const PANEL_REGISTRY: ReadonlyMap<PanelTab, PanelEntry> = new Map(
  Object.values(PANEL_ENTRIES).map((entry) => [entry.key, entry]),
);

export function getPanelEntry(kind: PanelTab): PanelEntry {
  return PANEL_REGISTRY.get(kind)!;
}

export function getEnabledPanelEntries(context: PanelAvailabilityContext): PanelEntry[] {
  return [...PANEL_REGISTRY.values()].filter((entry) => entry.enabled(context));
}
