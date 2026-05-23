# Electron Codex UI — Phase 1: Shell Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current two-column MVP into a three-region Codex-style workspace shell (sidebar | main | inspector) with a top bar, design tokens, real sidebar navigation, theme support, and lucide-react icons — without changing chat behavior.

**Architecture:** CSS tokens drive light/dark themes via `data-theme` on `<html>`. `App.tsx` grows three new pieces of UI state (`viewMode`, `selection`, `sidebarCollapsed`/`inspectorCollapsed`) but the streaming/transcript reducer stays untouched. A new `shell/` folder holds `TopBar`, `Sidebar` (refactored), `InspectorPanel`, and `SidebarNav`. Styles split from one 519-line file into per-component files imported by `styles.css`.

**Tech Stack:** React 19, TypeScript, Vite, Electron 33, lucide-react (new dep), existing zustand-free state (Zustand arrives in Phase 2).

**Spec:** `docs/superpowers/specs/2026-05-24-electron-codex-ui-full-design.md` (§4 Layout, §5 Module Layout, §10 Visual System).

---

## Pre-flight

### Task 0: Branch + deps

**Files:**
- Modify: `packages/desktop/package.json`

- [ ] **Step 1: Create branch**

```bash
git checkout -b phase1-shell-foundation
```

- [ ] **Step 2: Add `lucide-react` to desktop deps**

Edit `packages/desktop/package.json`, in `"dependencies"` add:

```json
"lucide-react": "^0.460.0"
```

- [ ] **Step 3: Install**

```bash
bun install
```

Expected: lockfile updated, no errors.

- [ ] **Step 4: Verify renderer still typechecks**

```bash
cd packages/desktop && bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/package.json bun.lock
git commit -m "chore(desktop): add lucide-react for Phase 1 shell"
```

---

## Group A — CSS tokens and per-component split

### Task 1: Create `styles/tokens.css`

**Files:**
- Create: `packages/desktop/src/renderer/styles/tokens.css`

- [ ] **Step 1: Write tokens file**

Create `packages/desktop/src/renderer/styles/tokens.css`:

```css
/* Design tokens — single source of truth for colors, spacing, type.
   Themes flip values via [data-theme="dark"] on <html>. */

:root,
[data-theme="light"] {
  /* surface */
  --bg-app:        #fafaf9;
  --bg-sidebar:    #f0eee6;
  --bg-inspector:  #f5f3ec;
  --bg-elevated:   #ffffff;
  --bg-hover:      #e8e3d4;
  --bg-selected:   #e0dcc8;

  /* text */
  --fg-primary:    #1a1a1a;
  --fg-secondary:  #555555;
  --fg-muted:      #888888;
  --fg-inverse:    #ffffff;

  /* border */
  --border-subtle: #e6e3da;
  --border-strong: #cfcabc;

  /* accent */
  --accent:        #b85c2b;
  --accent-hover:  #a04e22;
  --accent-fg:     #ffffff;

  /* status */
  --status-running: #2b7fb8;
  --status-ok:      #2f8a4d;
  --status-warn:    #c48a18;
  --status-err:     #b8392b;
  --status-idle:    #888888;

  /* radius */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;

  /* spacing */
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-5: 24px;
  --sp-6: 32px;

  /* type */
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: "SF Mono", Menlo, Consolas, monospace;
  --fz-xs: 11px;
  --fz-sm: 12px;
  --fz-md: 13px;
  --fz-lg: 14px;
  --fz-xl: 16px;

  /* shadows */
  --shadow-1: 0 1px 2px rgba(0,0,0,0.06);
  --shadow-2: 0 4px 12px rgba(0,0,0,0.10);

  /* z */
  --z-modal: 1000;
  --z-popover: 900;
  --z-tooltip: 1100;

  /* topbar / sidebar widths */
  --topbar-h: 38px;
  --sidebar-w: 240px;
  --sidebar-w-collapsed: 48px;
  --inspector-w: 320px;
  --inspector-w-collapsed: 0px;
}

[data-theme="dark"] {
  --bg-app:        #1c1b18;
  --bg-sidebar:    #232220;
  --bg-inspector:  #1f1e1b;
  --bg-elevated:   #2a2926;
  --bg-hover:      #2f2e2a;
  --bg-selected:   #3a3833;

  --fg-primary:    #e7e5dc;
  --fg-secondary:  #b8b4a4;
  --fg-muted:      #7e7a6e;
  --fg-inverse:    #1a1a1a;

  --border-subtle: #2f2e2a;
  --border-strong: #45433d;

  --accent:        #d77a4d;
  --accent-hover:  #c46b40;
  --accent-fg:     #1a1a1a;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/desktop/src/renderer/styles/tokens.css
git commit -m "feat(desktop/renderer): introduce CSS design tokens"
```

### Task 2: Extract `base.css` from current `styles.css`

**Files:**
- Create: `packages/desktop/src/renderer/styles/base.css`

- [ ] **Step 1: Create file with global resets and body styles**

Create `packages/desktop/src/renderer/styles/base.css`:

```css
* { box-sizing: border-box; }

html, body, #root { height: 100vh; margin: 0; }

body {
  background: var(--bg-app);
  color: var(--fg-primary);
  font: var(--fz-lg)/1.5 var(--font-sans);
  -webkit-font-smoothing: antialiased;
}

pre {
  margin: 0;
  white-space: pre-wrap;
  font-family: var(--font-mono);
}

button {
  font-family: inherit;
  font-size: inherit;
  color: inherit;
  background: none;
  border: none;
  cursor: pointer;
}

button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
::-webkit-scrollbar-thumb {
  background: var(--border-strong);
  border-radius: 5px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/desktop/src/renderer/styles/base.css
git commit -m "feat(desktop/renderer): extract base global styles"
```

