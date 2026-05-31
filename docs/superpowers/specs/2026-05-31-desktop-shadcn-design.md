# Desktop UI Overhaul — shadcn/ui + Tailwind (design)

**Date:** 2026-05-31
**Status:** approved (brainstorming)
**Scope:** `packages/desktop` renderer only. Main/preload/core untouched except where noted.

## Problem

The desktop renderer has **no UI component library** — ~6174 lines of hand-written CSS across `src/renderer/styles/*.css`, with every control (`<button>`, native `<select>`, `<input>`, custom switches, modals) hand-built. The result looks dated and inconsistent, and (because AI writes most UI code) there's nothing that makes an AI reuse a polished component instead of hand-rolling a new rough one each time.

## Goal

Adopt **shadcn/ui + Tailwind v4** as the desktop's component system, give it a **neutral (zinc) theme**, migrate the whole renderer off hand-written CSS, and add an **AI rule file** so future UI work reuses `@/components/ui` instead of raw elements.

## Decisions (locked in brainstorming)

| # | Decision |
|---|---|
| D1 | **shadcn/ui + Tailwind v4** via `@tailwindcss/vite` (Vite 7, no PostCSS config). |
| D2 | **Full migration** off hand-written CSS, **delivered in phases** (each phase leaves the app runnable). |
| D3 | **Shared base components first** (`@/components/ui/*`), then migrate pages. |
| D4 | **Neutral zinc theme** (shadcn default) — the existing warm orange/cream palette is dropped. |
| D5 | **Dark mode via Tailwind's `.dark` class** (replacing the current `[data-theme]` attribute); theme toggle code updated to match. |
| D6 | **Manual shadcn setup** (hand-author `components.json` + copy component source), NOT the `shadcn` CLI — the CLI assumes Next.js and breaks in an Electron+Vite monorepo. |
| D7 | **AI rule file** (CLAUDE.md): forbid raw `<button>/<select>/<input>`; require `@/components/ui`. |

## Current-state facts (verified against source)

- `packages/desktop/vite.config.ts`: `root` = `src/renderer`, has `react()` plugin + a `@renderer` alias. Renderer is a thin client (imports no core). → add `@tailwindcss/vite` plugin + `@` alias here.
- `packages/desktop/tsconfig.json`: no `paths`/`baseUrl`. → add `@/*` path.
- `src/renderer/main.tsx`: imports `./styles/index.css` (+ legacy `./styles.css`). → Tailwind entry CSS imported here; old CSS imports removed at the end of migration.
- `src/renderer/theme.ts:22`: `document.documentElement.setAttribute("data-theme", resolved)`. → change to `classList.toggle("dark", resolved === "dark")`.
- `src/renderer/styles/tokens.css`: defines tokens under `[data-theme="light"]` / `[data-theme="dark"]`. → replaced by shadcn CSS variables under `:root` / `.dark`.
- Main process CSP (`main/index.ts`) already allows `style-src 'self' 'unsafe-inline'` → Tailwind's injected styles are not blocked.
- Renderer build: `bun run build:renderer` (Vite); desktop has its own `tsc --noEmit`.

## Architecture

```
packages/desktop/
  src/renderer/
    styles/
      tailwind.css          ← NEW: @import "tailwindcss"; + @theme tokens (zinc) for :root/.dark
      (tokens.css, ui.css, …)  ← removed progressively; deleted in the final phase
    lib/
      utils.ts              ← NEW: cn() = twMerge(clsx(...))
    components/ui/          ← NEW: shadcn component source (button, select, switch,
                              dialog, input, card, dropdown-menu, …) — copied in, owned by us
    <existing pages>        ← migrated page-by-page to use @/components/ui + Tailwind classes
  components.json           ← NEW: shadcn config (style, aliases, tailwind paths)
  tsconfig.json             ← + paths { "@/*": ["src/renderer/*"] }
  vite.config.ts            ← + @tailwindcss/vite plugin, + "@" alias
  package.json              ← + tailwindcss, @tailwindcss/vite, class-variance-authority,
                              clsx, tailwind-merge, tw-animate-css, @radix-ui/react-* (per component)
```

