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
 * This round is internal-consumers-only: `owner` reserves the code/plugin
 * shapes for later, but nothing outside this module constructs them yet
 * (see docs/superpowers/plans/2026-07-17-plugin-contribution-points.md
 * non-goals).
 */

export type PageKey = string;

export type PageOwner =
  | { kind: "builtin" }
  | { kind: "code"; pluginId: string; pageId: string }
  | { kind: "plugin"; installKey: string; pageId: string };

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

const BUILTIN_PAGE_ENTRIES: PageEntry[] = [
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
    // NOTE: preserved verbatim from the previously hardcoded Sidebar item —
    // clicking sets "automation" but the item highlights on the "runs" view.
    // Known quirk; fixing it is out of scope for the registry migration.
    nav: { order: 10, target: "automation", isActive: (mode) => mode === "runs" },
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
    nav: {
      order: 30,
      target: "settings_page",
      isActive: (mode) => mode === "settings_page" || mode === "project_config",
    },
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
