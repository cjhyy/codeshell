# Plugin Contribution Points (Workflow D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open two plugin contribution seams — a full-screen `PageRegistry` (mirroring the proven `PanelRegistry`) that the sidebar nav and 2 low-traffic built-in pages consume, and a wider sandboxed-panel API (lucide icon allowlist + `workspace.info` / `notifications.send` permissions).

**Architecture:** D1 converts `renderer/view.ts`'s closed `ViewMode` union into "builtin enum + registry key", adds `renderer/pages/PageRegistry.ts` with the same register/subscribe/`useSyncExternalStore` shape as `renderer/panels/PanelRegistry.ts`, makes `Sidebar.tsx` read its top-level nav from the registry (builtins pinned by `order`, zero visual change), and migrates `logs` + `runs` renders out of App.tsx's ternary chain (unmigrated pages keep their ternary branches). D2 widens `shared/plugin-panels.ts` + core installer zod in lockstep (parity test), and adds two RPC handlers to `main/plugin-panel-bridge.ts` following the existing permission/rate-limit pattern.

**Tech Stack:** TypeScript, React 18 (`useSyncExternalStore`, `React.lazy`/`Suspense`), lucide-react ^0.460, zod (core installer), Electron main (`Notification`), bun test (renderer contract tests read source text; main-process bridge tests run in the isolated Electron-mock fixture).

**Branch/commits:** one feature branch (e.g. `feat/plugin-contribution-points`), conventional commits, one commit per task step group as written below.

**Verification per repo convention:** after each task run the named `bun test` files; before hand-off run `bun test` + `bun run lint` at the repo root, plus `bun run typecheck` and `bun run build` inside `packages/desktop` (desktop has its own typecheck/build; root checks do not cover it). Core changes (Task 5/6) additionally need `bun run build` in `packages/core` if the repo's package build is part of the affected-package convention.

---

## Design point → task mapping

| Spec (workflow D) design point | Task |
| --- | --- |
| `ViewMode` closed union → builtin enum + registry key; `loadView` legacy migration registry-friendly | Task 1 |
| `renderer/pages/PageRegistry.ts` aligned with `PanelRegistry` (key/owner/title/icon/order/enabled-equivalent/render, subscribe/snapshot) | Task 2 |
| Sidebar top-level nav reads from the registry; builtin order pinned; zero visual change | Task 3 |
| Migrate 2 low-traffic builtin pages (logs, runs) as internal proof of the seam; App ternary/registry co-existence; `React.lazy` + `Suspense` preserved | Task 4 |
| Icon: 5-value enum → validated lucide-name allowlist (explicit list, bundle-size safe) | Task 5 |
| Permissions: +`workspace.info`, +`notifications.send`, same RPC/rate-limit pattern, cap stays 8 | Task 6 |
| Core `installer/types.ts` validation sync | Tasks 5, 6 |
| `docs/plugin-panels.md` sync | Task 7 |
| Non-goals | Non-goals section below |

## Non-goals (explicitly out of scope this round)

- **No UI contribution fields for capability packages** (`/extension` `CapabilityModule`): no `pages`/`nav` fields there. The registry ships with internal consumers only.
- **No plugin pages in the first-level nav**: `PageRegistry` accepts only `owner: { kind: "builtin" }` entries in this round; the `PageOwner` union reserves `code`/`plugin` shapes but nothing constructs them.
- **No pet UI pluginization.** `PetSidebarEntry`, the pet page, and the pet chat host stay hardcoded.
- **`approvals` stays in the App ternary** (its render needs live approval queue state; migrate after the seam has proven itself on stateless/near-stateless pages).
- **No dynamic lucide import for icons** — explicit static allowlist only, to keep the renderer bundle deterministic.
- **Permission cap stays `max(8)`** in the manifest schema (7 permissions total after this round).

## Findings vs. the design doc's assumptions (read before executing)

1. **Sidebar top nav is at `Sidebar.tsx:245-293`** (not 247-291). It contains: `PetSidebarEntry`, a divider, two *action* items (新对话/搜索 — not ViewModes), then four page items (数字人/自动化/凭证/设置). Only the four page items move to the registry; pet + action items stay hardcoded.
2. **Workstream A already landed the 设置 nav item** (`active={viewMode === "settings_page" || viewMode === "project_config"}`, `Sidebar.tsx:287-292`) and already deleted `CustomizeView`'s sidebar entry. `loadView()` already migrates `"customize"` → `"settings_page"` (`view.ts:60`).
3. **`"settings"` is NOT migrated today** — the design/prompt assumed `"settings"` → `settings_page` migration exists; in reality `view.ts` keeps `"settings"` as a valid mode ("legacy modal route") but **nothing sets it and App has no render branch for it** (a persisted `"settings"` silently renders the chat fallback). Task 1 adds the migration and drops `"settings"` from the builtin enum.
4. **Pre-existing nav quirk (preserve, do not fix):** the 自动化 item *sets* `viewMode "automation"` but *highlights* on `viewMode === "runs"` (`Sidebar.tsx:275-280`). Zero-visual-change means the registry entry replicates this exactly (`isActive: (mode) => mode === "runs"`, `target: "automation"`). Flag as a follow-up, out of scope.
5. `logs` and `approvals` are only reachable via the command palette (`shell/CommandPalette.tsx:130,134`); `runs` via the automation view (`App.tsx:2007`) and the palette-highlighted nav quirk. All palette routes keep working unchanged because migrated pages keep their old `ViewMode` literals as registry keys.
6. The bridge fixture runner **asserts a literal pass count** (`plugin-panel-protocol.test.ts:19` expects `"10 pass"`). Task 6 adds 2 fixture tests and must bump it to `"12 pass"`.
7. The Extensions page renders permission names as raw strings (`extensions/PanelsTab.tsx:81`, `PluginDetailView.tsx:691`) — no i18n additions needed for new permissions.

---

### Task 1: view.ts — open the ViewMode union, registry-friendly loadView

**Files:**
- Modify: `packages/desktop/src/renderer/view.ts` (whole file, 74 lines)
- Test: `packages/desktop/src/renderer/view.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/desktop/src/renderer/view.test.ts` (localStorage stub pattern copied from `transcripts.test.ts:39-56`):

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BUILTIN_VIEW_MODES, loadView, saveView, type ViewState } from "./view";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear">;

function createStorage(): StorageLike {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
    clear: () => {
      items.clear();
    },
  };
}