### Task 3: Extract `layout.css` (three-region grid)

**Files:**
- Create: `packages/desktop/src/renderer/styles/layout.css`

- [ ] **Step 1: Create file**

Create `packages/desktop/src/renderer/styles/layout.css`:

```css
/* Three-region grid:
   [ topbar               ]
   [ side | main | insp   ]
   Sidebar/inspector collapsible via data attrs on .app-grid. */

.app-grid {
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr var(--inspector-w);
  grid-template-rows: var(--topbar-h) 1fr;
  grid-template-areas:
    "topbar topbar topbar"
    "sidebar main inspector";
  height: 100vh;
  overflow: hidden;
}

.app-grid[data-sidebar="collapsed"] {
  grid-template-columns: var(--sidebar-w-collapsed) 1fr var(--inspector-w);
}

.app-grid[data-inspector="collapsed"] {
  grid-template-columns: var(--sidebar-w) 1fr 0;
}

.app-grid[data-sidebar="collapsed"][data-inspector="collapsed"] {
  grid-template-columns: var(--sidebar-w-collapsed) 1fr 0;
}

.topbar-region { grid-area: topbar; }
.sidebar-region { grid-area: sidebar; overflow: hidden; }
.main-region { grid-area: main; overflow: hidden; display: flex; flex-direction: column; }
.inspector-region { grid-area: inspector; overflow: hidden; }
```

- [ ] **Step 2: Commit**

```bash
git add packages/desktop/src/renderer/styles/layout.css
git commit -m "feat(desktop/renderer): three-region layout grid"
```

### Task 4: Create `styles/index.css` aggregator + wire into existing entry

**Files:**
- Create: `packages/desktop/src/renderer/styles/index.css`
- Modify: `packages/desktop/src/renderer/main.tsx`

- [ ] **Step 1: Create aggregator**

Create `packages/desktop/src/renderer/styles/index.css`:

```css
@import "./tokens.css";
@import "./base.css";
@import "./layout.css";
```

- [ ] **Step 2: Locate main.tsx import line**

```bash
grep -n "styles" packages/desktop/src/renderer/main.tsx
```

- [ ] **Step 3: Update import**

In `packages/desktop/src/renderer/main.tsx`, change:

```ts
import "./styles.css";
```

to:

```ts
import "./styles/index.css";
import "./styles.css"; // legacy; pruned in Task 14
```

- [ ] **Step 4: Run dev server smoke test**

```bash
cd packages/desktop && bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/styles/index.css packages/desktop/src/renderer/main.tsx
git commit -m "feat(desktop/renderer): wire new style aggregator alongside legacy"
```

### Task 5: Theme initialiser

**Files:**
- Create: `packages/desktop/src/renderer/theme.ts`
- Modify: `packages/desktop/src/renderer/main.tsx`

- [ ] **Step 1: Create theme helper**

Create `packages/desktop/src/renderer/theme.ts`:

```ts
export type Theme = "light" | "dark" | "system";

const KEY = "codeshell.theme";

export function loadTheme(): Theme {
  const raw = localStorage.getItem(KEY);
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return "system";
}

export function saveTheme(t: Theme): void {
  localStorage.setItem(KEY, t);
}

export function applyTheme(t: Theme): void {
  const resolved =
    t === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : t;
  document.documentElement.setAttribute("data-theme", resolved);
}

export function initTheme(): Theme {
  const t = loadTheme();
  applyTheme(t);
  if (t === "system") {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => applyTheme("system"));
  }
  return t;
}
```

- [ ] **Step 2: Initialize in main.tsx**

In `packages/desktop/src/renderer/main.tsx`, before `ReactDOM.createRoot`, add:

```ts
import { initTheme } from "./theme";
initTheme();
```

- [ ] **Step 3: Verify**

```bash
cd packages/desktop && bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/renderer/theme.ts packages/desktop/src/renderer/main.tsx
git commit -m "feat(desktop/renderer): light/dark theme via data-theme + system follow"
```

---

## Group B — Shell components

### Task 6: `ui/icons.tsx` lucide re-exports

**Files:**
- Create: `packages/desktop/src/renderer/ui/icons.tsx`

- [ ] **Step 1: Re-export curated icon set**

Create `packages/desktop/src/renderer/ui/icons.tsx`:

```tsx
export {
  MessageSquare,
  Search,
  Puzzle,
  Workflow,
  FolderPlus,
  X,
  ChevronDown,
  ChevronRight,
  PanelLeft,
  PanelRight,
  Sun,
  Moon,
  Monitor,
  Settings,
  ListChecks,
  ShieldAlert,
  Activity,
  Plug,
  ScrollText,
  GitBranch,
  Cpu,
  Lock,
  Unlock,
  Copy,
  ExternalLink,
  FileText,
  Plus,
  Square,
  Send,
} from "lucide-react";
```

- [ ] **Step 2: Commit**

```bash
git add packages/desktop/src/renderer/ui/icons.tsx
git commit -m "feat(desktop/renderer): centralized lucide icon re-exports"
```

