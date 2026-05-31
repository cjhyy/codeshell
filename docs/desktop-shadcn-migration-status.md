# Desktop UI — shadcn/Tailwind migration status

**Last updated:** 2026-06-01

Tracks the shadcn/ui + Tailwind v4 migration of `packages/desktop/src/renderer`.
Design spec: `docs/superpowers/specs/2026-05-31-desktop-shadcn-design.md`.

## TL;DR

- **Theme is unified.** Every screen renders in the **plain, neutral-zinc + warm-orange (`#b85c2b`)** look — including pages still on legacy CSS — because the legacy design tokens (`--bg-app`, `--fg-primary`, `--accent`, `--border-subtle`, …) are **remapped onto the shadcn token set** in `styles/tokens.css`. Dark mode flows from the `.dark` class.
- **Phase D (physically deleting legacy CSS files) is intentionally DEFERRED**, per user request ("先不用删除 legacy 了,先标记一下"). The legacy `styles/*.css` files stay; they are theme-correct and coexist with the migrated components. **Do NOT delete them** until the remaining consumers (below) are migrated and re-verified in the running app.

## What's done

- `styles/tailwind.css` — Tailwind v4 entry + shadcn zinc tokens (`:root`/`.dark`) + warm-orange `--primary`/`--ring` + status colors + a `@layer components` block holding shared classes (cs-switch, tool-card-*, settings-*, customize-*, approval-btn).
- `styles/tokens.css` — legacy token names remapped to shadcn tokens (the lever that themed everything at once).
- `components/ui/*` — 14 shadcn components + `SimpleSelect` adapter (`value/onChange/options` → shadcn Select; maps empty-string option → sentinel).
- **Fully migrated to Tailwind** (direct, no legacy classes): AutomationView, RunsView, SessionsView, ApprovalsView/ApprovalCard/RiskPill, ProjectPicker, ModelPill, PermissionPill, ContextRing, McpView, UpdaterBanner, DiscoverHome, ExtensionsPage, PluginsTab, SkillsTab, ManagePage, MarketList, MarketDetail, SkillDetailModal, Sidebar (shell + tree), ChatView (composer), App (shell layout grid→flex), TopBar, LogsView, SettingsView, SettingsPage, AgentsSection, AgentMessageView, ThinkingMessageView, AssistantMessageView, ContextBoundaryView, MessageStream (user/system rows), ToolCardShell, TaskListMessageView, TurnProcessGroupCard, StatusPopover.
- `styles/layout.css` — deleted (App shell migrated to flex).
- Bug fixes along the way: switch/button transparent background (legacy `button{background:none}` was unlayered and beat Tailwind — scoped it); Select black focus box (global `button:focus-visible` outline scoped off shadcn controls); Select dropdown clipping (collisionPadding + available-height); empty-string SelectItem crash (sentinel in SimpleSelect); `.approval-btn` invalid colors (re-styled in Tailwind layer); LogsView was never git-tracked (the global `logs/` ignore caught the source dir — added a negation).

## Remaining legacy-CSS consumers (DO NOT delete these files yet)

Live class count per legacy file (live = still referenced in a `.tsx`). The big
ones gate Phase D:

| file | live classes | blocking consumers (not yet migrated to Tailwind) |
|---|---|---|
| `settings-page.css` | 52 | ModelSection, McpSection, AdvancedSections, CapabilitiesOverviewSection, archived/cap-overview/git rows |
| `views.css` | 50 | ModelSection (model list/add), MemorySection |
| `tool-cards.css` | 48 | per-tool detail bodies (File/Bash/Search/Web/Agent), ToolGroupCard, FilesChangedCard, AttachmentCard, diff bits |
| `mcp.css` | 37 | McpSection editor/modal/tool-list |
| `customize-page.css` | 36 | PluginsAndSkillsSection (plugin/skill rows, detail panes) |
| `composer.css` | 33 | BranchPicker, MentionPopover, GoalToggle, a few composer leftovers |
| `connections.css` | 22 | SearchConnectionsPanel |
| `inspector.css` | 19 | InspectorPanel |
| `github-install.css` | 19 | github skill install flow |
| `select.css` | 18 | the old custom `ui/Select.tsx` (now unused by app code — verify before deleting) |
| `palette.css` | 18 | CommandPalette |
| `diff.css` | 16 | diff viewer / changed-files |
| `ask-user.css` | 15 | AskUserMessageView |
| smaller (`session-search`, `settings-menu`, `confirm`, `markdown`, `sidebar`, `ui`, `approval`, `attachments`, `skills-grouped`, `extensions`, `messages`, `topbar`, `base`) | ≤11 each | misc; several are nearly dead (messages/topbar/extensions have 1 live class) |

`tokens.css` must stay regardless (it provides the remapped variables every legacy class reads). `markdown.css` is genuine markdown rendering, likely keep.

## How to finish Phase D later (safely)

For each legacy file: migrate its remaining `.tsx` consumers to Tailwind (or move the shared rules into `tailwind.css`'s `@layer components`), confirm `node`-audit shows **0 live classes**, then delete the file + its `@import` in `styles/index.css`. **Verify each in the running Electron app** — `bunx tsc --noEmit` + `bun run build:renderer` pass even when a class silently lost its styling, so visual/interaction regressions only show up live (this migration hit several: switch color, black border, faded buttons).