describe("loadView", () => {
  const originalLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: createStorage(),
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: originalLocalStorage,
      configurable: true,
    });
  });

  function persist(viewMode: string): void {
    saveView({ viewMode, sidebarCollapsed: false, inspectorCollapsed: true } as ViewState);
  }

  it("returns the chat default when nothing is persisted", () => {
    expect(loadView().viewMode).toBe("chat");
  });

  it("keeps every builtin mode", () => {
    for (const mode of BUILTIN_VIEW_MODES) {
      persist(mode);
      expect(loadView().viewMode).toBe(mode);
    }
  });

  it("migrates the legacy customize and settings routes to the settings page", () => {
    persist("customize");
    expect(loadView().viewMode).toBe("settings_page");
    persist("settings");
    expect(loadView().viewMode).toBe("settings_page");
  });

  it("falls back to chat for an unknown persisted mode", () => {
    persist("files");
    expect(loadView().viewMode).toBe("chat");
    persist("page:foo@local:dash");
    expect(loadView().viewMode).toBe("chat");
  });

  it("keeps a non-builtin mode the registry predicate recognizes", () => {
    persist("page:foo@local:dash");
    expect(loadView((mode) => mode === "page:foo@local:dash").viewMode).toBe(
      "page:foo@local:dash",
    );
  });

  it("preserves the other persisted view flags", () => {
    persist("logs");
    const state = loadView();
    expect(state.inspectorCollapsed).toBe(true);
    expect(state.sidebarCollapsed).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/desktop/src/renderer/view.test.ts`
Expected: FAIL — `BUILTIN_VIEW_MODES` is not exported, and `loadView` does not accept a predicate / does not migrate `"settings"`.

- [ ] **Step 3: Rewrite view.ts**

Replace the `ViewMode` union (`view.ts:1-13`), `VALID_MODES` (`view.ts:39-52`), and `loadView` (`view.ts:54-69`) with:

```ts
/**
 * Built-in full-screen routes. The union is intentionally open: registered
 * pages (renderer/pages/PageRegistry.ts) contribute additional string keys,
 * so persisted state and setViewMode accept both.
 */
export const BUILTIN_VIEW_MODES = [
  "chat",
  "pet", // first-class Pet workspace; never layered over chat
  "digital_humans", // market, installed digital humans, and Pet-led teams
  "sessions",
  "approvals",
  "runs",
  "automation", // scheduled automation jobs (cron) — list + detail + create
  "settings_page", // full-screen Settings page
  "project_config", // full-screen settings for one tracked project
  "credentials", // full-screen 凭证 (cookie + token + link) view
  "logs",
] as const;

export type BuiltinViewMode = (typeof BUILTIN_VIEW_MODES)[number];
/** Builtin literals keep autocomplete; registry page keys ride the open half. */
export type ViewMode = BuiltinViewMode | (string & {});
```

(Keep the `PanelId`/`PanelTab` block, `KEY`, `ViewState`, `DEFAULT`, and `saveView` exactly as they are.)

```ts
const BUILTIN_MODES: ReadonlySet<string> = new Set(BUILTIN_VIEW_MODES);

export function loadView(isRegisteredPage?: (mode: string) => boolean): ViewState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const merged = { ...DEFAULT, ...(JSON.parse(raw) as Partial<ViewState>) };
    // Legacy routes: the standalone 扩展 view ("customize") and the old
    // settings modal route ("settings") both merged into the full-screen
    // Settings page. Keep these as quoted literals — the settings contract
    // test asserts view.ts still contains '"customize"'.
    if (merged.viewMode === "customize" || merged.viewMode === "settings") {
      merged.viewMode = "settings_page";
    }
    // Old builds persisted panel kinds (files/browser/review/terminal) as
    // ViewModes; those are now dock tabs, not full-screen views. Anything that
    // is neither builtin nor a registered page falls back to chat so a stale
    // value doesn't leave the user on a blank/unknown view.
    if (!BUILTIN_MODES.has(merged.viewMode) && !isRegisteredPage?.(merged.viewMode)) {
      merged.viewMode = "chat";
    }
    return merged;
  } catch {
    return DEFAULT;
  }
}
```

- [ ] **Step 4: Verify nothing references the removed `"settings"` mode**

Run: `grep -rn '=== "settings"' packages/desktop/src/renderer | grep -v settings_page`
Expected: no output (pre-verified during planning; if anything shows up, that call site must switch to `"settings_page"`).

Run: `grep -rn 'setViewMode("settings")' packages/desktop/src`
Expected: no output.

- [ ] **Step 5: Run tests and desktop typecheck**

Run: `bun test packages/desktop/src/renderer/view.test.ts`
Expected: PASS (6 tests).

Run: `cd packages/desktop && bun run typecheck`
Expected: no NEW errors (repo convention: typecheck is not a clean gate, but must not regress).

Note: `SettingsPage.scope.contract.test.ts:44` asserts `view` contains `'"customize"'` — the `LEGACY_MODE_MIGRATIONS` literal keeps it. Run `bun test packages/desktop/src/renderer/settings/SettingsPage.scope.contract.test.ts` and expect PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/view.ts packages/desktop/src/renderer/view.test.ts
git commit -m "feat(desktop): open ViewMode into builtin enum + registry keys with legacy settings migration"
```

---

### Task 2: PageRegistry skeleton + builtin nav entries

**Files:**
- Create: `packages/desktop/src/renderer/pages/PageRegistry.ts`
- Test: `packages/desktop/src/renderer/pages/PageRegistry.test.ts` (create)

Pattern source: `packages/desktop/src/renderer/panels/PanelRegistry.ts` (entry shape L61-72, register/dispose L182-197, subscribe/snapshot L240-250, builtin registration L253-254, title helper L302-304).

- [ ] **Step 1: Write the failing test**

Create `packages/desktop/src/renderer/pages/PageRegistry.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { PAGE_REGISTRY, PageRegistry, type PageEntry } from "./PageRegistry";

describe("PageRegistry", () => {
  it("pins the builtin sidebar nav in the historical order", () => {
    // Exactly today's Sidebar.tsx order: 数字人 → 自动化 → 凭证 → 设置.
    expect(PAGE_REGISTRY.navEntries().map((entry) => entry.key)).toEqual([
      "digital_humans",
      "automation",
      "credentials",
      "settings_page",
    ]);
  });

  it("reuses the existing sidebar i18n labels", () => {
    const titles = PAGE_REGISTRY.navEntries().map((entry) => entry.title);
    expect(titles).toEqual([
      { kind: "i18n", key: "sidebar.digitalHumans" },
      { kind: "i18n", key: "sidebar.automation" },
      { kind: "i18n", key: "sidebar.credentials" },
      { kind: "i18n", key: "sidebar.settings" },
    ]);
  });

  it("replicates the hardcoded active-state predicates exactly", () => {
    const automation = PAGE_REGISTRY.get("automation")!;
    // Preserved quirk: the automation item highlights on the runs view.
    expect(automation.nav!.isActive("runs")).toBe(true);
    expect(automation.nav!.isActive("automation")).toBe(false);
    expect(automation.nav!.target).toBe("automation");

    const settings = PAGE_REGISTRY.get("settings_page")!;
    expect(settings.nav!.isActive("settings_page")).toBe(true);
    expect(settings.nav!.isActive("project_config")).toBe(true);
    expect(settings.nav!.isActive("chat")).toBe(false);
  });

  it("marks unmigrated builtins as legacy-rendered", () => {
    for (const key of ["digital_humans", "automation", "credentials", "settings_page"]) {
      expect(PAGE_REGISTRY.get(key)!.render).toBeNull();
    }
  });

  it("supports dynamic registration, duplicate rejection, and idempotent disposal", () => {
    const registry = new PageRegistry();
    const entry: PageEntry = {
      key: "page:demo@local:report",
      owner: { kind: "builtin" },
      title: { kind: "literal", value: "Report" },
      icon: PAGE_REGISTRY.get("credentials")!.icon,
      nav: { order: 1_000, target: "page:demo@local:report", isActive: () => false },
      render: () => null,
    };
    const dispose = registry.register(entry);
    expect(registry.get(entry.key)).toBe(entry);
    expect(registry.has(entry.key)).toBe(true);
    expect(() => registry.register(entry)).toThrow(/duplicate page key/);
    dispose();
    dispose();
    expect(registry.get(entry.key)).toBeUndefined();
  });

  it("bumps the snapshot revision and notifies subscribers on changes", () => {
    const registry = new PageRegistry();
    let notified = 0;
    const unsubscribe = registry.subscribe(() => {
      notified += 1;
    });
    const before = registry.snapshot();
    const dispose = registry.register({
      key: "page:demo@local:one",
      owner: { kind: "builtin" },
      title: { kind: "literal", value: "One" },
      icon: PAGE_REGISTRY.get("credentials")!.icon,
      render: () => null,
    });
    expect(registry.snapshot()).toBeGreaterThan(before);
    expect(notified).toBe(1);
    dispose();
    expect(notified).toBe(2);
    unsubscribe();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/desktop/src/renderer/pages/PageRegistry.test.ts`