### Task 7: `ui/Badge.tsx`, `ui/StatusDot.tsx`, `ui/IconButton.tsx`

**Files:**
- Create: `packages/desktop/src/renderer/ui/Badge.tsx`
- Create: `packages/desktop/src/renderer/ui/StatusDot.tsx`
- Create: `packages/desktop/src/renderer/ui/IconButton.tsx`
- Create: `packages/desktop/src/renderer/styles/ui.css`

- [ ] **Step 1: Create Badge**

Create `packages/desktop/src/renderer/ui/Badge.tsx`:

```tsx
import React from "react";

export function Badge({ count, tone = "default" }: { count: number; tone?: "default" | "warn" | "err" }) {
  if (count <= 0) return null;
  return <span className={`badge badge-${tone}`}>{count > 99 ? "99+" : count}</span>;
}
```

- [ ] **Step 2: Create StatusDot**

Create `packages/desktop/src/renderer/ui/StatusDot.tsx`:

```tsx
import React from "react";

export type Status = "idle" | "running" | "ok" | "warn" | "err";

export function StatusDot({ status, title }: { status: Status; title?: string }) {
  return <span className={`status-dot status-${status}`} title={title} aria-label={status} />;
}
```

- [ ] **Step 3: Create IconButton**

Create `packages/desktop/src/renderer/ui/IconButton.tsx`:

```tsx
import React from "react";

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
}

export function IconButton({ label, children, className = "", ...rest }: Props) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`icon-btn ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 4: Add ui.css**

Create `packages/desktop/src/renderer/styles/ui.css`:

```css
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  font-size: var(--fz-xs);
  font-weight: 600;
  background: var(--accent);
  color: var(--accent-fg);
}
.badge-warn { background: var(--status-warn); color: #1a1a1a; }
.badge-err  { background: var(--status-err); color: #fff; }

.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--status-idle);
}
.status-running { background: var(--status-running); animation: pulse 1.4s infinite ease-in-out; }
.status-ok      { background: var(--status-ok); }
.status-warn    { background: var(--status-warn); }
.status-err     { background: var(--status-err); }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  color: var(--fg-secondary);
}
.icon-btn:hover { background: var(--bg-hover); color: var(--fg-primary); }
.icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
```

- [ ] **Step 5: Append `@import "./ui.css";` to `styles/index.css`**

Edit `packages/desktop/src/renderer/styles/index.css`, add at end:

```css
@import "./ui.css";
```

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/ui packages/desktop/src/renderer/styles/ui.css packages/desktop/src/renderer/styles/index.css
git commit -m "feat(desktop/renderer): primitive UI components (Badge, StatusDot, IconButton)"
```

### Task 8: Replace stub `TopBar` with shell version

**Files:**
- Modify: `packages/desktop/src/renderer/TopBar.tsx`
- Create: `packages/desktop/src/renderer/styles/topbar.css`

- [ ] **Step 1: Rewrite TopBar**

Replace `packages/desktop/src/renderer/TopBar.tsx` with:

```tsx
import React from "react";
import { GitBranch, Cpu, Lock, Activity } from "./ui/icons";
import { StatusDot } from "./ui/StatusDot";

interface Props {
  repoName: string | null;
  sessionTitle: string | null;
  branch?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  promptTokens?: number;
  busy: boolean;
}

export function TopBar({
  repoName,
  sessionTitle,
  branch,
  model,
  permissionMode,
  promptTokens,
  busy,
}: Props) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="topbar-app">code-shell</span>
        {repoName && <span className="topbar-sep">/</span>}
        {repoName && <span className="topbar-repo">{repoName}</span>}
        {sessionTitle && <span className="topbar-sep">·</span>}
        {sessionTitle && <span className="topbar-session">{sessionTitle}</span>}
      </div>
      <div className="topbar-right">
        {branch && (
          <span className="topbar-chip" title="git branch">
            <GitBranch size={12} /> {branch}
          </span>
        )}
        {model && (
          <span className="topbar-chip" title="model">
            <Cpu size={12} /> {model}
          </span>
        )}
        {permissionMode && (
          <span className="topbar-chip" title="permission mode">
            <Lock size={12} /> {permissionMode}
          </span>
        )}
        {typeof promptTokens === "number" && (
          <span className="topbar-chip" title="context tokens">
            <Activity size={12} /> {promptTokens.toLocaleString()}
          </span>
        )}
        <StatusDot status={busy ? "running" : "idle"} title={busy ? "running" : "idle"} />
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Create topbar.css**

Create `packages/desktop/src/renderer/styles/topbar.css`:

```css
.topbar {
  height: var(--topbar-h);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--sp-3);
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--fz-md);
  user-select: none;
  gap: var(--sp-3);
}
.topbar-left, .topbar-right {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}
.topbar-app { font-weight: 600; color: var(--fg-primary); }
.topbar-sep { color: var(--fg-muted); }
.topbar-repo, .topbar-session {
  color: var(--fg-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
}
.topbar-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--fg-secondary);
  font-size: var(--fz-sm);
  border: 1px solid var(--border-subtle);
}
```

- [ ] **Step 3: Add @import to styles/index.css**

Append to `packages/desktop/src/renderer/styles/index.css`:

