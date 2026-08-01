import {
  createElement,
  lazy,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from "react";
import {
  KeyRound,
  PlayCircle,
  Puzzle,
  ScrollText,
  Settings,
  UsersRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { ViewMode } from "../view";

/**
 * Full-screen page registry — the sibling of panels/PanelRegistry.ts for the
 * main view area. Built-in pages register here; the sidebar's first-level nav
 * and App.tsx's page render both consume it.
 *
 * This registry is intentionally built-in-only. Installable Agent Plugins do
 * not contribute Desktop UI; installable UI belongs to the Panel App system.
 */

export type PageKey = string;

export type PageOwner = { kind: "builtin" };

export type PageTitle = { kind: "i18n"; key: string } | { kind: "literal"; value: string };

export interface PageNav {
  /** Position in the sidebar first-level nav; builtins pin the current order. */
  readonly order: number;
  /** ViewMode applied when the nav item is clicked. */
  readonly target: ViewMode;
  /** Highlight predicate — mirrors the previously hardcoded checks exactly. */
  readonly isActive: (viewMode: ViewMode) => boolean;
}

/** App-owned state a full-screen page render may need. Grows per consumer. */
export interface PageRenderContext {
  /** Deep-link into the runs view (set by the automation view). */
  runsInitialRunId: string | null;
  /** Active repository, used by project-aware standalone pages. */
  activeProjectPath: string | null;
}

export interface PageEntry {
  readonly key: PageKey;
  readonly owner: PageOwner;
  readonly title: PageTitle;
  readonly icon: LucideIcon;
  /** Sidebar nav placement; render-only pages (command-palette routes) omit it. */
  readonly nav?: PageNav;
  /**
   * Full-screen body. `null` marks a nav entry whose body still renders
   * through App.tsx's legacy ternary chain (unmigrated built-ins).
   */
  readonly render: ((context: PageRenderContext) => ReactNode) | null;
}

const builtin = (entry: Omit<PageEntry, "owner">): PageEntry => ({
  ...entry,
  owner: { kind: "builtin" },
});

// Migrated low-traffic pages stay off the chat startup path with the same
// React.lazy idiom App.tsx used; the Suspense boundary lives in App.
// Explicit prop typing so createElement's overloads resolve: the source
// components take optional props via a default parameter, which lazy() +
// createElement cannot infer on its own (JSX takes a different type path).
const LogsView: LazyExoticComponent<ComponentType> = lazy(() =>
  import("../logs/LogsView").then((module) => ({ default: module.LogsView })),
);
const RunsView: LazyExoticComponent<ComponentType<{ initialRunId?: string | null }>> = lazy(() =>
  import("../runs/RunsView").then((module) => ({ default: module.RunsView })),
);
const ExtensionsPage: LazyExoticComponent<
  ComponentType<{ activeProjectPath: string | null; showDiscover?: boolean }>
> = lazy(() =>
  import("../extensions/ExtensionsPage").then((module) => ({
    default: module.ExtensionsPage,
  })),
);

const BUILTIN_PAGE_ENTRIES: PageEntry[] = [
  builtin({
    key: "extensions",
    title: { kind: "i18n", key: "sidebar.extensions" },
    icon: Puzzle,
    nav: { order: -10, target: "extensions", isActive: (mode) => mode === "extensions" },
    render: ({ activeProjectPath }) =>
      createElement(ExtensionsPage, { activeProjectPath, showDiscover: false }),
  }),
  builtin({
    key: "digital_humans",
    title: { kind: "i18n", key: "sidebar.digitalHumans" },
    icon: UsersRound,
    nav: { order: 0, target: "digital_humans", isActive: (mode) => mode === "digital_humans" },
    render: null,
  }),
  builtin({
    key: "automation",
    title: { kind: "i18n", key: "sidebar.automation" },
    icon: Workflow,
    // Highlights on the view it actually navigates to. This previously said
    // `mode === "runs"`, carried over from the hardcoded Sidebar: clicking the
    // item opened Automation but left it un-highlighted, while the Runs page lit
    // up an item that does not lead there. `runs` has no sidebar entry of its
    // own (it is reached from Automation), so it highlights nothing.
    nav: { order: 10, target: "automation", isActive: (mode) => mode === "automation" },
    render: null,
  }),
  builtin({
    key: "credentials",
    title: { kind: "i18n", key: "sidebar.credentials" },
    icon: KeyRound,
    nav: { order: 20, target: "credentials", isActive: (mode) => mode === "credentials" },
    render: null,
  }),
  builtin({
    key: "settings_page",
    title: { kind: "i18n", key: "sidebar.settings" },
    icon: Settings,
    render: null,
  }),
  // Migrated low-traffic pages: render-only (reached via command palette /
  // automation view), proving the registry render seam. Titles surface only
  // in nav today, so they reuse the palette labels.
  builtin({
    key: "logs",
    title: { kind: "i18n", key: "panels.palette.openLogs" },
    icon: ScrollText,
    render: () => createElement(LogsView),
  }),
  builtin({
    key: "runs",
    title: { kind: "i18n", key: "panels.palette.openRuns" },
    icon: PlayCircle,
    render: ({ runsInitialRunId }) => createElement(RunsView, { initialRunId: runsInitialRunId }),
  }),
];

export class PageRegistry {
  private readonly entries = new Map<PageKey, PageEntry>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  register(entry: PageEntry): () => void {
    if (!entry.key || this.entries.has(entry.key)) {
      throw new Error(`duplicate page key: ${entry.key}`);
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

  get(key: PageKey): PageEntry | undefined {
    return this.entries.get(key);
  }

  has(key: PageKey): boolean {
    return this.entries.has(key);
  }

  /** Sidebar first-level nav items, sorted by order (builtins pin today's order). */
  navEntries(): PageEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.nav !== undefined)
      .sort(
        (left, right) => left.nav!.order - right.nav!.order || left.key.localeCompare(right.key),
      );
  }

  keys(): IterableIterator<PageKey> {
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

export const PAGE_REGISTRY = new PageRegistry();
for (const entry of BUILTIN_PAGE_ENTRIES) PAGE_REGISTRY.register(entry);

export function pageEntryTitle(entry: PageEntry, translate: (key: string) => string): string {
  return entry.title.kind === "literal" ? entry.title.value : translate(entry.title.key);
}
