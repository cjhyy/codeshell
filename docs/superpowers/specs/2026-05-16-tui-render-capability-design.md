# TUI Render Capability — Design Spec

> Date: 2026-05-16
> Source of requirements: [`docs/architecture/11-render-tui-capability-plan.md`](../../architecture/11-render-tui-capability-plan.md)
> Scope: 4 milestones (M1–M4) covering API contract, scroll acceptance, perf diagnostics, component boundary + terminal matrix.

## 1. Goal

Lift `src/render` from "works in practice" to a product-grade TUI runtime: a stable contract for `src/ui`, regression coverage for the hot paths (long transcript, streaming, scroll, resize), a way to measure performance, and a documented terminal compatibility surface.

A consumer of `src/render` should be able to answer, from the README alone:

1. Which exports am I allowed to depend on?
2. Which terminals does this support?
3. How do I run regression tests / a perf check before merging?

## 2. Non-Goals

- No Electron / Tauri / WebView / SwiftUI work inside `src/render`.
- No new layout primitives (table, portal, z-index, modal stack) until a product feature requires them.
- Not packaging `src/render` as a standalone library.
- No CI perf gating in this spec. Bench is a local tool; baselines live in the README.
- `TextInput` stays in `src/ui/components/`. It mixes business behavior (history, slash commands) with input rendering and is not a generic primitive.

## 3. Milestones (overview)

| Milestone | Theme | Primary deliverables | Sequential? |
|---|---|---|---|
| M1 | Contract + test floor | rewritten `src/render/README.md`, supported export set, 3 minimal test files | Must land first |
| M2 | Scroll acceptance | scroll + virtual-scroll tests, manual checklist, 10k-transcript repro script, commit pending `App.tsx` / `VirtualMessageList.tsx` | After M1 |
| M3 | Perf budget + diagnostics | `devtools` (frame / dirty / blit), `bench/` directory, baselines in README | After M2 |
| M4 | Component boundary + terminal matrix | promoted primitives in public API, `render-terminal-matrix.md`, clipboard branch tests | After M3 (M4 ADR-style decisions reference M1 contract) |

Each milestone is independently shippable: a partial completion of (M1) is still useful even if M2–M4 slip.

## 4. M1 — Contract & Test Floor

### 4.1 Public API contract

A single source of truth lives in `src/render/README.md`. Every export gets one of three states:

| Status | Meaning | Stability |
|---|---|---|
| `supported` | UI may depend on it. Renaming or removing requires updating callers in the same commit. | Stable within minor versions. |
| `experimental` | UI may use it explicitly. Shape may change; we document the change. | Best-effort. |
| `internal` | UI must not import. Refactor freely. | None. |

The README contract table covers these exports (each annotated with status):

**Components** — `Box`, `Text`, `Spacer`, `Newline`, `ScrollBox`, `AlternateScreen`, `Ansi`, `NoSelect`, `Button`, `Link`, `RawAnsi`
**Hooks** — `useApp`, `useInput`, `useStdin`, `useStdout`
**Entry points** — `render`, `renderSync`, `createRoot`, `Instance`, `RenderOptions`
**Selection** — a minimal public surface from `selection.ts` (e.g. `markNoSelect` if any imperative API is used; otherwise note that `<NoSelect>` is the only supported entry)

Initial state for each:

- `supported`: `Box`, `Text`, `Spacer`, `Newline`, `ScrollBox`, `AlternateScreen`, `Ansi`, `NoSelect`, `useApp`, `useInput`, `useStdin`, `useStdout`, `render`, `createRoot`, `Instance`
- `experimental`: `Button`, `Link`, `RawAnsi`, `renderSync`, `RenderOptions`
- `internal`: everything not exported from `src/render/index.ts`

### 4.2 Export hygiene

- Anything marked `supported` or `experimental` must be re-exported from `src/render/index.ts`.
- `<Ansi>` is currently imported via `src/render/Ansi.js`. M1 adds an `Ansi` re-export from `index.ts` and migrates the two known consumers (`TextInput.tsx`, `MessageContent.tsx`) to import from `index.js`. The deep path stays working but README marks it `internal`.
- `selection.ts` and other non-listed files stay un-exported. Adding a re-export is a contract change.

