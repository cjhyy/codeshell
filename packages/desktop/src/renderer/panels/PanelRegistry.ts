import { createElement, lazy, Suspense, type ComponentType, type ReactNode } from "react";
import {
  Bot,
  FolderTree,
  GitCompare,
  Globe,
  ServerCog,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import type { PanelId } from "../view";
import type { Anchor } from "../chat/anchors";
import type { PanelAppAgentToolDescriptor, PanelAppDescriptor } from "../../shared/panel-apps";
import { resolvePanelAppIcon } from "./panelAppIcons";
import { FilesPanel } from "./FilesPanel";
import { BrowserPanel } from "./BrowserPanel";
import { ReviewPanel } from "./ReviewPanel";
// TerminalPanel is the ONLY importer of @xterm/xterm (+ addon-fit + its CSS).
// Importing it statically pulled the whole terminal emulator into the first-load
// chunk for every user, including those who never open a terminal. Loading it on
// first render moves it to its own chunk.
const TerminalPanel = lazy(async () => ({
  default: (await import("./TerminalPanel")).TerminalPanel as ComponentType<TerminalPanelProps>,
}));

interface TerminalPanelProps {
  cwd: string | null;
  sessionId: string;
}
import { BackgroundShellPanel } from "./BackgroundShellPanel";
import { CCRoomView } from "../cc-room/CCRoomView";
import type { OpenCliSessionRequest } from "../cc-room/types";
import { PanelAppHost } from "./PanelAppHost";
import type { DesktopBuiltinPanelAppHost } from "./DesktopBuiltinPanelApp";

export interface PanelAvailabilityContext {
  projectPath: string | null;
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
  builtinPanelAppHost?: DesktopBuiltinPanelAppHost;
}

export type PanelOwner =
  | { kind: "builtin" }
  | { kind: "builtin-panel-app"; appId: string; panelId: string }
  | { kind: "panel-app"; appId: string };

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
  /** Present only for trusted built-in Panel Apps coordinated by core's lifecycle runtime. */
  readonly lifecycle?: { appId: string; panelId: string };
  /** Agent tools declared by an independently installed Panel App. */
  readonly agentTools?: PanelAppAgentToolDescriptor[];
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
      createElement(
        Suspense,
        // No spinner: the chunk is local and resolves in a frame or two, so a
        // flash of loading UI would be more distracting than an empty panel.
        { fallback: null },
        createElement(TerminalPanel, { cwd, sessionId: `term:${bucket}:${tabId}` }),
      ),
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
      (left.kind === "builtin-panel-app" &&
        right.kind === "builtin-panel-app" &&
        left.appId === right.appId &&
        left.panelId === right.panelId) ||
      (left.kind === "panel-app" && right.kind === "panel-app" && left.appId === right.appId))
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

  replacePanelAppEntries(next: PanelEntry[]): void {
    const nextIds = new Set<string>();
    for (const entry of next) {
      if (entry.owner.kind !== "panel-app") {
        throw new Error("Panel App snapshot contains a non-app panel");
      }
      const existing = this.entries.get(entry.key);
      if (nextIds.has(entry.key) || (existing && existing.owner.kind !== "panel-app")) {
        throw new Error(`duplicate panel id: ${entry.key}`);
      }
      nextIds.add(entry.key);
    }
    for (const [id, entry] of this.entries) {
      if (entry.owner.kind === "panel-app") this.entries.delete(id);
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

/**
 * Publish the installed Panel App catalog to the registry.
 *
 * A Panel App is enabled for exactly the projects that bind it. Panel buckets
 * are per project and the Extensions screen edits any project's bindings, so
 * the caller passes the full per-app project list; keying off a single "active"
 * project left every other project's dock empty.
 *
 * `boundProjectPathsByAppId` is authoritative when provided. `boundProjectPath`
 * is the legacy single-project form, still used when the host predates
 * `listPanelAppsForProjects` — there the descriptors are already filtered to
 * that one project.
 */
export function replacePanelApps(
  descriptors: PanelAppDescriptor[],
  boundProjectPath: string | null,
  boundProjectPathsByAppId?: Readonly<Record<string, readonly string[]>>,
): void {
  PANEL_REGISTRY.replacePanelAppEntries(
    descriptors.map((descriptor, index): PanelEntry => {
      const boundPaths = boundProjectPathsByAppId
        ? new Set<string>(boundProjectPathsByAppId[descriptor.appId] ?? [])
        : new Set<string>(boundProjectPath ? [boundProjectPath] : []);
      return {
        key: descriptor.id,
        owner: {
          kind: "panel-app",
          appId: descriptor.appId,
        },
        title: { kind: "literal", value: descriptor.title },
        icon: resolvePanelAppIcon(descriptor.icon),
        order: 1_000 + index,
        singleton: descriptor.singleton,
        agentTools: descriptor.agent?.tools.map((tool) => ({
          ...tool,
          inputSchema: { ...tool.inputSchema },
        })),
        enabled: ({ projectPath }) => Boolean(projectPath) && boundPaths.has(projectPath!),
        render: ({ tabId, bucket, busy, projectPath, cwd, engineSessionId, foregroundVisible }) =>
          createElement(PanelAppHost, {
            descriptor,
            tabId,
            bucket,
            busy,
            projectPath,
            cwd,
            engineSessionId,
            visible: foregroundVisible,
          }),
      };
    }),
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