**Why these boundaries:** `components/ui/*` are self-contained, own-our-source files (shadcn's model) so AI can read/modify them directly. `lib/utils.ts` is the single `cn()` helper every component imports. Pages depend only on `@/components/ui`, never on raw elements — that's what D7 enforces.

## Theme mapping (D4/D5)

shadcn semantic CSS variables defined with zinc values, in `tailwind.css`:

```css
:root {
  --background: 0 0% 100%;
  --foreground: 240 10% 3.9%;
  --card: 0 0% 100%;
  --primary: 240 5.9% 10%;
  --primary-foreground: 0 0% 98%;
  --muted: 240 4.8% 95.9%;
  --muted-foreground: 240 3.8% 46.1%;
  --border: 240 5.9% 90%;
  --ring: 240 5.9% 10%;
  /* …standard shadcn zinc set… */
}
.dark {
  --background: 240 10% 3.9%;
  --foreground: 0 0% 98%;
  /* …dark zinc set… */
}
```

The status colors that carry meaning (running/ok/warn/err) are preserved as semantic utilities (not dropped with the warm palette), mapped to standard green/amber/red/blue so run/automation status stays legible.

`theme.ts` change: `setAttribute("data-theme", resolved)` → `document.documentElement.classList.toggle("dark", resolved === "dark")`. The `system`/`light`/`dark` selection logic and localStorage persistence are unchanged.

## Phased delivery (D2/D3)

Each phase is its own PR and leaves the app building + running.

- **Phase A — Infrastructure.** Add deps; `@tailwindcss/vite` + `@` alias (vite + tsconfig); `tailwind.css` with zinc `:root`/`.dark`; `lib/utils.ts`; `components.json`; migrate `theme.ts` to `.dark`. Keep existing CSS imported alongside (coexists temporarily — Tailwind doesn't break plain CSS). **Acceptance:** app builds + runs unchanged; a throwaway `<Button>` renders styled.
- **Phase B — Base components.** Copy in the shadcn primitives the app needs: Button, Input, Textarea, Select, Switch, Dialog, Card, DropdownMenu, Badge, Tooltip, Tabs, ScrollArea, Separator, Label. Each with its `@radix-ui/react-*` dep. Add `components/ui/*` + a short Storybook-less demo route (or a dev-only gallery) to eyeball them. **Acceptance:** every base component renders in light + dark.
- **Phase C — Migrate pages (several PRs).** Convert pages to `@/components/ui` + Tailwind, deleting the corresponding `styles/*.css` as each page is done. Suggested order (leaf → shell): Automation page (already fresh) → Runs → Sessions → Settings sections → Approvals/Logs/Customize → TopBar/Sidebar/Inspector/App shell → Chat/Composer (largest, last). **Acceptance per PR:** migrated pages render in light+dark, no visual regressions vs intent, typecheck + renderer build green.
- **Phase D — Remove legacy CSS.** Delete now-unused `styles/*.css`, drop their imports from `main.tsx`, remove dead tokens. **Acceptance:** no `styles/*.css` remain except `tailwind.css`; build green; grep finds no raw `<button>/<select>` in pages (enforced by D7 rule + a lint check).

This spec covers **Phase A only** as the first implementation plan; B/C/D get their own plans once A lands.

## AI rule file (D7)

Add to `packages/desktop/CLAUDE.md` (create if absent):

> **UI components:** All renderer UI MUST use components from `@/components/ui` (shadcn). Do NOT hand-write raw `<button>`, `<select>`, `<input>`, custom switches, or modal/dialog markup. If a needed component is missing from `@/components/ui`, add it (copy the shadcn source) before using it. Styling uses Tailwind utility classes + the `cn()` helper from `@/lib/utils`; do not add new files under `src/renderer/styles/` (legacy, being removed).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Tailwind v4 + Vite 7 + Electron quirks | Use official `@tailwindcss/vite`; CSP already allows inline styles; Phase A is a tiny vertical slice that proves the toolchain before any page work. |
| Two style systems coexisting mid-migration looks inconsistent | Accepted, time-boxed; phase order is leaf→shell so the most-seen surfaces convert early; legacy CSS deleted in Phase D. |
| `.dark` migration breaks theming | `theme.ts` is the single toggle point (one line); verify light+dark after Phase A. |
| shadcn CLI assumptions (Next.js) | D6: manual setup, no CLI. |
| Losing meaningful status colors with the warm palette | Status green/amber/red/blue preserved as semantic utilities. |
| Bundle size from Radix deps | Per-component install (only what pages use); tree-shaken by Vite. |

## Out of scope

- Main/preload/core changes (renderer-only overhaul).
- New features or layout redesigns — this is a **re-skin + componentization**, not a UX redesign. Pages keep their structure; they get shadcn controls + zinc theme.
- Phases B/C/D detailed plans (separate plans after A).
