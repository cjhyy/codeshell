import { createElement, type ReactNode } from "react";
import {
  Activity,
  BarChart3,
  Bot,
  FolderTree,
  GitCompare,
  Globe,
  PanelTop,
  Plug,
  ServerCog,
  SquareTerminal,
  Table2,
  type LucideIcon,
} from "lucide-react";
import type { PanelId } from "../view";
import type { Anchor } from "../chat/anchors";
import type { PluginPanelDescriptor, PluginPanelIconName } from "../../shared/plugin-panels";
import { FilesPanel } from "./FilesPanel";
import { BrowserPanel } from "./BrowserPanel";
import { ReviewPanel } from "./ReviewPanel";
import { TerminalPanel } from "./TerminalPanel";
import { BackgroundShellPanel } from "./BackgroundShellPanel";
import { CCRoomView } from "../cc-room/CCRoomView";
import type { OpenCliSessionRequest } from "../cc-room/types";
import { PluginPanelHost } from "./PluginPanelHost";
import type { DesktopPanelPluginHost } from "./DesktopPanelPlugin";

export interface PanelAvailabilityContext {
  cwd: string | null;
  engineSessionId: string | null;
}

export interface PanelRenderContext extends PanelAvailabilityContext {
  tabId: string;
  bucket: string;
  busy: boolean;
  visible: boolean;
  foregroundVisible: boolean;
  reviewFiles?: string[];
  reviewDiff?: string;
  revealFile?: { path: string; cwd: string | null; nonce: number; consumed?: boolean };
  onRevealConsumed?: (nonce: number) => void;
  openUrl?: { url: string; nonce: number };
  openCliSession?: OpenCliSessionRequest;
  onOpenCliSessionConsumed?: (nonce: number) => void;
  onAttachImage?: (absPath: string) => void;
  browserAnchors?: Anchor[];
  onRemoveBrowserAnchor?: (anchorId: string) => void;
  onUpdateBrowserAnchor?: (anchorId: string, comment: string) => void;
  panelPluginHost?: DesktopPanelPluginHost;
}

export type PanelOwner =
  | { kind: "builtin" }
  | { kind: "code"; pluginId: string; panelId: string }
  | { kind: "plugin"; installKey: string; panelId: string };

export type PanelTitle = { kind: "i18n"; key: string } | { kind: "literal"; value: string };

export interface PanelEntry {
  readonly key: PanelId;
  readonly owner: PanelOwner;
  readonly title: PanelTitle;
  readonly icon: LucideIcon;
  readonly order: number;
  readonly singleton: boolean;
  readonly enabled: (context: PanelAvailabilityContext) => boolean;
  readonly render: (context: PanelRenderContext) => ReactNode;
  /** Present only for trusted code-backed panels coordinated by core's lifecycle runtime. */
  readonly lifecycle?: { pluginId: string; panelId: string };
}

const alwaysEnabled = (): boolean => true;
const builtin = (entry: Omit<PanelEntry, "owner" | "singleton">): PanelEntry => ({
  ...entry,
  owner: { kind: "builtin" },
  singleton: false,
});

const BUILTIN_PANEL_ENTRIES: PanelEntry[] = [
  builtin({
    key: "files",
    title: { kind: "i18n", key: "panels.kinds.files" },
    icon: FolderTree,
    order: 0,
    enabled: alwaysEnabled,
    render: ({ cwd, onAttachImage, revealFile, onRevealConsumed }) =>
      createElement(FilesPanel, { cwd, onAttachImage, revealFile, onRevealConsumed }),
  }),
  builtin({
    key: "browser",
    title: { kind: "i18n", key: "panels.kinds.browser" },
    icon: Globe,
    order: 10,
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
        partition: `persist:browser:${bucket.replace(/[^a-zA-Z0-9_:.@-]/g, "_")}`,
      }),
  }),
  builtin({
    key: "review",
    title: { kind: "i18n", key: "panels.kinds.review" },
    icon: GitCompare,
    order: 20,
    enabled: alwaysEnabled,
    render: ({ cwd, reviewFiles, reviewDiff }) =>
      createElement(ReviewPanel, { cwd, files: reviewFiles, turnDiff: reviewDiff }),
  }),
  builtin({
    key: "terminal",
    title: { kind: "i18n", key: "panels.kinds.terminal" },
    icon: SquareTerminal,
    order: 30,
    enabled: alwaysEnabled,
    render: ({ cwd, bucket, tabId }) =>
      createElement(TerminalPanel, { cwd, sessionId: `term:${bucket}:${tabId}` }),
  }),
  builtin({
    key: "shells",
    title: { kind: "i18n", key: "panels.kinds.shells" },
    icon: ServerCog,
    order: 40,
    enabled: alwaysEnabled,
    render: ({ engineSessionId }) =>
      createElement(BackgroundShellPanel, { sessionId: engineSessionId }),
  }),
  builtin({
    key: "ccRoom",
    title: { kind: "i18n", key: "panels.kinds.ccRoom" },
    icon: Bot,
    order: 50,
    enabled: alwaysEnabled,
    render: ({ cwd, foregroundVisible, openCliSession, onOpenCliSessionConsumed }) =>
      createElement(CCRoomView, {
        cwd,
        active: foregroundVisible,
        openRequest: openCliSession,
        onOpenRequestConsumed: onOpenCliSessionConsumed,
      }),
  }),
];

