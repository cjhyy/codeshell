# `src/render/` — Code Shell Terminal Render Engine

This directory is **the rendering engine for Code Shell**. It is a React-based
terminal UI library: Yoga flexbox layout, virtual DOM reconciler, ANSI output
diffing, alt-screen + mouse + scroll support, IME-aware cursor parking.

## Status: self-maintained, no external upstream

This code originated as an extraction of an internal `ink` fork. **It is now
treated as first-party Code Shell code** — there is no public upstream to
`git pull` from, and no plan to chase external snapshots.

In practical terms:

- Bugs here are fixed in this repo.
- New components/features are added in this repo.
- Public-API stability is guaranteed *to Code Shell*, not to anyone else.
- The npm package `ink` is **not** a dependency and is unrelated.

## Public API

The application code (`src/cli/`, `src/ui/`, etc.) is expected to use only
the exports listed below. Internal files (everything else) may change shape
freely between commits.

### `src/render/index.ts`

| Export        | Kind      | Purpose                               |
| ------------- | --------- | ------------------------------------- |
| `Box`         | component | Flexbox container.                    |
| `Text`        | component | Styled text leaf.                     |
| `BoxProps`    | type      | Props for `Box`.                      |
| `useInput`    | hook      | Subscribe to keyboard input.          |
| `useApp`      | hook      | App lifecycle (exit, etc.).           |
| `useStdout`   | hook      | Imperative stdout writer + size.      |

### Other entry points

- `src/render/root.ts` — `render(node, options)` and `Instance` for mounting.
- `src/render/Ansi.tsx` — `<Ansi>` for embedding pre-rendered ANSI strings.
- `src/render/stringWidth.ts` — width-aware text measurement (CJK / emoji).

### Available but currently unused by app code

These exist and are stable, but the application has not adopted them yet:

- `<AlternateScreen>` — alt-screen entry + mouse tracking.
- `<ScrollBox>` + `ScrollBoxHandle` — virtual scroll viewport with sticky-bottom.

When `src/ui/` adopts these to fix the "scroll-to-top on render tick" issue,
they become part of the supported surface above.

## Internal layout (not stable, do not import directly)

```
src/render/
├── ink.tsx                     core renderer + frame diffing
├── reconciler.ts               React reconciler bindings
├── render-node-to-output.ts    Yoga layout → cell buffer
├── render-to-screen.ts         buffer diff → ANSI write
├── output.ts                   cell buffer + selection regions
├── dom.ts                      internal "DOM" for layout nodes
├── components/                 Box, Text, ScrollBox, AlternateScreen, ...
├── hooks/                      useInput, useStdout, useApp, ...
├── events/                     event system (paste, focus, ...)
├── termio/                     terminal I/O (CSI / OSC / mouse parsing)
├── parse-keypress.ts           keystroke + paste tokenization
├── selection.ts                fullscreen text-selection model
└── ...                         everything else is implementation detail
```

## Naming clash note

There is also `src/arena/render/` (Arena session rendering — business logic,
not UI rendering). The two are unrelated despite the shared name; keep them
distinct in code review and don't move files between them.

## How to evolve this

When changing `src/render/`:

1. If the change is internal-only (refactor, perf, bug fix that preserves
   behavior), no special process — treat it like any other code change.
2. If the change touches the **Public API** table above, update this README
   and search-replace consumers in the same commit.
3. Avoid pulling new abstractions in just because upstream `ink` or other
   forks have them. This engine should shrink over time, not grow.

## What this directory is *not*

- **Not** a vendored snapshot of `ink` from npm. It diverged long ago.
- **Not** a published library. No `package.json` of its own.
- **Not** a place for app-specific UI components — those go in `src/ui/`.
