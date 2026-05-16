# `src/render/` — CodeShell Terminal Render Engine

A React-based terminal UI runtime: Yoga flexbox layout, virtual DOM reconciler,
ANSI output diffing, alt-screen + mouse + scroll support, IME-aware cursor
parking.

## Status: self-maintained, no external upstream

This code originated as an extraction of an internal `ink` fork. It is now
treated as first-party CodeShell code — no public upstream to track, the npm
package `ink` is **not** a dependency.

## Public API

`src/ui/` and other application code must import only from `src/render/index.ts`
(or other entry points marked here). Files in `src/render/` not listed below are
**internal**: shape may change between commits.

Three states:

- **supported** — UI may depend on it. Removing or renaming requires updating
  callers in the same commit. Stable within minor versions.
- **experimental** — UI may use it explicitly. Shape may change; document
  changes in the commit.
- **internal** — UI must not import. Refactor freely.

### Components

| Export             | Status        | Purpose                                          |
| ------------------ | ------------- | ------------------------------------------------ |
| `Box`              | supported     | Flexbox container.                               |
| `Text`             | supported     | Styled text leaf.                                |
| `Spacer`           | supported     | Flexible spacer in a flex container.             |
| `Newline`          | supported     | Hard line break inside a `Text`.                 |
| `ScrollBox`        | supported     | Viewport scroll container; imperative handle.    |
| `AlternateScreen`  | supported     | Enter alt-screen + mouse tracking + raw input.   |
| `Ansi`             | supported     | Embed a pre-rendered ANSI string.                |
| `NoSelect`         | supported     | Mark a region non-selectable in fullscreen copy. |
| `Button`           | experimental  | Click/keyboard activatable region.               |
| `Link`             | experimental  | OSC 8 hyperlink wrapper.                         |
| `RawAnsi`          | experimental  | Like `Ansi` but bypasses width measurement.      |

### Hooks

| Export       | Status     | Purpose                                  |
| ------------ | ---------- | ---------------------------------------- |
| `useApp`     | supported  | App lifecycle (`exit`, ...).             |
| `useInput`   | supported  | Subscribe to keyboard input.             |
| `useStdin`   | supported  | Read stdin state / raw mode toggling.    |
| `useStdout`  | supported  | Imperative stdout writer + size.         |

### Entry points

| Export         | Status        | Purpose                                       |
| -------------- | ------------- | --------------------------------------------- |
| `render`       | supported     | Mount a React tree to the terminal.           |
| `createRoot`   | supported     | Lower-level mount API.                        |
| `Instance`     | supported     | Handle returned by `render` / `createRoot`.   |
| `renderSync`   | experimental  | Synchronous render variant.                   |
| `RenderOptions`| experimental  | Options bag for `render` / `createRoot`.      |

### Types

`BoxProps`, `TextProps`, `ScrollBoxHandle`, `ScrollBoxProps` are exported for
typing component props and refs and follow the same status as their components.

## Internal layout (not stable, do not import directly)

```
src/render/
├── ink.tsx                     core renderer + frame diffing
├── reconciler.ts               React reconciler bindings
├── render-node-to-output.ts    Yoga layout → cell buffer
├── render-to-screen.ts         buffer diff → ANSI write
├── output.ts                   cell buffer + selection regions
├── dom.ts                      internal "DOM" for layout nodes
├── components/                 Box, Text, ScrollBox, ... (see exports above)
├── hooks/                      useInput, useStdout, useApp, ...
├── events/                     event system (paste, focus, ...)
├── termio/                     terminal I/O (CSI / OSC / mouse parsing)
├── parse-keypress.ts           keystroke + paste tokenization
├── selection.ts                fullscreen text-selection model
├── devtools.ts                 perf / dirty / blit counters (opt-in)
└── ...                         everything else is implementation detail
```

`src/render/Ansi.tsx` exists at the directory root for historical reasons; use
the re-export from `index.ts`, not the deep path.

## Naming clash note

There is also `src/arena/render/` (Arena session rendering — business logic).
The two are unrelated despite the shared name.

## How to evolve this

When changing `src/render/`:

1. Internal-only change (refactor, perf, bug fix preserving behavior) — treat
   like any other code change.
2. Change to a `supported` export — update this README and the callers in the
   same commit.
3. New abstraction — justify against an actual product need. This engine should
   shrink over time, not grow. See `docs/architecture/11-render-tui-capability-plan.md`
   for the roadmap.

## What this directory is *not*

- **Not** a vendored snapshot of npm `ink`.
- **Not** a published library.
- **Not** a place for app-specific UI components — those go in `src/ui/`.