Expected: FAIL — module `./PageRegistry` does not exist.

- [ ] **Step 3: Create PageRegistry.ts**

Create `packages/desktop/src/renderer/pages/PageRegistry.ts`:

```ts
import type { ReactNode } from "react";
import { KeyRound, Settings, UsersRound, Workflow, type LucideIcon } from "lucide-react";
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
      .sort((left, right) => left.nav!.order - right.nav!.order || left.key.localeCompare(right.key));
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/desktop/src/renderer/pages/PageRegistry.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/pages/PageRegistry.ts packages/desktop/src/renderer/pages/PageRegistry.test.ts
git commit -m "feat(desktop): add full-screen PageRegistry mirroring the PanelRegistry pattern"
```

---

### Task 3: Sidebar first-level nav reads from the registry

**Files:**
- Modify: `packages/desktop/src/renderer/Sidebar.tsx` (imports L1-34, props L36-78 + L108-121, nav block L245-293)
- Modify: `packages/desktop/src/renderer/App.tsx:1911-1919` (Sidebar props)
- Test: `packages/desktop/src/renderer/pages/PageRegistry.contract.test.ts` (create)

Acceptance: **zero visual change** — same four items, same order, same icons (`UsersRound`, `Workflow`, `KeyRound`, `Settings`), same i18n labels, same active behavior (including the automation/runs quirk).

- [ ] **Step 1: Write the failing contract test**

Create `packages/desktop/src/renderer/pages/PageRegistry.contract.test.ts` (source-text style, same as `settings/SettingsPage.scope.contract.test.ts`):

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const registry = readFileSync(join(import.meta.dir, "PageRegistry.ts"), "utf-8");
const sidebar = readFileSync(join(import.meta.dir, "..", "Sidebar.tsx"), "utf-8");
const view = readFileSync(join(import.meta.dir, "..", "view.ts"), "utf-8");