### 4.3 Tests added in M1

Test framework: `bun test`. All tests are pure unit tests against the in-process render engine. No real terminal, no Playwright, no docker. Terminal-specific behavior is verified via fixtures — captured escape-sequence byte strings stored under `tests/fixtures/render/`.

| File | What it covers |
|---|---|
| `tests/render-screen.test.ts` | `<Box>` + `<Text>` layout (width / height / wrap), wide-char width, ANSI style application, hyperlink (OSC 8), `<NoSelect>` regions, soft-wrap metadata |
| `tests/render-diff.test.ts` | Two consecutive frame buffers produce expected diff writes; blit fast path; alt-screen height clamp; resize-induced repaint |
| `tests/render-input.test.ts` | `parse-keypress` parses fixtures for plain keys, Ctrl/Meta combos, kitty keyboard protocol, modifyOtherKeys, bracketed paste, mouse wheel; events flow to a focused component |

Each file targets 60–120 lines. They are not exhaustive — they pin the contract so future refactors are caught.

### 4.4 M1 exit criteria

- `pnpm test` (i.e. `bun test`) is green including the three new files.
- `src/render/README.md` lists every name in `src/render/index.ts` with a status.
- All consumer imports of `<Ansi>` go through `src/render/index.js`.
- `docs/architecture/11-render-tui-capability-plan.md` references the new README contract instead of duplicating an API table.

## 5. M2 — Scroll Acceptance

### 5.1 Tests

| File | Focus |
|---|---|
| `tests/render-scroll.test.ts` | `ScrollBox`: `scrollTop` / clamp / `sticky` / `scrollToElement` / `subscribe` notifications. Operates on a mounted root, not via real terminal. |
| `tests/use-virtual-scroll.test.ts` | `useVirtualScroll`: visible range math, height cache, resize re-scaling, sticky-bottom under append, append at non-bottom does not jerk scroll position |

### 5.2 Manual checklist + repro

- `docs/architecture/render-scroll-checklist.md`: the canonical pre-release manual checklist. Includes for each case: setup, action, expected outcome.
  - 10k entries: tail render time, memory steady-state.
  - Wheel / PgUp / PgDn.
  - Resize while scrolled mid-history.
  - New-message divider behavior when sticky-bottom is on vs off.
  - Streaming assistant text while history scrolled away from bottom.
- `scripts/render-bigtranscript-dev.ts`: launches the dev UI with a synthetic 10k-message transcript loaded into the message store. Reusable by M3 perf bench as the harness.

### 5.3 Commit the pending UI work

The working tree currently has unstaged changes in `src/ui/App.tsx` and `src/ui/components/VirtualMessageList.tsx` that are part of the scroll work (built on top of commit `4de607a perf(ui): ScrollBox + useVirtualScroll for true viewport-windowed chat`). These are reviewed and committed at the start of M2 to form the baseline that the new tests pin.

### 5.4 M2 exit criteria

- The two new test files are green.
- Checklist doc exists; repro script runs locally.
- `App.tsx` + `VirtualMessageList.tsx` changes are merged (or explicitly reverted) — no long-lived working-tree state.

## 6. M3 — Perf Budget & Diagnostics

### 6.1 Diagnostics

`src/render/devtools.ts` is currently a no-op stub. M3 implements a minimal observable surface:

- Activated by env: `CODESHELL_RENDER_DEBUG=1`.
- Counters per frame: frame duration (ms), dirty node count, cells written, blit ratio (cells reused / cells total), scroll-hint hits.
- Output: log lines to the existing `~/.code-shell/logs/ui-ink` bucket (per existing logs layout). One line per frame is too noisy — emit a 1s summary by default; `CODESHELL_RENDER_DEBUG=verbose` for per-frame.
- The legacy probe from commit `ce62a17 chore(ui): opt-in perf-probes for UI stall debugging` is consolidated into `devtools` to avoid two parallel probe paths.

### 6.2 Bench

A new top-level `bench/` directory, one file per scenario, all runnable via `bun run bench:render`:

