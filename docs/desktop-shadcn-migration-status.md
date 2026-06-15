# Desktop UI — shadcn/Tailwind migration status

**Last updated:** 2026-06-15

Tracks the shadcn/ui + Tailwind v4 migration of `packages/desktop/src/renderer`.
Design spec: `docs/superpowers/specs/2026-05-31-desktop-shadcn-design.md`.

## TL;DR

- **Theme is unified.** Every screen renders in the **neutral-zinc + warm-orange (`#b85c2b`)** look. The remaining compatibility class rules now live in the single Tailwind entry, and dark mode is driven only by the `.dark` class.
- **Migration is complete.** `styles/tailwind.css` is the only renderer stylesheet under `styles/`; the old split CSS files, legacy `styles.css`, unused `ui/Select.tsx`, old `[data-theme]` sync, and consolidated compatibility layer have been removed.

## What's done

- `styles/tailwind.css` — Tailwind v4 entry + shadcn zinc tokens (`:root`/`.dark`) + warm-orange `--primary`/`--ring` + status colors + only the small shared primitives needed by shadcn/Radix controls.
- `theme.ts` — uses only `.dark`; the old `[data-theme]` synchronization is gone.
- `components/ui/*` — 14 shadcn components + `SimpleSelect` adapter (`value/onChange/options` → shadcn Select; maps empty-string option → sentinel).
- **Fully migrated to Tailwind/shadcn** (direct, no legacy stylesheet dependency): shell layout, chat/composer, tool cards, markdown rendering, assistant/agent/user/system messages, ask-user cards, file-change summaries, diff/review panels, browser/files/terminal panels, lightbox, automation, runs, sessions, approvals, extensions, logs, settings, MCP, memory, plugins/skills, command palette, search overlays, topbar/sidebar, and workspace trust.
- `styles/layout.css`, `styles/index.css`, all former split files under `styles/`, root `styles.css`, `styles/select.css`, and the old custom `ui/Select.tsx` — deleted.
- Bug fixes along the way: switch/button transparent background (legacy `button{background:none}` was unlayered and beat Tailwind — scoped it); Select black focus box (global `button:focus-visible` outline scoped off shadcn controls); Select dropdown clipping (collisionPadding + available-height); empty-string SelectItem crash (sentinel in SimpleSelect); `.approval-btn` invalid colors (re-styled in Tailwind layer); LogsView was never git-tracked (the global `logs/` ignore caught the source dir — added a negation).

## Completion Checks

- Renderer styles directory contains only `styles/tailwind.css`.
- No renderer TSX imports legacy CSS or the deleted `ui/Select.tsx`.
- No renderer TS/TSX references the old legacy CSS token aliases (`--bg-*`, `--fg-*`, `--status-*`, etc.).
- No renderer TSX uses the migrated legacy class families (`automation-*`, `mention-*`, `tool-group*`, `lightbox-*`, `mcp-*`, `memory-*`, `diff-*`, `ask-user*`, `tool-card*`, etc.).
- Native `button`/`input`/`select`/`textarea` usage outside shadcn UI wrappers has been removed from renderer TSX.

Future UI work should not add new CSS files under `src/renderer/styles/`; add Tailwind utilities in components first, and add a shared rule to `styles/tailwind.css` only when a Radix/shadcn primitive genuinely needs it.