describe("PageRegistry contract", () => {
  test("view modes are builtin enum + registry keys with legacy migrations", () => {
    expect(view).toContain("BUILTIN_VIEW_MODES");
    expect(view).toContain("isRegisteredPage");
    expect(view).toContain('"customize"');
    expect(view).toContain("settings_page");
  });

  test("the sidebar first-level nav is registry-driven, not hardcoded", () => {
    expect(sidebar).toContain("PAGE_REGISTRY");
    expect(sidebar).toContain("navEntries");
    expect(sidebar).toContain("useSyncExternalStore");
    expect(sidebar).toContain("onNavigate");
    // The four page items no longer carry per-page props or literals.
    expect(sidebar).not.toContain("onOpenDigitalHumans");
    expect(sidebar).not.toContain("onOpenAutomations");
    expect(sidebar).not.toContain("onOpenCredentials");
    expect(sidebar).not.toContain('t("sidebar.digitalHumans")');
    expect(sidebar).not.toContain('t("sidebar.credentials")');
  });

  test("nav labels and the settings double-active predicate live in the registry", () => {
    expect(registry).toContain('"sidebar.digitalHumans"');
    expect(registry).toContain('"sidebar.automation"');
    expect(registry).toContain('"sidebar.credentials"');
    expect(registry).toContain('"sidebar.settings"');
    expect(registry).toContain('mode === "settings_page" || mode === "project_config"');
  });

  test("pet entry and the action items stay outside the registry", () => {
    expect(sidebar).toContain("PetSidebarEntry");
    expect(sidebar).toContain('t("sidebar.newConversation")');
    expect(sidebar).toContain('t("sidebar.search")');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/desktop/src/renderer/pages/PageRegistry.contract.test.ts`
Expected: FAIL — Sidebar.tsx still contains `onOpenDigitalHumans` etc. and no `PAGE_REGISTRY`.

- [ ] **Step 3: Rework Sidebar.tsx**

3a. Imports (`Sidebar.tsx:1-34`): add `useSyncExternalStore` to the React import; remove now-unused lucide imports `Settings as SettingsIcon`, `Workflow`, `KeyRound`, `UsersRound`; add the registry import:

```ts
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PAGE_REGISTRY, pageEntryTitle } from "./pages/PageRegistry";
```

(Keep `MessageSquare`, `Search`, `Folder`, `FolderOpen`, `Plus`, `MoreHorizontal`, `PenSquare`, `Archive`, `Clock`, `Loader2` — still used.)

3b. Props (`SidebarProps`, L62-67): delete `onOpenAutomations`, `onOpenDigitalHumans`, `onOpenCredentials`; add:

```ts
  /** Navigate to a registry page's target view (sidebar first-level nav). */
  onNavigate: (mode: ViewMode) => void;
```

Keep `onOpenSettingsPage` (still used by the bottom `SettingsMenu`, L408-413) and `onOpenProjectConfig`/`onOpenPetPage`. Update the destructuring list (L108-121) accordingly.

3c. Nav block: inside the component body add (near the top, after `const toast = useToast();`):

```ts
  // Re-render when pages register/unregister (same idiom as panels/PanelArea.tsx:158).
  useSyncExternalStore(PAGE_REGISTRY.subscribe, PAGE_REGISTRY.snapshot, PAGE_REGISTRY.snapshot);
  const navPages = PAGE_REGISTRY.navEntries();
```

Replace the four `<SidebarItem …>` page items (current L265-292, the ones for digitalHumans/automation/credentials/settings) with:

```tsx
        {/* NOTE: this list used to be hardcoded; the GLOBAL pending-approvals
            badge history note from the automation item still applies — the
            per-session asking dot + dock badge (setBadgeCount) cover it. */}
        {navPages.map((entry) => (
          <SidebarItem
            key={entry.key}
            label={pageEntryTitle(entry, t)}
            Icon={entry.icon}
            onClick={() => onNavigate(entry.nav!.target)}
            active={entry.nav!.isActive(viewMode)}
          />
        ))}
```

(The `PetSidebarEntry`, divider, 新对话 and 搜索 items above it stay untouched.)

- [ ] **Step 4: Update App.tsx call site**

`App.tsx:1911-1919` — replace the three deleted props with `onNavigate`:

```tsx
                onOpenSearch={() => setSessionSearchOpen(true)}
                onNavigate={setViewMode}
                onOpenProjectConfig={(projectId) => {
                  setActiveProjectId(projectId);
                  setViewMode("project_config");
                }}
                onOpenSettingsPage={() => setViewMode("settings_page")}
```

(`setViewMode` is `(v: ViewMode) => void` from `app/useRunController.ts:994` — signature matches `onNavigate` directly.)

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test packages/desktop/src/renderer/pages/ packages/desktop/src/renderer/Sidebar.test.ts packages/desktop/src/renderer/settings/SettingsPage.scope.contract.test.ts packages/desktop/src/renderer/digital-humans/DigitalHumansView.contract.test.ts`
Expected: PageRegistry contract PASS; Sidebar.test.ts PASS. **Two existing contract tests WILL fail and must be updated in this step:** `DigitalHumansView.contract.test.ts:23` expects `sidebar` to contain `t("sidebar.digitalHumans")` — update that one assertion to read the registry source instead:

```ts
const pageRegistry = readFileSync(join(import.meta.dir, "..", "pages", "PageRegistry.ts"), "utf-8");
// in the first test, replace the sidebar assertion:
expect(pageRegistry).toContain('"sidebar.digitalHumans"');
```

Similarly `SettingsPage.scope.contract.test.ts:41` expects `sidebar` to contain `t("sidebar.settings")` — update to:

```ts
const pageRegistry = readFileSync(join(import.meta.dir, "..", "pages", "PageRegistry.ts"), "utf-8");
expect(pageRegistry).toContain('"sidebar.settings"');
```

Run: `cd packages/desktop && bun run typecheck` — no new errors.
Run: `bun test packages/desktop/src/renderer/narrow-layout.smoke.test.tsx` — PASS (renders App; catches missed prop plumbing).

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/Sidebar.tsx packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/pages/PageRegistry.contract.test.ts packages/desktop/src/renderer/settings/SettingsPage.scope.contract.test.ts packages/desktop/src/renderer/digital-humans/DigitalHumansView.contract.test.ts
git commit -m "feat(desktop): drive the sidebar first-level nav from PageRegistry with pinned builtin order"
```

---

### Task 4: Migrate logs + runs to registry render; App co-existence

**Files:**
- Modify: `packages/desktop/src/renderer/pages/PageRegistry.ts` (add lazy pages + 2 entries)
- Modify: `packages/desktop/src/renderer/App.tsx` (L129-134 lazy decls; L199 `loadView`; ternary chain L1974-1977 and L1997-2000)
- Test: `packages/desktop/src/renderer/pages/PageRegistry.test.ts` (extend)
- Test: `packages/desktop/src/renderer/pages/PageRegistry.contract.test.ts` (extend)

Co-existence rule: **migrated pages render via `entry.render` behind one shared `Suspense`; every other mode keeps its existing ternary branch.** `approvals`, `digital_humans`, `credentials`, `automation`, chat/pet/settings overlays are untouched.

- [ ] **Step 1: Write the failing tests**

Extend `PageRegistry.test.ts`: add `import type { ReactElement } from "react";` to the imports at the top of the file, then append this describe block at the end:

```ts
describe("migrated builtin pages", () => {
  it("registers logs and runs as render-only pages (no nav item)", () => {
    const logs = PAGE_REGISTRY.get("logs")!;
    const runs = PAGE_REGISTRY.get("runs")!;
    expect(logs.nav).toBeUndefined();
    expect(runs.nav).toBeUndefined();
    expect(logs.render).toBeFunction();
    expect(runs.render).toBeFunction();
    // The sidebar nav must not grow.
    expect(PAGE_REGISTRY.navEntries().map((entry) => entry.key)).toEqual([
      "digital_humans",
      "automation",
      "credentials",
      "settings_page",
    ]);
  });

  it("threads the runs deep-link through the render context", () => {
    const element = PAGE_REGISTRY.get("runs")!.render!({
      runsInitialRunId: "run-42",
    }) as ReactElement<{ initialRunId?: string | null }>;
    expect(element.props.initialRunId).toBe("run-42");
  });
});
```

Append to `PageRegistry.contract.test.ts` (add `const app = readFileSync(join(import.meta.dir, "..", "App.tsx"), "utf-8");` at the top):

```ts
  test("App renders migrated pages through the registry, others via the legacy ternary", () => {
    expect(app).toContain("PAGE_REGISTRY");
    expect(app).toContain("runsInitialRunId");
    // Migrated branches are gone from the ternary chain…
    expect(app).not.toContain('view.viewMode === "logs"');
    expect(app).not.toContain('view.viewMode === "runs"');
    expect(app).not.toContain('import("./logs/LogsView")');
    expect(app).not.toContain('import("./runs/RunsView")');
    // …while unmigrated branches remain.
    expect(app).toContain('view.viewMode === "approvals"');
    expect(app).toContain('view.viewMode === "automation"');
    expect(app).toContain('view.viewMode === "credentials"');
    expect(app).toContain('view.viewMode === "digital_humans"');
    // Persisted registry keys survive loadView.
    expect(app).toContain("loadView((mode) => PAGE_REGISTRY.has(mode))");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/desktop/src/renderer/pages/`
Expected: FAIL — `logs`/`runs` not registered; App.tsx still has the ternary branches.

- [ ] **Step 3: Add lazy page entries to PageRegistry.ts**

Update the imports at the top of `PageRegistry.ts`:

```ts
import { createElement, lazy, type ReactNode } from "react";
import {
  KeyRound,
  PlayCircle,
  ScrollText,
  Settings,
  UsersRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";
```

Below the type declarations, before `BUILTIN_PAGE_ENTRIES`, add (same lazy idiom as App.tsx used — large, low-frequency pages stay off the chat startup path; the Suspense boundary lives in App):

```ts
const LogsView = lazy(() =>
  import("../logs/LogsView").then((module) => ({ default: module.LogsView })),
);
const RunsView = lazy(() =>
  import("../runs/RunsView").then((module) => ({ default: module.RunsView })),
);
```

Append two entries to `BUILTIN_PAGE_ENTRIES` (after the `settings_page` entry):

```ts
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
```

(Both keys exist: `panels.palette.openLogs` and `panels.palette.openRuns` at `packages/desktop/src/renderer/i18n/ns/panels.ts:198,200` (zh) and `:427,429` (en). No new i18n keys are needed.)

- [ ] **Step 4: Rework App.tsx**

4a. Delete the `LogsView` and `RunsView` lazy declarations (`App.tsx:129-134`). Keep `ApprovalsView`, `AutomationView`, `SettingsPage`, `CredentialsPage`, `DigitalHumansView`, `SessionPanelDock` as they are.

4b. Add the registry import next to the other renderer imports:

```ts
import { PAGE_REGISTRY } from "./pages/PageRegistry";
```

4c. `App.tsx:199` — accept persisted registry keys:

```ts
  const [view, setView] = useState<ViewState>(() => loadView((mode) => PAGE_REGISTRY.has(mode)));
```

4d. Near the other derived flags (`App.tsx:1834-1836`), add:

```ts
  // Re-render when pages register/unregister; builtin-only today, but the
  // seam is what plugin pages will use.
  React.useSyncExternalStore(PAGE_REGISTRY.subscribe, PAGE_REGISTRY.snapshot, PAGE_REGISTRY.snapshot);
  const registeredPageRender = !isPetView ? (PAGE_REGISTRY.get(view.viewMode)?.render ?? null) : null;
```

4e. In the main ternary chain: delete the two branches

```tsx
              ) : view.viewMode === "logs" ? (
                <React.Suspense fallback={<PageLoading label={t("ext.common.loading")} />}>
                  <LogsView />
                </React.Suspense>
```

and

```tsx
              ) : view.viewMode === "runs" ? (
                <React.Suspense fallback={<PageLoading label={t("ext.common.loading")} />}>
                  <RunsView initialRunId={runsInitialRunId} />
                </React.Suspense>
```

then insert the registry branch immediately after the `isPetView ? (…)` branch (before `view.viewMode === "approvals"`):

```tsx
              ) : registeredPageRender ? (
                <React.Suspense fallback={<PageLoading label={t("ext.common.loading")} />}>
                  {registeredPageRender({ runsInitialRunId })}
                </React.Suspense>
              ) : view.viewMode === "approvals" ? (
```

(`setViewMode("runs")` at `App.tsx:2007` and the CommandPalette `go.logs`/`go.approvals` routes keep working unchanged — the registry keys are the same `ViewMode` literals.)

- [ ] **Step 5: Run tests, typecheck, build**

Run: `bun test packages/desktop/src/renderer/pages/ packages/desktop/src/renderer/narrow-layout.smoke.test.tsx packages/desktop/src/renderer/AppPet.test.tsx`
Expected: PASS.

Run: `cd packages/desktop && bun run typecheck && bun run build`
Expected: no new typecheck errors; build succeeds (lazy chunk split for logs/runs moves into the PageRegistry chunk graph).

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/pages/PageRegistry.ts packages/desktop/src/renderer/pages/PageRegistry.test.ts packages/desktop/src/renderer/pages/PageRegistry.contract.test.ts packages/desktop/src/renderer/App.tsx
git commit -m "feat(desktop): migrate logs and runs pages onto the PageRegistry render seam"
```

---

### Task 5: Sandboxed panel icons — lucide-name allowlist

**Files:**
- Modify: `packages/core/src/plugins/installer/types.ts:11` (`PLUGIN_PANEL_ICONS`)
- Modify: `packages/desktop/src/shared/plugin-panels.ts:10` (`PluginPanelIconName`)
- Create: `packages/desktop/src/renderer/panels/pluginPanelIcons.ts`
- Modify: `packages/desktop/src/renderer/panels/PanelRegistry.ts` (delete `PLUGIN_ICONS` L256-262; use resolver L275; prune lucide imports L2-15)
- Test: `packages/core/src/plugins/installer/types.test.ts` (extend)
- Test: `packages/desktop/src/main/plugin-panel-icons.test.ts` (create — parity; main may import core, renderer may not)
- Test: `packages/desktop/src/renderer/panels/pluginPanelIcons.test.ts` (create)

The allowlist = 3 v1 semantic aliases (`panel`, `chart`, `table` — `activity`/`plug` are real lucide names already) + 84 kebab-case lucide names, all verified to exist as exports in the installed `lucide-react@^0.460.0` (`packages/desktop/node_modules/lucide-react/dist/lucide-react.d.ts`). 87 total (target band 50–100). Explicit static list — no dynamic lucide imports (bundle safety).

**The canonical 87-name list** (single source for all three files below; both arrays must be *identical*, enforced by the parity test):

```
panel, chart, table,
activity, alarm-clock, archive, bar-chart-3, bell, book-open, bot, box, brain, bug,
calendar, camera, check-circle-2, clipboard-list, clock, cloud, code-2, compass, cpu,
database, download, file-text, filter, flag, flame, folder-tree, gauge, git-branch,
git-compare, globe, graduation-cap, hammer, hard-drive, heart, history, home, image,
inbox, key-round, layers, layout-dashboard, library, lightbulb, line-chart, link,
list-checks, lock, mail, map, message-square, mic, monitor, moon, music, newspaper,
package, palette, panel-top, pie-chart, plug, puzzle, radar, rocket, search,
server-cog, settings, shield, shopping-cart, sparkles, square-terminal, star, table-2,
tag, target, terminal, timer, trending-up, trophy, users-round, wallet, wand-2, wifi,
wrench, zap
```

- [ ] **Step 1: Write the failing tests**

1a. Append to `packages/core/src/plugins/installer/types.test.ts` (inside `describe("PluginPanelsManifest")`):

```ts
  test("accepts allowlisted lucide icon names and keeps the panel default", () => {
    const panels = PluginPanelsManifest.parse({
      version: 1,
      entries: [
        { id: "a", title: { default: "A" }, entry: "panels/a.html", icon: "bar-chart-3" },
        { id: "b", title: { default: "B" }, entry: "panels/b.html" },
      ],
    });
    expect(panels.entries[0].icon).toBe("bar-chart-3");
    expect(panels.entries[1].icon).toBe("panel");
  });

  test("rejects icon names outside the allowlist", () => {
    expect(() =>
      PluginPanelsManifest.parse({
        version: 1,
        entries: [
          { id: "a", title: { default: "A" }, entry: "panels/a.html", icon: "grid-3x3" },
        ],
      }),
    ).toThrow();
  });
```

1b. Create `packages/desktop/src/main/plugin-panel-icons.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PLUGIN_PANEL_ICONS } from "@cjhyy/code-shell-core";
import { PLUGIN_PANEL_ICON_NAMES } from "../shared/plugin-panels.js";

describe("plugin panel icon allowlist", () => {
  test("desktop and core agree on the exact allowlist", () => {
    expect([...PLUGIN_PANEL_ICON_NAMES].sort()).toEqual([...PLUGIN_PANEL_ICONS].sort());
  });

  test("stays within the 50-100 explicit-name budget", () => {
    expect(PLUGIN_PANEL_ICON_NAMES.length).toBeGreaterThanOrEqual(50);
    expect(PLUGIN_PANEL_ICON_NAMES.length).toBeLessThanOrEqual(100);
  });
});
```

1c. Create `packages/desktop/src/renderer/panels/pluginPanelIcons.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PLUGIN_PANEL_ICON_NAMES } from "../../shared/plugin-panels";
import { PanelTop } from "lucide-react";
import { resolvePluginPanelIcon } from "./pluginPanelIcons";

describe("resolvePluginPanelIcon", () => {
  test("maps every allowlisted name to a lucide component", () => {
    for (const name of PLUGIN_PANEL_ICON_NAMES) {
      expect(resolvePluginPanelIcon(name)).toBeDefined();
    }
  });

  test("keeps the v1 semantic aliases stable", () => {
    expect(resolvePluginPanelIcon("panel")).toBe(PanelTop);
    expect(resolvePluginPanelIcon("chart")).toBe(resolvePluginPanelIcon("bar-chart-3"));
    expect(resolvePluginPanelIcon("table")).toBe(resolvePluginPanelIcon("table-2"));
  });

  test("falls back to the generic panel icon for unknown names", () => {
    expect(resolvePluginPanelIcon("grid-3x3")).toBe(PanelTop);
    expect(resolvePluginPanelIcon("")).toBe(PanelTop);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/plugins/installer/types.test.ts packages/desktop/src/main/plugin-panel-icons.test.ts packages/desktop/src/renderer/panels/pluginPanelIcons.test.ts`
Expected: FAIL — `"bar-chart-3"` rejected by zod; `PLUGIN_PANEL_ICON_NAMES` and `pluginPanelIcons.ts` don't exist.

- [ ] **Step 3: Extend core's allowlist**

Replace `packages/core/src/plugins/installer/types.ts:11`:

```ts
/**
 * Panel icon allowlist. First three are v1 semantic aliases kept for installed
 * manifests; the rest are kebab-case lucide icon names, mirrored verbatim in
 * packages/desktop/src/shared/plugin-panels.ts (parity-tested from desktop main).
 */
export const PLUGIN_PANEL_ICONS = [
  "panel",
  "chart",
  "table",
  "activity",
  "alarm-clock",
  "archive",
  "bar-chart-3",
  "bell",
  "book-open",
  "bot",
  "box",
  "brain",
  "bug",
  "calendar",
  "camera",
  "check-circle-2",
  "clipboard-list",
  "clock",
  "cloud",
  "code-2",
  "compass",
  "cpu",
  "database",
  "download",
  "file-text",
  "filter",
  "flag",
  "flame",
  "folder-tree",
  "gauge",
  "git-branch",
  "git-compare",
  "globe",
  "graduation-cap",
  "hammer",
  "hard-drive",
  "heart",
  "history",
  "home",
  "image",
  "inbox",
  "key-round",
  "layers",
  "layout-dashboard",
  "library",
  "lightbulb",
  "line-chart",
  "link",
  "list-checks",
  "lock",
  "mail",
  "map",
  "message-square",
  "mic",
  "monitor",
  "moon",
  "music",
  "newspaper",
  "package",
  "palette",
  "panel-top",
  "pie-chart",
  "plug",
  "puzzle",
  "radar",
  "rocket",
  "search",
  "server-cog",
  "settings",
  "shield",
  "shopping-cart",
  "sparkles",
  "square-terminal",
  "star",
  "table-2",
  "tag",
  "target",
  "terminal",
  "timer",
  "trending-up",
  "trophy",
  "users-round",
  "wallet",
  "wand-2",
  "wifi",
  "wrench",
  "zap",
] as const;
```

(`z.enum(PLUGIN_PANEL_ICONS).default("panel")` at `types.ts:47` needs no change — the enum widens automatically. `PLUGIN_PANEL_ICONS` is already re-exported from `packages/core/src/index.ts:425`.)

- [ ] **Step 4: Mirror in desktop shared and add the renderer resolver**

4a. Replace `packages/desktop/src/shared/plugin-panels.ts:10` (`export type PluginPanelIconName = …`) with the identical array + derived type:

```ts
/**
 * Icon allowlist — must stay byte-identical to core's PLUGIN_PANEL_ICONS
 * (packages/core/src/plugins/installer/types.ts). The renderer cannot import
 * core, so the list is mirrored and parity-tested from desktop main
 * (src/main/plugin-panel-icons.test.ts).
 */
export const PLUGIN_PANEL_ICON_NAMES = [
  "panel",
  "chart",
  "table",
  "activity",
  "alarm-clock",
  "archive",
  "bar-chart-3",
  "bell",
  "book-open",
  "bot",
  "box",
  "brain",
  "bug",
  "calendar",
  "camera",
  "check-circle-2",
  "clipboard-list",
  "clock",
  "cloud",
  "code-2",
  "compass",
  "cpu",
  "database",
  "download",
  "file-text",
  "filter",
  "flag",
  "flame",
  "folder-tree",
  "gauge",
  "git-branch",
  "git-compare",
  "globe",
  "graduation-cap",
  "hammer",
  "hard-drive",
  "heart",
  "history",
  "home",
  "image",
  "inbox",
  "key-round",
  "layers",
  "layout-dashboard",
  "library",
  "lightbulb",
  "line-chart",
  "link",
  "list-checks",
  "lock",
  "mail",
  "map",
  "message-square",
  "mic",
  "monitor",
  "moon",
  "music",
  "newspaper",
  "package",
  "palette",
  "panel-top",
  "pie-chart",
  "plug",
  "puzzle",
  "radar",
  "rocket",
  "search",
  "server-cog",
  "settings",
  "shield",
  "shopping-cart",
  "sparkles",
  "square-terminal",
  "star",
  "table-2",
  "tag",
  "target",
  "terminal",
  "timer",
  "trending-up",
  "trophy",
  "users-round",
  "wallet",
  "wand-2",
  "wifi",
  "wrench",
  "zap",
] as const;

export type PluginPanelIconName = (typeof PLUGIN_PANEL_ICON_NAMES)[number];
```

4b. Create `packages/desktop/src/renderer/panels/pluginPanelIcons.ts` — explicit static map, exhaustiveness enforced at compile time by `satisfies`:

```ts
import {
  Activity,
  AlarmClock,
  Archive,
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  Box,
  Brain,
  Bug,
  Calendar,
  Camera,
  CheckCircle2,
  ClipboardList,
  Clock,
  Cloud,
  Code2,
  Compass,
  Cpu,
  Database,
  Download,
  FileText,
  Filter,
  Flag,
  Flame,
  FolderTree,
  Gauge,
  GitBranch,
  GitCompare,
  Globe,
  GraduationCap,
  Hammer,
  HardDrive,
  Heart,
  History,
  Home,
  Image,
  Inbox,
  KeyRound,
  Layers,
  LayoutDashboard,
  Library,
  Lightbulb,
  LineChart,
  Link,
  ListChecks,
  Lock,
  Mail,
  Map,
  MessageSquare,
  Mic,
  Monitor,
  Moon,
  Music,
  Newspaper,
  Package,
  Palette,
  PanelTop,
  PieChart,
  Plug,
  Puzzle,
  Radar,
  Rocket,
  Search,
  ServerCog,
  Settings,
  Shield,
  ShoppingCart,
  Sparkles,
  SquareTerminal,
  Star,
  Table2,
  Tag,
  Target,
  Terminal,
  Timer,
  TrendingUp,
  Trophy,
  UsersRound,
  Wallet,
  Wand2,
  Wifi,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { PluginPanelIconName } from "../../shared/plugin-panels";

/** Explicit static allowlist map — no dynamic lucide imports (bundle safety). */
const PLUGIN_PANEL_ICON_MAP = {
  // v1 semantic aliases
  panel: PanelTop,
  chart: BarChart3,
  table: Table2,
  // lucide names
  activity: Activity,
  "alarm-clock": AlarmClock,
  archive: Archive,
  "bar-chart-3": BarChart3,
  bell: Bell,
  "book-open": BookOpen,
  bot: Bot,
  box: Box,
  brain: Brain,
  bug: Bug,
  calendar: Calendar,
  camera: Camera,
  "check-circle-2": CheckCircle2,
  "clipboard-list": ClipboardList,
  clock: Clock,
  cloud: Cloud,
  "code-2": Code2,
  compass: Compass,
  cpu: Cpu,
  database: Database,
  download: Download,
  "file-text": FileText,
  filter: Filter,
  flag: Flag,
  flame: Flame,
  "folder-tree": FolderTree,
  gauge: Gauge,
  "git-branch": GitBranch,
  "git-compare": GitCompare,
  globe: Globe,
  "graduation-cap": GraduationCap,
  hammer: Hammer,
  "hard-drive": HardDrive,
  heart: Heart,
  history: History,
  home: Home,
  image: Image,
  inbox: Inbox,
  "key-round": KeyRound,
  layers: Layers,
  "layout-dashboard": LayoutDashboard,
  library: Library,
  lightbulb: Lightbulb,
  "line-chart": LineChart,
  link: Link,
  "list-checks": ListChecks,
  lock: Lock,
  mail: Mail,
  map: Map,
  "message-square": MessageSquare,
  mic: Mic,
  monitor: Monitor,
  moon: Moon,
  music: Music,
  newspaper: Newspaper,
  package: Package,
  palette: Palette,
  "panel-top": PanelTop,
  "pie-chart": PieChart,
  plug: Plug,
  puzzle: Puzzle,
  radar: Radar,
  rocket: Rocket,
  search: Search,
  "server-cog": ServerCog,
  settings: Settings,
  shield: Shield,
  "shopping-cart": ShoppingCart,
  sparkles: Sparkles,
  "square-terminal": SquareTerminal,
  star: Star,
  "table-2": Table2,
  tag: Tag,
  target: Target,
  terminal: Terminal,
  timer: Timer,
  "trending-up": TrendingUp,
  trophy: Trophy,
  "users-round": UsersRound,
  wallet: Wallet,
  "wand-2": Wand2,
  wifi: Wifi,
  wrench: Wrench,
  zap: Zap,
} as const satisfies Record<PluginPanelIconName, LucideIcon>;

/** Descriptors are validated upstream (core zod), but stale/foreign values degrade gracefully. */
export function resolvePluginPanelIcon(name: string): LucideIcon {
  return (PLUGIN_PANEL_ICON_MAP as Record<string, LucideIcon>)[name] ?? PanelTop;
}
```

4c. In `packages/desktop/src/renderer/panels/PanelRegistry.ts`:
- Delete the `PLUGIN_ICONS` map (L256-262).
- Replace `icon: PLUGIN_ICONS[descriptor.icon],` (L275) with `icon: resolvePluginPanelIcon(descriptor.icon),`.
- Add `import { resolvePluginPanelIcon } from "./pluginPanelIcons";` and remove now-unused lucide imports from L2-15 (`Activity`, `BarChart3`, `PanelTop`, `Plug`, `Table2` — keep `Bot`, `FolderTree`, `GitCompare`, `Globe`, `ServerCog`, `SquareTerminal`, `type LucideIcon`).
- Remove `PluginPanelIconName` from the shared import on L18 if now unused.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/core/src/plugins/installer/types.test.ts packages/desktop/src/main/plugin-panel-icons.test.ts packages/desktop/src/renderer/panels/pluginPanelIcons.test.ts packages/desktop/src/renderer/panels/PanelRegistry.test.ts`
Expected: all PASS (PanelRegistry.test.ts confirms builtin dock panels untouched).

Run: `cd packages/desktop && bun run typecheck` and `cd packages/core && bun run build`
Expected: clean of new errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/plugins/installer/types.ts packages/core/src/plugins/installer/types.test.ts packages/desktop/src/shared/plugin-panels.ts packages/desktop/src/renderer/panels/pluginPanelIcons.ts packages/desktop/src/renderer/panels/pluginPanelIcons.test.ts packages/desktop/src/renderer/panels/PanelRegistry.ts packages/desktop/src/main/plugin-panel-icons.test.ts
git commit -m "feat(core,desktop): widen plugin panel icons to a validated lucide-name allowlist"
```

---

### Task 6: New panel permissions — workspace.info and notifications.send

**Files:**
- Modify: `packages/desktop/src/shared/plugin-panels.ts:3-8` (`PluginPanelPermission`)
- Modify: `packages/core/src/plugins/installer/types.ts:3-9` (`PLUGIN_PANEL_PERMISSIONS`; `max(8)` at L50 stays)
- Modify: `packages/desktop/src/main/plugin-panel-bridge.ts` (options, binding, dispatch, 2 handlers)
- Modify: `packages/desktop/src/main/index.ts:428-433` (wire `showNotification`; `Notification` already imported at L15)
- Test: `packages/desktop/tests/.fixtures/plugin-panel-main.test.ts` (extend, +2 tests)
- Modify: `packages/desktop/src/main/plugin-panel-protocol.test.ts:19` (`"10 pass"` → `"12 pass"`)
- Test: `packages/core/src/plugins/installer/types.test.ts` (extend)

Pattern source: `plugin-panel-bridge.ts` — `requirePermission` L234-238, dispatch switch L240-260, rate window L217-224, options.limits L34-41.

- [ ] **Step 1: Write the failing tests**

1a. Append to `packages/core/src/plugins/installer/types.test.ts` (inside `describe("PluginPanelsManifest")`):

```ts
  test("accepts the workspace.info and notifications.send permissions", () => {
    const panels = PluginPanelsManifest.parse({
      version: 1,
      entries: [
        {
          id: "a",
          title: { default: "A" },
          entry: "panels/a.html",
          permissions: ["workspace.info", "notifications.send"],
        },
      ],
    });
    expect(panels.entries[0].permissions).toEqual(["workspace.info", "notifications.send"]);
  });
```

1b. Append to `packages/desktop/tests/.fixtures/plugin-panel-main.test.ts` (inside `describe("PluginPanelBridge")`). Also extend the fixture's node:path import (`join` → `basename, join`):

```ts
  test("returns read-only workspace metadata with a best-effort git branch", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "csplugin-workspace-"));
    mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".git", "HEAD"), "ref: refs/heads/feature/x\n");
    try {
      const bridge = new PluginPanelBridge({
        isTrustedHost: () => true,
        isWorkspaceTrusted: (cwd) => cwd === workspaceRoot,
        getAgentBridge: () => null,
      });
      bridge.registerIpc();
      const guest = fakeGuest(14);
      bridge.registerGuest(
        guest as any,
        pluginPanelElectronMock.ownerWindow as any,
        bridgeResource(["workspace.info"]) as any,
      );
      await bindBridgeGuest(14, { cwd: workspaceRoot });
      const info = await pluginPanelElectronMock.ipcHandlers.get("plugin-panel:call")!(
        { sender: guest },
        "workspace.info",
        {},
      );
      expect(info).toEqual({
        name: basename(workspaceRoot),
        root: workspaceRoot,
        trusted: true,
        gitBranch: "feature/x",
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("sends title-prefixed system notifications under a dedicated per-window cap", async () => {
    const shown: { title: string; body: string }[] = [];
    const bridge = new PluginPanelBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
      getAgentBridge: () => null,
      showNotification: (notification) => {
        shown.push(notification);
        return true;
      },
      limits: { maxNotificationsPerWindow: 2, rateWindowMs: 60_000 },
    });
    bridge.registerIpc();
    const guest = fakeGuest(15);
    bridge.registerGuest(
      guest as any,
      pluginPanelElectronMock.ownerWindow as any,
      bridgeResource(["notifications.send"]) as any,
    );
    await bindBridgeGuest(15);
    const call = (params: unknown) =>
      pluginPanelElectronMock.ipcHandlers.get("plugin-panel:call")!(
        { sender: guest },
        "notifications.send",
        params,
      ) as Promise<unknown>;

    expect(await call({ body: "build finished" })).toBe(true);
    expect(await call({ title: "CI", body: "build finished" })).toBe(true);
    // The panel title always prefixes the notification: no app impersonation.
    expect(shown).toEqual([
      { title: "Dashboard", body: "build finished" },
      { title: "Dashboard: CI", body: "build finished" },
    ]);
    await expect(call({ body: "third" })).rejects.toThrow(/notification limit/);
    await expect(call({ body: "" })).rejects.toThrow(/non-empty body/);
  });
```

1c. In `packages/desktop/src/main/plugin-panel-protocol.test.ts:19`, change the expectation:

```ts
  expect(`${stdout}\n${stderr}`).toContain("12 pass");
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/desktop/src/main/plugin-panel-protocol.test.ts`
Expected: FAIL — fixture reports unknown method `workspace.info`, missing `showNotification` option, and pass count 10 ≠ 12.

Run: `bun test packages/core/src/plugins/installer/types.test.ts`
Expected: FAIL — `workspace.info` not in the permission enum.

- [ ] **Step 3: Extend the enums**

3a. `packages/core/src/plugins/installer/types.ts:3-9`:

```ts
export const PLUGIN_PANEL_PERMISSIONS = [
  "context.session",
  "context.workspace",
  "storage",
  "external.open",
  "agent.submitPrompt",
  "workspace.info",
  "notifications.send",
] as const;
```

(`permissions: z.array(z.enum(PLUGIN_PANEL_PERMISSIONS)).max(8)` at `types.ts:50` stays — cap remains 8; 7 total values now.)

3b. `packages/desktop/src/shared/plugin-panels.ts:3-8`:

```ts
export type PluginPanelPermission =
  | "context.session"
  | "context.workspace"
  | "storage"
  | "external.open"
  | "agent.submitPrompt"
  | "workspace.info"
  | "notifications.send";
```

- [ ] **Step 4: Implement the bridge handlers**

In `packages/desktop/src/main/plugin-panel-bridge.ts`:

4a. Imports (L2-4): add `basename` to the node:path import:

```ts
import { basename, dirname, join } from "node:path";
```

4b. Constants (after L19):

```ts
const MAX_NOTIFICATIONS_PER_WINDOW = 5;
```

4c. `GuestBinding` (L21-28): add two fields:

```ts
interface GuestBinding {
  guest: WebContents;
  ownerWindowId: number;
  resource: PluginPanelProtocolResource;
  context: PluginPanelHostContext;
  callTimes: number[];
  notifyTimes: number[];
  bucket?: string;
  /** Raw bound cwd, host-side only; context.cwd stays gated on context.workspace. */
  cwd?: string;
}
```

Initialize `notifyTimes: []` alongside `callTimes: []` in `registerGuest` (L93-107).

4d. `PluginPanelBridgeOptions` (L30-42): add the notification hook and limit:

```ts
export interface PluginPanelBridgeOptions {
  isTrustedHost(sender: WebContents): boolean;
  isWorkspaceTrusted(cwd: string): boolean;
  getAgentBridge(): AgentBridge | null;
  /** Shows a system notification; injected so tests avoid Electron Notification. */
  showNotification?(notification: { title: string; body: string }): boolean;
  limits?: Partial<{
    maxParamsBytes: number;
    maxResultBytes: number;
    maxCallsPerWindow: number;
    rateWindowMs: number;
    callTimeoutMs: number;
    storageQuotaBytes: number;
    maxNotificationsPerWindow: number;
  }>;
}
```

4e. `bindGuest` (after the cwd validation at L168-174, next to `binding.bucket = input.bucket;`):

```ts
    binding.cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : undefined;
```

4f. `dispatch` (L240-260): add two cases before `default`:

```ts
      case "workspace.info":
        this.requirePermission(binding, "workspace.info");
        return this.workspaceInfo(binding);
      case "notifications.send":
        this.requirePermission(binding, "notifications.send");
        return this.sendNotification(binding, params);
```

4g. New private methods (place after `submitPrompt`, L394-412):

```ts
  /** Read-only workspace metadata. Git branch is best-effort via .git/HEAD (no exec). */
  private async workspaceInfo(binding: GuestBinding): Promise<unknown> {
    const cwd = binding.cwd;
    if (!cwd) return { name: null, root: null, trusted: false, gitBranch: null };
    let gitBranch: string | null = null;
    try {
      const head = await readFile(join(cwd, ".git", "HEAD"), "utf-8");
      const match = /^ref: refs\/heads\/(.+)$/m.exec(head.trim());
      gitBranch = match ? match[1] : null;
    } catch {
      gitBranch = null;
    }
    return {
      name: basename(cwd),
      root: cwd,
      trusted: this.options.isWorkspaceTrusted(cwd),
      gitBranch,
    };
  }

  private sendNotification(binding: GuestBinding, params: unknown): boolean {
    const body = (params as { body?: unknown } | null)?.body;
    const title = (params as { title?: unknown } | null)?.title;
    if (typeof body !== "string" || body.trim().length === 0 || body.length > 500) {
      throw new Error("notifications.send requires a non-empty body up to 500 characters");
    }
    if (
      title !== undefined &&
      (typeof title !== "string" || title.length === 0 || title.length > 80)
    ) {
      throw new Error("notifications.send title must be 1-80 characters");
    }
    const limits = this.options.limits;
    const now = Date.now();
    binding.notifyTimes = binding.notifyTimes.filter(
      (time) => now - time < (limits?.rateWindowMs ?? RATE_WINDOW_MS),
    );
    if (
      binding.notifyTimes.length >=
      (limits?.maxNotificationsPerWindow ?? MAX_NOTIFICATIONS_PER_WINDOW)
    ) {
      throw new Error("plugin panel notification limit exceeded");
    }
    binding.notifyTimes.push(now);
    const show = this.options.showNotification;
    if (!show) throw new Error("system notifications are unavailable");
    // The trusted panel title always prefixes the shown title so a plugin
    // cannot impersonate the app or another plugin.
    return show({
      title: title
        ? `${binding.resource.descriptor.title}: ${title}`
        : binding.resource.descriptor.title,
      body: body.trim(),
    });
  }
```

(`readFile` is already imported at L3.)

4h. Wire the default in `packages/desktop/src/main/index.ts:428-433`:

```ts
const pluginPanelBridge = new PluginPanelBridge({
  isTrustedHost: (sender) =>
    [...mainWindows].some((window) => !window.isDestroyed() && window.webContents === sender),
  isWorkspaceTrusted: (cwd) => getTrustCachedSync(cwd) === "trusted",
  getAgentBridge: () => bridge,
  showNotification: ({ title, body }) => {
    if (!Notification.isSupported()) return false;
    // Best-effort, same as the app's own agent notifications (index.ts:1642).
    new Notification({ title, body }).show();
    return true;
  },
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/desktop/src/main/plugin-panel-protocol.test.ts packages/core/src/plugins/installer/types.test.ts packages/desktop/src/main/plugin-panel-icons.test.ts`
Expected: PASS — fixture reports 12 pass.

Run: `cd packages/desktop && bun run typecheck && cd ../core && bun run build`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/plugins/installer/types.ts packages/core/src/plugins/installer/types.test.ts packages/desktop/src/shared/plugin-panels.ts packages/desktop/src/main/plugin-panel-bridge.ts packages/desktop/src/main/index.ts packages/desktop/src/main/plugin-panel-protocol.test.ts packages/desktop/tests/.fixtures/plugin-panel-main.test.ts
git commit -m "feat(core,desktop): add workspace.info and notifications.send plugin panel permissions"
```

---

### Task 7: Documentation sync — docs/plugin-panels.md

**Files:**
- Modify: `docs/plugin-panels.md` (icon paragraph L117-118, permission table L142-150; the manifest example L87-109 stays valid)

The doc was refreshed on 2026-07-15/16 — apply targeted edits only, do not rewrite sections.

- [ ] **Step 1: Update the icon paragraph**

Replace L117-118:

```markdown
Supported icons are `panel`, `chart`, `table`, `activity`, and `plug`. A plugin can declare at most
16 panels. Panel ids must be unique within one manifest.
```

with:

```markdown
`icon` accepts the v1 semantic aliases (`panel`, `chart`, `table`) plus an explicit allowlist of
kebab-case [lucide](https://lucide.dev) icon names (for example `bar-chart-3`, `layout-dashboard`,
`git-branch`, `rocket`) — the authoritative list is `PLUGIN_PANEL_ICONS` in
`packages/core/src/plugins/installer/types.ts`. Unknown names are rejected at install time; hosts
fall back to the generic panel icon for anything stale. A plugin can declare at most 16 panels.
Panel ids must be unique within one manifest.
```

- [ ] **Step 2: Extend the permission table**

After the `agent.submitPrompt` row (L150), add:

```markdown
| `workspace.info`     | `workspace.info`; read-only workspace metadata: folder name, root path, trust state, and a best-effort git branch (read from `.git/HEAD`, never executed). |
| `notifications.send` | `notifications.send`; shows a system notification. The panel's manifest title always prefixes the shown title, and sends are capped per rate window on top of the shared call limit. |
```

- [ ] **Step 3: Verify and commit**

Run: `grep -n "workspace.info\|notifications.send\|bar-chart-3" docs/plugin-panels.md`
Expected: all three appear.

```bash
git add docs/plugin-panels.md
git commit -m "docs: document lucide icon allowlist and new plugin panel permissions"
```

---

## Final verification (before hand-off)

- [ ] `bun test` at the repo root — green (including the two updated contract tests and the 12-pass fixture).
- [ ] `bun run lint` at the repo root — green; specifically confirms the two ESLint hard boundaries (renderer imports no codeshell packages at runtime — `PageRegistry.ts`/`pluginPanelIcons.ts` import only react/lucide/relative modules; the core↛tui boundary is untouched).
- [ ] `cd packages/desktop && bun run typecheck && bun run build` — desktop has its own gates.
- [ ] `cd packages/core && bun run build` — core exports/zod changes compile.
- [ ] Manual smoke (or `node scripts/smoke-panels.mjs` via `bun run test:e2e` if time allows): sidebar shows 数字人/自动化/凭证/设置 in the same order with the same icons; command palette 打开日志 still lands on the logs page; automation → 查看运行 still deep-links into runs.
