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

| Export            | Status    | Purpose                                          |
| ----------------- | --------- | ------------------------------------------------ |
| `Box`             | supported | Flexbox container.                               |
| `Text`            | supported | Styled text leaf.                                |
| `Spacer`          | supported | Flexible spacer in a flex container.             |
| `Newline`         | supported | Hard line break inside a `Text`.                 |
| `ScrollBox`       | supported | Viewport scroll container; imperative handle.    |
| `AlternateScreen` | supported | Enter alt-screen + mouse tracking + raw input.   |
| `Ansi`            | supported | Embed a pre-rendered ANSI string.                |
| `NoSelect`        | supported | Mark a region non-selectable in fullscreen copy. |
| `Button`          | supported | Click/keyboard activatable region.               |
| `Link`            | supported | OSC 8 hyperlink wrapper.                         |
| `RawAnsi`         | supported | Like `Ansi` but bypasses width measurement.      |

### Hooks

| Export      | Status    | Purpose                               |
| ----------- | --------- | ------------------------------------- |
| `useApp`    | supported | App lifecycle (`exit`, ...).          |
| `useInput`  | supported | Subscribe to keyboard input.          |
| `useStdin`  | supported | Read stdin state / raw mode toggling. |
| `useStdout` | supported | Imperative stdout writer + size.      |

### Entry points

| Export          | Status       | Purpose                                     |
| --------------- | ------------ | ------------------------------------------- |
| `render`        | supported    | Mount a React tree to the terminal.         |
| `createRoot`    | supported    | Lower-level mount API.                      |
| `Instance`      | supported    | Handle returned by `render` / `createRoot`. |
| `renderSync`    | experimental | Synchronous render variant.                 |
| `RenderOptions` | experimental | Options bag for `render` / `createRoot`.    |

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

## Perf baselines

Local bench results, recorded 2026-09-11. Numbers are machine-specific; use
relative deltas on the same machine, not absolute SLOs.

These benchmarks were repaired after the monorepo migration: imports now use
`packages/tui/src/render`, timers surround the actual scenario, and frame counts
come from `onFrame` rather than stdout chunk counts. The old 2026-05-17 table
measured different intervals and counters and is not comparable to these values.

| Scenario               | total ms | per update ms | bytes written | frames | writes |
| ---------------------- | -------- | ------------- | ------------- | ------ | ------ |
| `mount-10k`            | 233.09   | —             | 98,912        | 1      | 2      |
| `streaming-200-deltas` | 4,114.03 | 20.570        | 6,276         | 200    | 200    |
| `spinner-60-ticks`     | 1,451.08 | 24.185        | 1,680         | 60     | 60     |
| `wheel-100-steps`      | 2,089.74 | 20.897        | 129,293       | 300    | 301    |

Mount timing includes tree construction through the first terminal frame.
Streaming and spinner timing/counters exclude warm mount and include all updates
through the final rendered frame. The wheel scenario includes the initial frame
in counters and a deliberate 20 ms settle wait in each step. The benchmark waits
for actual frame callbacks and fails if they do not arrive; batching may produce
fewer frames than updates on a faster machine.

To re-record: `bun run bench:render`. To collect under live perf logging:
`CODESHELL_RENDER_DEBUG=1 bun run bench:render`, then read
`~/.code-shell/logs/ui-ink/render-perf.log`.

## How to evolve this

When changing `src/render/`:

1. Internal-only change (refactor, perf, bug fix preserving behavior) — treat
   like any other code change.
2. Change to a `supported` export — update this README and the callers in the
   same commit.
3. New abstraction — justify against an actual product need. This engine should
   shrink over time, not grow. See `docs/architecture/11-render-tui-capability-plan.md`
   for the roadmap.

## What this directory is _not_

- **Not** a vendored snapshot of npm `ink`.
- **Not** a published library.
- **Not** a place for app-specific UI components — those go in `src/ui/`.