```css
@import "./topbar.css";
```

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/renderer/TopBar.tsx packages/desktop/src/renderer/styles/topbar.css packages/desktop/src/renderer/styles/index.css
git commit -m "feat(desktop/renderer): real TopBar with repo/session/branch/model/tokens chips"
```

### Task 9: `view.ts` — viewMode + sidebar/inspector collapsed state

**Files:**
- Create: `packages/desktop/src/renderer/view.ts`

- [ ] **Step 1: Define types and persistence**

Create `packages/desktop/src/renderer/view.ts`:

```ts
export type ViewMode =
  | "chat"
  | "sessions"
  | "approvals"
  | "runs"
  | "settings"
  | "mcp"
  | "logs";

const KEY = "codeshell.view";

export interface ViewState {
  viewMode: ViewMode;
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
}

const DEFAULT: ViewState = {
  viewMode: "chat",
  sidebarCollapsed: false,
  inspectorCollapsed: false,
};

export function loadView(): ViewState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    return { ...DEFAULT, ...(JSON.parse(raw) as Partial<ViewState>) };
  } catch {
    return DEFAULT;
  }
}

export function saveView(v: ViewState): void {
  localStorage.setItem(KEY, JSON.stringify(v));
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/desktop/src/renderer/view.ts
git commit -m "feat(desktop/renderer): viewMode + collapse state persistence"
```

### Task 10: `SidebarNav` (real nav with active state and badges)

**Files:**
- Create: `packages/desktop/src/renderer/SidebarNav.tsx`
- Create: `packages/desktop/src/renderer/styles/sidebar.css` (replacing legacy sidebar rules later in Task 14)

- [ ] **Step 1: Create SidebarNav**

Create `packages/desktop/src/renderer/SidebarNav.tsx`:

```tsx
import React from "react";
import {
  MessageSquare,
  ListChecks,
  ShieldAlert,
  Activity,
  Plug,
  ScrollText,
  Settings,
} from "./ui/icons";
import { Badge } from "./ui/Badge";
import type { ViewMode } from "./view";

interface NavBadges {
  approvals?: number;
  runs?: number;
}

interface Props {
  active: ViewMode;
  onSelect: (v: ViewMode) => void;
  badges?: NavBadges;
}

interface Item {
  id: ViewMode;
  label: string;
  Icon: React.ComponentType<{ size?: number }>;
  badge?: keyof NavBadges;
}

const ITEMS: Item[] = [
  { id: "chat", label: "对话", Icon: MessageSquare },
  { id: "sessions", label: "会话", Icon: ListChecks },
  { id: "approvals", label: "审批", Icon: ShieldAlert, badge: "approvals" },
  { id: "runs", label: "运行", Icon: Activity, badge: "runs" },
  { id: "mcp", label: "插件", Icon: Plug },
  { id: "logs", label: "日志", Icon: ScrollText },
  { id: "settings", label: "设置", Icon: Settings },
];

export function SidebarNav({ active, onSelect, badges = {} }: Props) {
  return (
    <nav className="sidebar-nav">
      {ITEMS.map(({ id, label, Icon, badge }) => {
        const count = badge ? badges[badge] ?? 0 : 0;
        return (
          <button
            key={id}
            className={`sidebar-nav-item${active === id ? " active" : ""}`}
            onClick={() => onSelect(id)}
            aria-current={active === id ? "page" : undefined}
          >
            <Icon size={14} />
            <span className="sidebar-nav-label">{label}</span>
            {count > 0 && <Badge count={count} />}
          </button>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 2: Create new sidebar.css**

Create `packages/desktop/src/renderer/styles/sidebar.css`:

```css
.sidebar {
  height: 100%;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-subtle);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: var(--sp-2) 0;
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  padding: 0 var(--sp-2);
  gap: 2px;
}

.sidebar-nav-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: 30px;
  padding: 0 var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: var(--fz-md);
  color: var(--fg-secondary);
  text-align: left;
}
.sidebar-nav-item:hover {
  background: var(--bg-hover);
  color: var(--fg-primary);
}
.sidebar-nav-item.active {
  background: var(--bg-selected);
  color: var(--fg-primary);
  font-weight: 500;
}
.sidebar-nav-label { flex: 1; }

.sidebar-divider {
  height: 1px;
  background: var(--border-subtle);
  margin: var(--sp-2) 0;
}

.sidebar-section-label {
  font-size: var(--fz-xs);
  color: var(--fg-muted);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  padding: 0 var(--sp-3);
  margin-bottom: var(--sp-1);
  user-select: none;
}

.sidebar-repos {
  display: flex;
  flex-direction: column;
  padding: 0 var(--sp-2);
  gap: 1px;
}

.sidebar-repo-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: 30px;
  padding: 0 var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: var(--fz-md);
  color: var(--fg-secondary);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sidebar-repo-item:hover { background: var(--bg-hover); }
.sidebar-repo-item.selected {
  background: var(--bg-selected);
  color: var(--fg-primary);
}
.repo-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.repo-remove {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  color: var(--fg-muted);
  font-size: var(--fz-lg);
  line-height: 1;
}
.repo-remove:hover { background: var(--border-subtle); color: var(--fg-primary); }

.sidebar-add {
  color: var(--fg-muted);
  font-style: italic;
}
.repo-empty {
  padding: var(--sp-2);
  color: var(--fg-muted);
  font-size: var(--fz-sm);
}

/* Collapsed-sidebar variant */
.app-grid[data-sidebar="collapsed"] .sidebar-nav-label,
.app-grid[data-sidebar="collapsed"] .sidebar-section-label,
.app-grid[data-sidebar="collapsed"] .sidebar-repos,
.app-grid[data-sidebar="collapsed"] .sidebar-divider { display: none; }
.app-grid[data-sidebar="collapsed"] .sidebar-nav-item {
  justify-content: center;
  padding: 0;
}
```

- [ ] **Step 3: Append import to styles/index.css**

```css
@import "./sidebar.css";
```

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/renderer/SidebarNav.tsx packages/desktop/src/renderer/styles/sidebar.css packages/desktop/src/renderer/styles/index.css
git commit -m "feat(desktop/renderer): SidebarNav with active state and badge slots"
```

### Task 11: Refactor `Sidebar.tsx` to embed `SidebarNav` and drop emoji items

**Files:**
- Modify: `packages/desktop/src/renderer/Sidebar.tsx`

- [ ] **Step 1: Replace Sidebar body**

Replace `packages/desktop/src/renderer/Sidebar.tsx` with:

```tsx
import React from "react";
import { X, Plus } from "./ui/icons";
import { SidebarNav } from "./SidebarNav";
import type { ViewMode } from "./view";

interface SidebarProps {
  repos: { id: string; name: string }[];
  activeRepoId: string | null;
  onSelectRepo: (id: string) => void;
  onAddRepo: () => void;
  onRemoveRepo: (id: string) => void;
  viewMode: ViewMode;
  onSelectView: (v: ViewMode) => void;
  approvalsBadge?: number;
  runsBadge?: number;
}

export function Sidebar({
  repos,
  activeRepoId,
  onSelectRepo,
  onAddRepo,
  onRemoveRepo,
  viewMode,
  onSelectView,
  approvalsBadge,
  runsBadge,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <SidebarNav
        active={viewMode}
        onSelect={onSelectView}
        badges={{ approvals: approvalsBadge, runs: runsBadge }}
      />

      <div className="sidebar-divider" />

      <div className="sidebar-section-label">项目</div>

      <div className="sidebar-repos">
        {repos.length === 0 && (
          <div className="repo-empty">点 + 添加你的第一个 repo</div>
        )}
        {repos.map((repo) => (
          <div
            key={repo.id}
            className={`sidebar-repo-item${activeRepoId === repo.id ? " selected" : ""}`}
            onClick={() => onSelectRepo(repo.id)}
          >
            <span className="repo-name">{repo.name}</span>
            <button
              className="repo-remove"
              aria-label="移除"
              title="移除"
              onClick={(e) => {
                e.stopPropagation();
                onRemoveRepo(repo.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <div className="sidebar-repo-item sidebar-add" onClick={onAddRepo}>
          <Plus size={12} /> 添加
        </div>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/desktop/src/renderer/Sidebar.tsx
git commit -m "feat(desktop/renderer): sidebar embeds SidebarNav, lucide icons replace emoji"
```

### Task 12: `InspectorPanel` with empty state and collapse button

**Files:**
- Create: `packages/desktop/src/renderer/InspectorPanel.tsx`
- Create: `packages/desktop/src/renderer/styles/inspector.css`

- [ ] **Step 1: Create InspectorPanel**

Create `packages/desktop/src/renderer/InspectorPanel.tsx`:

```tsx
import React from "react";
import { PanelRight } from "./ui/icons";
import { IconButton } from "./ui/IconButton";

interface Props {
  collapsed: boolean;
  onToggle: () => void;
}

export function InspectorPanel({ collapsed, onToggle }: Props) {
  if (collapsed) return null;
  return (
    <aside className="inspector">
      <div className="inspector-header">
        <span className="inspector-title">详情</span>
        <IconButton label="折叠详情" onClick={onToggle}>
          <PanelRight size={14} />
        </IconButton>
      </div>
      <div className="inspector-body">
        <div className="inspector-empty">
          <div className="inspector-empty-title">未选中</div>
          <div className="inspector-empty-hint">
            在左侧点击一条消息、工具或 diff 来查看详情
          </div>
        </div>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Create inspector.css**

Create `packages/desktop/src/renderer/styles/inspector.css`:

```css
.inspector {
  height: 100%;
  background: var(--bg-inspector);
  border-left: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.inspector-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border-subtle);
  height: var(--topbar-h);
}
.inspector-title {
  font-weight: 600;
  font-size: var(--fz-md);
  color: var(--fg-primary);
}
.inspector-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-3);
}
.inspector-empty {
  text-align: center;
  color: var(--fg-muted);
  padding: var(--sp-5) var(--sp-3);
}
.inspector-empty-title {
  font-size: var(--fz-md);
  margin-bottom: var(--sp-1);
}
.inspector-empty-hint {
  font-size: var(--fz-sm);
  line-height: 1.5;
}
```

- [ ] **Step 3: Append import to styles/index.css**

```css
@import "./inspector.css";
```

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/renderer/InspectorPanel.tsx packages/desktop/src/renderer/styles/inspector.css packages/desktop/src/renderer/styles/index.css
git commit -m "feat(desktop/renderer): Inspector panel shell with empty state"
```

---

## Group C — App wiring

### Task 13: Wire TopBar + InspectorPanel + viewMode + collapse into App

**Files:**
- Modify: `packages/desktop/src/renderer/App.tsx`

- [ ] **Step 1: Replace App.tsx**

Open `packages/desktop/src/renderer/App.tsx`. Replace the file with the following. (Carries existing reducer + transcripts wholesale; only the JSX shell + new state are added.)

```tsx
import React, { useEffect, useReducer, useRef, useState } from "react";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import { ChatView } from "./ChatView";
import { ApprovalModal } from "./ApprovalModal";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { InspectorPanel } from "./InspectorPanel";
import {
  applyStreamEvent,
  appendUserMessage,
  INITIAL_STATE,
  type MessagesReducerState,
  type ApprovalState,
} from "./types";
import { loadTranscript, saveTranscript } from "./transcripts";
import type {
  AgentLifecycleEvent,
  ApprovalRequestEnvelope,
} from "../preload/types";
import {
  loadRepos,
  saveRepos,
  loadActiveRepoId,
  saveActiveRepoId,
  makeRepoId,
  type Repo,
} from "./repos";
import { loadView, saveView, type ViewState, type ViewMode } from "./view";
import { PanelLeft } from "./ui/icons";
import { IconButton } from "./ui/IconButton";

type TranscriptsMap = Record<string, MessagesReducerState>;

const GLOBAL_KEY = "__global__";
function bucketKey(repoId: string | null): string {
  return repoId ?? GLOBAL_KEY;
}

type Action =
  | { type: "user_message"; repoKey: string; text: string }
  | { type: "stream"; repoKey: string; event: StreamEvent }
  | { type: "hydrate"; repoKey: string; state: MessagesReducerState };

function reducer(map: TranscriptsMap, action: Action): TranscriptsMap {
  if (action.type === "hydrate") {
    return { ...map, [action.repoKey]: action.state };
  }
  const current = map[action.repoKey] ?? INITIAL_STATE;
  const next =
    action.type === "user_message"
      ? appendUserMessage(current, action.text)
      : applyStreamEvent(current, action.event);
  if (next === current) return map;
  return { ...map, [action.repoKey]: next };
}

function App() {
  const [transcripts, dispatch] = useReducer(reducer, {} as TranscriptsMap);
  const [approval, setApproval] = useState<ApprovalState>(null);
  const [lifecycle, setLifecycle] = useState<string | null>(null);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set());
  const [repos, setRepos] = useState<Repo[]>(() => loadRepos());
  const [activeRepoId, setActiveRepoId] = useState<string | null>(() => loadActiveRepoId());
  const [view, setView] = useState<ViewState>(() => loadView());

  const activeRepoKey = bucketKey(activeRepoId);
  const runningRepoKeyRef = useRef<string | null>(null);

  useEffect(() => { saveRepos(repos); }, [repos]);
  useEffect(() => { saveActiveRepoId(activeRepoId); }, [activeRepoId]);
  useEffect(() => { saveView(view); }, [view]);

  useEffect(() => {
    if (transcripts[activeRepoKey]) return;
    const loaded = loadTranscript(activeRepoId);
    dispatch({ type: "hydrate", repoKey: activeRepoKey, state: loaded });
  }, [activeRepoKey, activeRepoId, transcripts]);

  useEffect(() => {
    const handle = setTimeout(() => {
      const s = transcripts[activeRepoKey];
      if (!s) return;
      const repoId = activeRepoKey === GLOBAL_KEY ? null : activeRepoKey;
      saveTranscript(repoId, s);
    }, 600);
    return () => clearTimeout(handle);
  }, [transcripts, activeRepoKey]);

  const state = transcripts[activeRepoKey] ?? INITIAL_STATE;
  const busy = busyKeys.has(activeRepoKey);
  const activeRepo = repos.find((r) => r.id === activeRepoId) ?? null;

  const setBusyForKey = (key: string, val: boolean): void => {
    setBusyKeys((prev) => {
      const had = prev.has(key);
      if (val === had) return prev;
      const next = new Set(prev);
      if (val) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const handleAddRepo = async (): Promise<void> => {
    window.codeshell.log("sidebar.add_clicked", {});
    const picked = await window.codeshell.pickDir();
    if (!picked) return;
    if (repos.some((r) => r.path === picked.path)) {
      const existing = repos.find((r) => r.path === picked.path);
      if (existing) setActiveRepoId(existing.id);
      return;
    }
    const next: Repo = {
      id: makeRepoId(),
      name: picked.name,
      path: picked.path,
      addedAt: Date.now(),
    };
    setRepos((prev) => [...prev, next]);
    setActiveRepoId(next.id);
    window.codeshell.log("repo.added", { id: next.id, path: next.path });
  };

  const handleRemoveRepo = (id: string): void => {
    setRepos((prev) => prev.filter((r) => r.id !== id));
    if (activeRepoId === id) setActiveRepoId(null);
    window.codeshell.log("repo.removed", { id });
  };

  useEffect(() => {
    window.codeshell.log("app.mount", { codeshellKeys: Object.keys(window.codeshell ?? {}) });

    const offStream = window.codeshell.onStreamEvent((event: StreamEvent) => {
      const targetKey = runningRepoKeyRef.current ?? GLOBAL_KEY;
      const noisy =
        event.type === "text_delta" ||
        event.type === "tool_use_args_delta" ||
        event.type === "usage_update" ||
        event.type === "thinking_delta";
      if (!noisy) {
        window.codeshell.log("stream.event", { type: event.type, targetKey });
      }
      dispatch({ type: "stream", repoKey: targetKey, event });
      if (event.type === "turn_complete" || event.type === "error") {
        setBusyForKey(targetKey, false);
        runningRepoKeyRef.current = null;
      }
    });
    const offApproval = window.codeshell.onApprovalRequest((env: ApprovalRequestEnvelope) => {
      window.codeshell.log("approval.request", { requestId: env.requestId, toolName: env.request.toolName });
      setApproval(env);
    });
    const offStatus = window.codeshell.onStatus((evt) => {
      window.codeshell.log("status", evt as Record<string, unknown>);
    });
    const offLifecycle = window.codeshell.onAgentLifecycle((evt: AgentLifecycleEvent) => {
      window.codeshell.log("lifecycle", evt as Record<string, unknown>);
      const runningKey = runningRepoKeyRef.current;
      if (evt.type === "restarted") setLifecycle("Agent restarted.");
      else if (evt.type === "gave_up") setLifecycle("Agent crashed too many times. Quit and reopen.");
      else if (evt.type === "exited") {
        if (evt.code === 0) setLifecycle(null);
        else setLifecycle(`Agent exited (code ${evt.code}).`);
        if (runningKey) setBusyForKey(runningKey, false);
        runningRepoKeyRef.current = null;
      }
    });
    return () => {
      offStream();
      offApproval();
      offStatus();
      offLifecycle();
    };
  }, []);

  const send = (text: string): void => {
    const targetKey = activeRepoKey;
    window.codeshell.log("send", { textLen: text.length, repo: activeRepo?.name ?? null, targetKey });
    dispatch({ type: "user_message", repoKey: targetKey, text });
    setBusyForKey(targetKey, true);
    runningRepoKeyRef.current = targetKey;
    void window.codeshell
      .run(text, activeRepo ? { cwd: activeRepo.path } : undefined)
      .then((r) =>
        window.codeshell.log("run.resolved", { result: r as unknown as Record<string, unknown> }),
      );
  };

  const stop = (): void => {
    window.codeshell.log("stop.click", {});
    void window.codeshell.cancel();
  };

  const decide = (decision: "approve" | "deny", reason?: string): void => {
    if (!approval) return;
    void window.codeshell.approve(approval.requestId, decision, reason);
    setApproval(null);
  };

  const showWelcome = state.messages.length === 0;

  const setViewMode = (v: ViewMode): void => setView((prev) => ({ ...prev, viewMode: v }));
  const toggleSidebar = (): void =>
    setView((p) => ({ ...p, sidebarCollapsed: !p.sidebarCollapsed }));
  const toggleInspector = (): void =>
    setView((p) => ({ ...p, inspectorCollapsed: !p.inspectorCollapsed }));

  return (
    <div
      className="app-grid"
      data-sidebar={view.sidebarCollapsed ? "collapsed" : "open"}
      data-inspector={view.inspectorCollapsed ? "collapsed" : "open"}
    >
      <div className="topbar-region">
        <TopBar
          repoName={activeRepo?.name ?? null}
          sessionTitle={null}
          branch={null}
          model={null}
          permissionMode={null}
          promptTokens={undefined}
          busy={busy}
        />
      </div>

      <div className="sidebar-region">
        <Sidebar
          repos={repos}
          activeRepoId={activeRepoId}
          onSelectRepo={setActiveRepoId}
          onAddRepo={() => { void handleAddRepo(); }}
          onRemoveRepo={handleRemoveRepo}
          viewMode={view.viewMode}
          onSelectView={setViewMode}
          approvalsBadge={approval ? 1 : 0}
          runsBadge={busy ? 1 : 0}
        />
      </div>

      <main className="main-region main">
        <div className="main-toolbar">
          <IconButton label={view.sidebarCollapsed ? "展开侧栏" : "折叠侧栏"} onClick={toggleSidebar}>
            <PanelLeft size={14} />
          </IconButton>
          <span className="main-toolbar-spacer" />
          <IconButton
            label={view.inspectorCollapsed ? "展开详情" : "折叠详情"}
            onClick={toggleInspector}
          >
            <PanelLeft size={14} style={{ transform: "scaleX(-1)" }} />
          </IconButton>
        </div>
        {lifecycle && <div className="banner">{lifecycle}</div>}
        {view.viewMode === "chat" ? (
          <>
            {showWelcome && (
              <div className="welcome">
                <div className="welcome-title">
                  {activeRepo ? activeRepo.name : "code-shell"}
                </div>
                <div className="welcome-hint">
                  {activeRepoId === null
                    ? "先在左侧添加一个项目"
                    : "开始一个新对话 — 试试: 列出当前目录"}
                </div>
              </div>
            )}
            <ChatView
              messages={state.messages}
              onSend={send}
              onStop={stop}
              busy={busy}
              activeRepoId={activeRepoId}
            />
          </>
        ) : (
          <div className="view-placeholder">
            <div className="view-placeholder-title">{viewLabel(view.viewMode)}</div>
            <div className="view-placeholder-hint">该视图将在后续阶段实现</div>
          </div>
        )}
        {approval && <ApprovalModal envelope={approval} onDecide={decide} />}
      </main>

      <div className="inspector-region">
        <InspectorPanel collapsed={view.inspectorCollapsed} onToggle={toggleInspector} />
      </div>
    </div>
  );
}

function viewLabel(v: ViewMode): string {
  switch (v) {
    case "sessions": return "会话";
    case "approvals": return "审批";
    case "runs": return "运行";
    case "mcp": return "插件";
    case "logs": return "日志";
    case "settings": return "设置";
    default: return v;
  }
}

export { App };
export default App;
```

- [ ] **Step 2: Add toolbar/placeholder CSS to `styles/layout.css`**

Append to `packages/desktop/src/renderer/styles/layout.css`:

```css
.main-toolbar {
  display: flex;
  align-items: center;
  height: 32px;
  padding: 0 var(--sp-2);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-app);
  gap: var(--sp-1);
}
.main-toolbar-spacer { flex: 1; }

.view-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--fg-muted);
  gap: var(--sp-2);
}
.view-placeholder-title {
  font-size: var(--fz-xl);
  color: var(--fg-secondary);
}
.view-placeholder-hint {
  font-size: var(--fz-sm);
}
```

- [ ] **Step 3: Typecheck**

```bash
cd packages/desktop && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/styles/layout.css
git commit -m "feat(desktop/renderer): three-region App shell with TopBar/Inspector/viewMode"
```

### Task 14: Retire legacy `styles.css` rules now covered by per-component files

**Files:**
- Modify: `packages/desktop/src/renderer/styles.css`
- Modify: `packages/desktop/src/renderer/main.tsx`

- [ ] **Step 1: Identify orphaned rules**

```bash
grep -nE "^\.(app-grid|sidebar|sidebar-menu|sidebar-divider|sidebar-section-label|sidebar-repos|sidebar-repo-item|repo-name|repo-remove|sidebar-add|repo-empty|topbar)" packages/desktop/src/renderer/styles.css
```

- [ ] **Step 2: Delete those blocks**

Open `packages/desktop/src/renderer/styles.css` and remove every rule whose selector matches the regex from Step 1 (these are now in `styles/layout.css`, `styles/sidebar.css`, `styles/topbar.css`). Leave chat/welcome/banner/markdown/tool blocks intact — Phase 2/3 owns those.

- [ ] **Step 3: Drop the legacy import**

In `packages/desktop/src/renderer/main.tsx`, remove the line:

```ts
import "./styles.css"; // legacy; pruned in Task 14
```

…and keep:

```ts
import "./styles/index.css";
```

…BUT also append to `styles/index.css` to preserve remaining legacy rules during transition:

Add to `packages/desktop/src/renderer/styles/index.css`:

```css
@import "../styles.css";
```

- [ ] **Step 4: Verify dev build**

```bash
cd packages/desktop && bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/styles.css packages/desktop/src/renderer/main.tsx packages/desktop/src/renderer/styles/index.css
git commit -m "refactor(desktop/renderer): prune legacy CSS now covered by per-component files"
```

---

## Group D — Verification

### Task 15: Manual smoke test

- [ ] **Step 1: Run desktop dev**

```bash
cd packages/desktop && bun run dev
```

- [ ] **Step 2: Verify checklist in app window**

In the launched Electron window, confirm:

1. TopBar shows "code-shell" with no repo selected; status dot is idle (grey).
2. Sidebar shows 7 nav items (对话/会话/审批/运行/插件/日志/设置) with lucide icons.
3. Clicking each nav item switches the main region. "对话" shows the chat; others show the placeholder.
4. Click + 添加, pick a folder, repo appears in list. TopBar shows the repo name.
5. Click the left panel button in main toolbar — sidebar collapses to a thin rail with only icons.
6. Click the right panel button — inspector hides.
7. Send a message in chat view, observe streaming and status dot turning blue while busy.
8. `localStorage` keys present: `codeshell.theme`, `codeshell.view`.
9. Toggle OS appearance (System Preferences → Appearance → Dark) → app switches theme.

If any item fails, fix in the relevant Task file and re-commit before proceeding.

- [ ] **Step 3: Commit any followup**

```bash
git add -A
git commit -m "fix(desktop/renderer): Phase 1 smoke-test followups" --allow-empty
```

### Task 16: PR

- [ ] **Step 1: Push**

```bash
git push -u origin phase1-shell-foundation
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "desktop: Phase 1 — Codex-style UI shell foundation" --body "$(cat <<'EOF'
## Summary
- Three-region layout (sidebar | main | inspector) replaces two-column MVP
- Real TopBar with repo/session/branch/model/mode/tokens chips and status dot
- CSS tokens + per-component CSS files; light/dark themes via `data-theme`
- SidebarNav with active state and badge slots; lucide-react icons replace emoji
- InspectorPanel shell with empty state; both side columns collapsible
- New `viewMode` state switches main between chat and placeholders for sessions/approvals/runs/mcp/logs/settings

## Test plan
- [x] Type-check passes
- [x] Smoke checklist in Task 15 passes
- [ ] Light/dark theme verified
- [ ] Sidebar/Inspector collapse persists across reload
EOF
)"
```

---

## Self-review

- Spec §4 layout: covered Tasks 3, 13.
- Spec §5 `shell/` and `ui/` modules: covered Tasks 6-12.
- Spec §10 visual system tokens + themes: covered Tasks 1, 5, 7.
- Spec P0 items "Wire TopBar", "Add InspectorPanel", "Make sidebar nav real", "Active repo header", "Approval badge", "Model/permission/context indicators": Tasks 8, 11, 12, 13.
- No TBDs; every step has runnable code or commands.
- Type consistency: `ViewMode` defined once in `view.ts` and reused in `SidebarNav`, `Sidebar`, `App`.
- Out of scope for this plan (deliberately deferred): Zustand store, expanded Message types, stream event coverage, tool cards, Inspector content, diff, approval queue, settings, runs, search, palette, packaging — each gets its own Phase plan.
