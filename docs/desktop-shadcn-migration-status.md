# Desktop UI — shadcn/Tailwind migration status

**Last updated:** 2026-06-15

Tracks the shadcn/ui + Tailwind v4 migration of `packages/desktop/src/renderer`.
Design spec: `docs/superpowers/specs/2026-05-31-desktop-shadcn-design.md`.

## TL;DR

- **Theme is unified.** Every screen renders in the **neutral-zinc + warm-orange (`#b85c2b`)** look. The remaining compatibility class rules now live in the single Tailwind entry, and dark mode is driven only by the `.dark` class.
- **Phase D file cleanup is complete.** `styles/tailwind.css` is the only renderer stylesheet under `styles/`; the old split CSS files, legacy `styles.css`, and unused `ui/Select.tsx` have been removed.

## What's done

- `styles/tailwind.css` — Tailwind v4 entry + shadcn zinc tokens (`:root`/`.dark`) + warm-orange `--primary`/`--ring` + status colors + shared component classes and the remaining compatibility rules formerly split across `styles/*.css`.
- `theme.ts` — uses only `.dark`; the old `[data-theme]` synchronization is gone.
- `components/ui/*` — 14 shadcn components + `SimpleSelect` adapter (`value/onChange/options` → shadcn Select; maps empty-string option → sentinel).
- **Fully migrated to Tailwind** (direct, no legacy classes): AutomationView, RunsView, SessionsView, ApprovalsView/ApprovalCard/RiskPill, ProjectPicker, ModelPill, PermissionPill, ContextRing, McpView, UpdaterBanner, DiscoverHome, ExtensionsPage, PluginsTab, SkillsTab, ManagePage, MarketList, MarketDetail, SkillDetailModal, Sidebar (shell + tree), ChatView (composer), App (shell layout grid→flex), TopBar, LogsView, SettingsView, SettingsPage, AgentsSection, AgentMessageView, ThinkingMessageView, AssistantMessageView, ContextBoundaryView, MessageStream (user/system rows), ToolCardShell, TaskListMessageView, TurnProcessGroupCard, StatusPopover.
- `styles/layout.css`, `styles/index.css`, `styles.css`, `styles/select.css`, and the old custom `ui/Select.tsx` — deleted.
- Bug fixes along the way: switch/button transparent background (legacy `button{background:none}` was unlayered and beat Tailwind — scoped it); Select black focus box (global `button:focus-visible` outline scoped off shadcn controls); Select dropdown clipping (collisionPadding + available-height); empty-string SelectItem crash (sentinel in SimpleSelect); `.approval-btn` invalid colors (re-styled in Tailwind layer); LogsView was never git-tracked (the global `logs/` ignore caught the source dir — added a negation).

## Remaining Compatibility Classes

Some older class names are still referenced by TSX, especially settings, MCP, diff, tool-card, ask-user, and command-palette surfaces. Their rules are consolidated in `styles/tailwind.css` so the app stays visually stable while those screens are migrated incrementally to direct Tailwind/shadcn markup.

Future UI work should not add new CSS files under `src/renderer/styles/`; add shadcn/Tailwind component rules to `styles/tailwind.css` only when a shared rule is genuinely needed.
