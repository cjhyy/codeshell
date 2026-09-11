# Desktop renderer — UI conventions

## UI components (shadcn/ui + Tailwind)

The renderer uses **shadcn/ui + Tailwind v4** (neutral zinc theme). When writing
or editing renderer UI:

- **Use components from `@/components/ui`** (Button, Input, Select, Switch,
  Dialog, Card, …). Do **NOT** hand-write raw `<button>`, native `<select>`,
  `<input>`, custom switches, or modal/dialog markup.
- If a needed component is missing from `@/components/ui`, **add it first**
  (copy the shadcn source for it), then use it. Components are our own source —
  edit them freely.
- Style with **Tailwind utility classes** + the `cn()` helper from
  `@/lib/utils`. Use the semantic tokens (`bg-background`, `text-foreground`,
  `bg-primary`, `border-border`, `text-muted-foreground`, and the
  `*-status-running/ok/warn/err/idle` colors), not hard-coded hex.
- **Dark mode** is the `.dark` class on `<html>` (set by `theme.ts`). Use
  Tailwind's `dark:` variant; never read `[data-theme]` in new code.
- **Do NOT add new files under `src/renderer/styles/`** — those are legacy
  hand-written CSS being removed. New styling goes through Tailwind/components.

## Architecture reminder

The renderer is a thin client: host functionality crosses `window.codeshell.*`
(see `src/preload/index.ts`). Type-only core imports and the reviewed browser-safe
`@cjhyy/code-shell-core/browser/panel-app-runtime` runtime entry are allowed;
other core runtime imports are prohibited by ESLint.

The root typecheck includes Desktop's main/preload/renderer/mobile configs.
Desktop's build remains separate: run `bun run typecheck` and `bun run build`
in `packages/desktop` after UI changes.