| File | Scenario | Metric |
|---|---|---|
| `bench/render-tail.bench.ts` | Mount 10k transcript and render the tail | total frame ms, peak heap, cells written |
| `bench/render-streaming.bench.ts` | Append 200 deltas to an assistant message | frame ms p50 / p95, blit ratio, did history re-layout? (boolean) |
| `bench/render-spinner.bench.ts` | Spinner tick × 60 with full transcript present | per-tick frame ms; assertion: transcript layout count = 0 |
| `bench/render-wheel.bench.ts` | Programmatically scroll the 10k transcript via `scrollBy` | frames-per-step ms |

Results are printed to stdout in a stable, parseable format. M3 records a baseline run as a table in `src/render/README.md` (under a "Perf baselines" section) so future runs can be compared by eye.

### 6.3 M3 exit criteria

- Setting `CODESHELL_RENDER_DEBUG=1` writes structured perf lines to the ui-ink log bucket.
- `bun run bench:render` runs all four bench files and prints results.
- README has a Perf baselines table with the first set of numbers.
- The old standalone probe from `ce62a17` no longer exists as a parallel path (deleted or routed through `devtools`).

## 7. M4 — Component Boundary & Terminal Matrix

### 7.1 Primitive decisions (ADR-style)

Append a "Public component primitives" section to `docs/architecture/11-render-tui-capability-plan.md` documenting:

- `Button`, `Link`, `RawAnsi` — promote to `supported` (already in `experimental` after M1).
- `TextInput` — stays in `src/ui/components/`. Rationale: it bundles slash-command parsing, history, completions. Decision recorded so future refactors don't relitigate it.

When `experimental` → `supported` promotion happens, the README table is updated in the same commit.

### 7.2 Terminal matrix

`docs/architecture/render-terminal-matrix.md`:

- Rows: tmux, xterm.js, iTerm2, Ghostty, Windows Terminal, Apple Terminal, VS Code integrated terminal.
- Columns: support level (`supported` / `best-effort` / `unsupported`), known caveats, latest verification date.
- Each terminal-specific branch in `src/render/terminal.ts` and `src/render/termio/` is cross-referenced.

### 7.3 Clipboard branch tests

`tests/render-clipboard.test.ts`:

- OSC 52 happy path (sequence emitted, base64 payload correct).
- tmux passthrough wrapping (tmux DCS prefix around OSC 52).
- Native clipboard fallback (when OSC 52 disabled): invokes the right shell-out per platform, mocked.

### 7.4 M4 exit criteria

- Promoted primitives appear as `supported` in the README contract.
- `render-terminal-matrix.md` exists with at least one row per terminal and a verification date.
- `tests/render-clipboard.test.ts` is green.

## 8. Risks & mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| M1 contract breaks UI imports | Existing deep imports of `selection.ts` or other internals may surface | M1 grep step before changing exports; deep paths stay working, only README marks them internal |
| Bench numbers depend on host load | Local baselines drift across machines | Baseline rows in README carry host info (CPU, OS) as a string; relative deltas matter more than absolute |
| Tests rely on terminal-specific escape sequences that vary | Kitty / modifyOtherKeys fixtures may be too narrow | All terminal-specific input is fed in as captured byte strings under `tests/fixtures/render/`. Adding terminals = adding fixtures, no code branches in test |
| M2 manual checklist rots | Manual tests get skipped under pressure | Repro script makes setup near-zero; checklist lives next to the script |
| Devtools log volume | Per-frame logs flood the bucket | Default is 1s summary; verbose is opt-in via env value |

## 9. Open questions

None. All major scope decisions are answered in this document. Anything that surfaces during implementation lands as a follow-up issue, not a spec amendment, unless it changes a milestone's exit criteria.

## 10. Out of scope (deferred)

These were mentioned during brainstorming but explicitly deferred:

- Accessibility checklist & manual matrix (was P1 in source plan). Land after M3 stabilizes, on its own.
- Higher-level layout primitives (table, portal, z-index, modal stack).
- CI-gated bench thresholds.
- Cross-terminal automated integration tests (Playwright + xterm.js).