function sameOwner(left: PanelOwner, right: PanelOwner): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "builtin" ||
      (left.kind === "code" &&
        right.kind === "code" &&
        left.pluginId === right.pluginId &&
        left.panelId === right.panelId) ||
      (left.kind === "plugin" &&
        right.kind === "plugin" &&
        left.installKey === right.installKey &&
        left.panelId === right.panelId))
  );
}

export class PanelRegistry {
  private readonly entries = new Map<PanelId, PanelEntry>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  register(entry: PanelEntry): () => void {
    if (!entry.key || this.entries.has(entry.key)) {
      throw new Error(`duplicate panel id: ${entry.key}`);
    }
    this.entries.set(entry.key, entry);
    this.emit();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key);
        this.emit();
      }
    };
  }

  unregisterOwner(owner: PanelOwner): void {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (!sameOwner(entry.owner, owner)) continue;
      this.entries.delete(id);
      changed = true;
    }
    if (changed) this.emit();
  }

  replacePluginEntries(next: PanelEntry[]): void {
    const nextIds = new Set<string>();
    for (const entry of next) {
      if (entry.owner.kind !== "plugin") throw new Error("plugin snapshot contains builtin panel");
      const existing = this.entries.get(entry.key);
      if (nextIds.has(entry.key) || (existing && existing.owner.kind !== "plugin")) {
        throw new Error(`duplicate panel id: ${entry.key}`);
      }
      nextIds.add(entry.key);
    }
    for (const [id, entry] of this.entries) {
      if (entry.owner.kind === "plugin") this.entries.delete(id);
    }
    for (const entry of next) this.entries.set(entry.key, entry);
    this.emit();
  }

  get(id: PanelId): PanelEntry | undefined {
    return this.entries.get(id);
  }

  list(context: PanelAvailabilityContext): PanelEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.enabled(context))
      .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
  }

  keys(): IterableIterator<PanelId> {
    return this.entries.keys();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): number => this.revision;

  private emit(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}

export const PANEL_REGISTRY = new PanelRegistry();
for (const entry of BUILTIN_PANEL_ENTRIES) PANEL_REGISTRY.register(entry);

const PLUGIN_ICONS: Record<PluginPanelIconName, LucideIcon> = {
  panel: PanelTop,
  chart: BarChart3,
  table: Table2,
  activity: Activity,
  plug: Plug,
};

export function replacePluginPanels(descriptors: PluginPanelDescriptor[]): void {
  PANEL_REGISTRY.replacePluginEntries(
    descriptors.map(
      (descriptor, index): PanelEntry => ({
        key: descriptor.id,
        owner: {
          kind: "plugin",
          installKey: descriptor.installKey,
          panelId: descriptor.panelId,
        },
        title: { kind: "literal", value: descriptor.title },
        icon: PLUGIN_ICONS[descriptor.icon],
        order: 1_000 + index,
        singleton: descriptor.singleton,
        enabled: alwaysEnabled,
        render: ({ tabId, bucket, busy, cwd, engineSessionId, foregroundVisible }) =>
          createElement(PluginPanelHost, {
            descriptor,
            tabId,
            bucket,
            busy,
            cwd,
            engineSessionId,
            visible: foregroundVisible,
          }),
      }),
    ),
  );
}

export function getPanelEntry(kind: PanelId): PanelEntry | undefined {
  return PANEL_REGISTRY.get(kind);
}

export function getEnabledPanelEntries(context: PanelAvailabilityContext): PanelEntry[] {
  return PANEL_REGISTRY.list(context);
}

export function panelEntryTitle(entry: PanelEntry, translate: (key: string) => string): string {
  return entry.title.kind === "literal" ? entry.title.value : translate(entry.title.key);
}
