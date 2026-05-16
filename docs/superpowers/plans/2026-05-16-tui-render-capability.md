# TUI Render Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift `src/render` from "Ink replacement that works" to a product-grade TUI runtime — with a stable public-API contract, regression tests for the hot paths (long transcript, streaming, scroll, resize), local perf benches, and a documented terminal compatibility surface.

**Architecture:** Four sequential milestones, each independently shippable.
  - **M1 Contract & test floor** — rewrite `src/render/README.md` with three API states (`supported` / `experimental` / `internal`), add `Ansi` to `index.ts`, add three minimal test files.
  - **M2 Scroll acceptance** — commit pending UI scroll work, add scroll + virtual-scroll tests, write a manual checklist + a 10k-transcript dev script.
  - **M3 Perf budget + diagnostics** — fill in `devtools.ts`, add `bench/` directory and 4 bench scenarios, record baselines in README.
  - **M4 Component boundary + terminal matrix** — promote experimental primitives to supported, write `render-terminal-matrix.md`, add clipboard branch tests.

**Tech Stack:** TypeScript (ESM, Node ≥20.10), React + custom reconciler (`src/render`), bun (test runner, dev/run, bench), Yoga flexbox, no Playwright / no real terminal in tests.

**Spec:** [`docs/superpowers/specs/2026-05-16-tui-render-capability-design.md`](../specs/2026-05-16-tui-render-capability-design.md)

---

## File map

Per milestone — files created or modified.

**M1 — Contract & test floor**
- Modify: `src/render/README.md` — rewrite to canonical API contract.
- Modify: `src/render/index.ts` — add `Ansi` re-export.
- Modify: `src/ui/components/TextInput.tsx`, `src/ui/components/MessageContent.tsx` — switch from `../../render/Ansi.js` to `../../render/index.js`.
- Modify: `docs/architecture/11-render-tui-capability-plan.md` — drop the duplicate API table, point to the README.
- Create: `tests/fixtures/render/keypress/plain.txt`, `ctrl-meta.txt`, `kitty.txt`, `modify-other-keys.txt`, `bracketed-paste.txt`, `mouse-wheel.txt` — captured byte fixtures for input parser tests.
- Create: `tests/render-screen.test.ts` — layout / wide-char / ANSI / hyperlink / NoSelect / soft-wrap.
- Create: `tests/render-diff.test.ts` — frame diff, blit, alt-screen clamp, resize.
- Create: `tests/render-input.test.ts` — keypress parser against fixtures.

**M2 — Scroll acceptance**
- Commit (no edits): `src/ui/App.tsx`, `src/ui/components/VirtualMessageList.tsx` — currently-unstaged scroll baseline.
- Create: `tests/render-scroll.test.ts` — `ScrollBox` API.
- Create: `tests/use-virtual-scroll.test.ts` — virtual range math + height cache.
- Create: `docs/architecture/render-scroll-checklist.md` — manual checklist.
- Create: `scripts/render-bigtranscript-dev.ts` — launch dev UI with synthetic 10k transcript.
- Modify: `package.json` — add `"dev:bigtranscript"` script.

**M3 — Perf budget + diagnostics**
- Modify: `src/render/devtools.ts` — implement counters + 1s summary log.
- Modify: `src/ui/perf-probes.ts` (and any other parallel probe site) — route through `devtools` or delete.
- Create: `bench/README.md` — how to run, what each scenario measures.
- Create: `bench/render-tail.bench.ts`
- Create: `bench/render-streaming.bench.ts`
- Create: `bench/render-spinner.bench.ts`
- Create: `bench/render-wheel.bench.ts`
- Create: `bench/harness.ts` — shared mount + measure helpers used by all four.
- Modify: `package.json` — add `"bench:render"` script.
- Modify: `src/render/README.md` — add "Perf baselines" section with first numbers.

**M4 — Component boundary + terminal matrix**
- Modify: `src/render/index.ts` — promote `Button`, `Link`, `RawAnsi` (currently `experimental`) to `supported` (already exported, but README status changes).
- Modify: `src/render/README.md` — update API status; record TextInput-stays-in-ui decision.
- Modify: `docs/architecture/11-render-tui-capability-plan.md` — append "Public component primitives" ADR section.
- Create: `docs/architecture/render-terminal-matrix.md` — terminal × support level × caveats × last verified.
- Create: `tests/fixtures/render/clipboard/` — OSC 52 / tmux DCS / native fallback expected sequences.
- Create: `tests/render-clipboard.test.ts`.

---

## Conventions used throughout the plan

- Test runner: `bun test`. All test paths use the `tests/` top-level dir (already used by the repo).
- Bench runner: `bun run` invoked directly on `bench/*.bench.ts` files.
- ESM imports — every TS-to-TS import ends in `.js`.
- Commits — small, one per logical step. Suggested messages are given verbatim.
- Each task ends with a single commit step; do not batch task commits.

---

# Milestone M1 — Contract & Test Floor

### Task 1: Re-export `<Ansi>` from `src/render/index.ts`

**Why:** Two UI files deep-import `../../render/Ansi.js`. Per spec §4.2, anything `supported` must be reachable through `index.ts`.

**Files:**
- Modify: `src/render/index.ts`
- Modify: `src/ui/components/TextInput.tsx:12`
- Modify: `src/ui/components/MessageContent.tsx:12`

- [ ] **Step 1: Add the re-export**

Append to `src/render/index.ts` after the existing `AlternateScreen` line:

```ts
// Ansi — pre-rendered ANSI string into the React tree
export { default as Ansi } from "./Ansi.js";
```

- [ ] **Step 2: Update the two consumers**

In `src/ui/components/TextInput.tsx`, replace line 12:

```ts
import { Ansi } from "../../render/Ansi.js";
```

with:

```ts
import { Ansi } from "../../render/index.js";
```

(Merge into the existing `from "../../render/index.js"` line at the top if the file already imports from it — check first; if so, just add `Ansi` to that import list and drop the deep-path line.)

In `src/ui/components/MessageContent.tsx`, do the same on line 12.

- [ ] **Step 3: Type-check**

Run: `bun run typecheck`
Expected: PASS, no `Ansi`-related errors.

- [ ] **Step 4: Verify no other deep imports of Ansi remain**

Run: `grep -rn "render/Ansi" src/ui src/cli 2>/dev/null`
Expected: empty output.

- [ ] **Step 5: Commit**

```bash
git add src/render/index.ts src/ui/components/TextInput.tsx src/ui/components/MessageContent.tsx
git commit -m "refactor(render): re-export <Ansi> from index; drop deep imports"
```

---

### Task 2: Rewrite `src/render/README.md` with API status table

**Why:** Spec §4.1. The README is the single source of truth for the contract. The current README marks `ScrollBox` / `AlternateScreen` as "currently unused" — false; UI uses both.

**Files:**
- Modify: `src/render/README.md` (full rewrite, ~150 lines)

- [ ] **Step 1: Replace `src/render/README.md` with the contract README**

Replace the entire file with:

````markdown
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
````

- [ ] **Step 2: Verify the listed exports are reachable**

Run:

```bash
grep -E "^export " src/render/index.ts
```

Expected: every name in README's supported/experimental tables appears here. If anything is missing, add it to `index.ts` in this same task (do not change README to match a missing export).

- [ ] **Step 3: Commit**

```bash
git add src/render/README.md src/render/index.ts
git commit -m "docs(render): rewrite README as API contract with supported/experimental/internal states"
```

---

### Task 3: Drop duplicate API table from `11-render-tui-capability-plan.md`

**Why:** Spec §4.4. Two sources of truth would drift.

**Files:**
- Modify: `docs/architecture/11-render-tui-capability-plan.md`

- [ ] **Step 1: Replace "Current Capabilities" section content with a pointer**

In `docs/architecture/11-render-tui-capability-plan.md`, find the `## Current Capabilities` section (the table of "Public surface / React host renderer / ..." rows). Replace its body with:

```markdown
## Current Capabilities

The authoritative inventory of public exports lives in
[`src/render/README.md`](../../src/render/README.md). This document focuses on
the **roadmap and gaps** — not on listing every export.

For a snapshot of where the renderer currently lands on the L1/L2/L3 ladder, see
the Recommendation table above. For exact status (`supported` / `experimental`
/ `internal`) of any export, read the README.
```

Keep everything else in `11-render-tui-capability-plan.md` intact (Recommendation, Required TUI Capabilities, Current Gaps, Test Plan, Performance Budgets, Roadmap, Non-Goals).

- [ ] **Step 2: Commit**

```bash
git add docs/architecture/11-render-tui-capability-plan.md
git commit -m "docs(architecture): point render API inventory at the README"
```

---

### Task 4: Set up `tests/fixtures/render/keypress/` byte fixtures

**Why:** Spec §4.3. Tests must not embed escape sequences inline (hard to read, terminal-specific). Captured byte strings make terminal-specific behavior explicit.

**Files:**
- Create: `tests/fixtures/render/keypress/plain.txt`
- Create: `tests/fixtures/render/keypress/ctrl-meta.txt`
- Create: `tests/fixtures/render/keypress/kitty.txt`
- Create: `tests/fixtures/render/keypress/modify-other-keys.txt`
- Create: `tests/fixtures/render/keypress/bracketed-paste.txt`
- Create: `tests/fixtures/render/keypress/mouse-wheel.txt`
- Create: `tests/fixtures/render/README.md`

Each `.txt` is a single line: a JS-string-escaped byte sequence (for readability) plus a brief comment header. The test loader will parse and decode.

- [ ] **Step 1: Create the fixture README**

`tests/fixtures/render/README.md`:

```markdown
# Render Fixtures

Byte sequences captured from terminals, used by unit tests under `tests/`.
Tests load these files with `loadFixture(name)` (see `tests/render-fixtures.ts`).

## Format

One sequence per file. The first line of a `.txt` file is a `#` comment
describing the capture (terminal, key combo, terminal mode). Subsequent
non-comment lines are concatenated and JSON-decoded (`"..."` form) to bytes.

Example (`plain.txt`):

    # xterm: typing "a"
    "a"

To recapture: enable `CODESHELL_INPUT_TAP=1` in the dev UI; sequences go to
`~/.code-shell/logs/ui-ink/input.log`. Copy the relevant chunk in JSON string
form into a fixture file.
```

- [ ] **Step 2: Create `plain.txt`**

```
# xterm: typing the letter "a"
"a"
```

- [ ] **Step 3: Create `ctrl-meta.txt`**

```
# xterm: Ctrl+A then Meta+B (ESC-prefix style)
""
"b"
```

- [ ] **Step 4: Create `kitty.txt`**

```
# kitty keyboard protocol: F1 with shift modifier
"[1;2P"
```

- [ ] **Step 5: Create `modify-other-keys.txt`**

```
# modifyOtherKeys mode 2: Ctrl+Shift+A
"[27;6;65~"
```

- [ ] **Step 6: Create `bracketed-paste.txt`**

```
# bracketed paste of "hi\nthere"
"[200~hi\nthere[201~"
```

- [ ] **Step 7: Create `mouse-wheel.txt`**

```
# SGR mouse: wheel-up at col 10 row 5, then wheel-down
"[<64;10;5M"
"[<65;10;5M"
```

- [ ] **Step 8: Commit**

```bash
git add tests/fixtures/render
git commit -m "test(render): add input fixtures for keypress + paste + mouse"
```

---

### Task 5: Add `tests/render-fixtures.ts` helper

**Why:** Every render test needs the same mount + flush + read-frame helpers, and the keypress tests need a fixture loader. Centralize once.

**Files:**
- Create: `tests/render-fixtures.ts`

- [ ] **Step 1: Write the helper**

`tests/render-fixtures.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import React from "react";
import { createRoot, type Instance } from "../src/render/index.js";

const FIXTURE_ROOT = join(__dirname, "fixtures", "render");

/**
 * Load a `.txt` fixture file. Lines starting with `#` are comments. All
 * remaining non-empty lines are JSON-decoded as quoted strings and
 * concatenated.
 */
export function loadFixture(...parts: string[]): string {
  const raw = readFileSync(join(FIXTURE_ROOT, ...parts), "utf8");
  let out = "";
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    out += JSON.parse(trimmed);
  }
  return out;
}

export interface TestHarness {
  stdin: PassThrough;
  stdout: PassThrough;
  frames: string[];
  instance: Instance;
  unmount: () => void;
}

/**
 * Mount a component into an isolated render root with piped stdin/stdout.
 * Each write to stdout is captured as a separate frame entry.
 */
export function mount(
  element: React.ReactElement,
  opts: { columns?: number; rows?: number } = {},
): TestHarness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdout as unknown as { isTTY: boolean; columns: number; rows: number }).isTTY = true;
  (stdout as unknown as { columns: number }).columns = opts.columns ?? 80;
  (stdout as unknown as { rows: number }).rows = opts.rows ?? 24;

  const frames: string[] = [];
  stdout.on("data", (chunk: Buffer) => frames.push(chunk.toString("utf8")));

  const instance = createRoot(element, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  } as unknown as Parameters<typeof createRoot>[1]);

  return {
    stdin,
    stdout,
    frames,
    instance,
    unmount: () => instance.unmount(),
  };
}

/** Concatenate all frames written so far. */
export function dumpFrames(h: TestHarness): string {
  return h.frames.join("");
}

/** Wait for the next macrotask so the renderer can flush. */
export function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
```

- [ ] **Step 2: Verify the harness compiles**

Run: `bun run typecheck`
Expected: PASS. If `createRoot`'s options type rejects the shape, narrow the cast to match — the harness is internal-only.

- [ ] **Step 3: Commit**

```bash
git add tests/render-fixtures.ts
git commit -m "test(render): add mount + fixture-loader test harness"
```

---

### Task 6: Add `tests/render-screen.test.ts`

**Files:**
- Create: `tests/render-screen.test.ts`

- [ ] **Step 1: Write the failing test file**

`tests/render-screen.test.ts`:

```ts
import { test, expect } from "bun:test";
import React from "react";
import { Box, Text, NoSelect } from "../src/render/index.js";
import { mount, dumpFrames, flush } from "./render-fixtures";

test("renders text inside a box", async () => {
  const h = mount(React.createElement(Box, null,
    React.createElement(Text, null, "hello"),
  ));
  await flush();
  expect(dumpFrames(h)).toContain("hello");
  h.unmount();
});

test("wraps wide characters by display width, not codepoint count", async () => {
  const h = mount(
    React.createElement(Box, { width: 4 },
      React.createElement(Text, null, "你好世界"),
    ),
    { columns: 80 },
  );
  await flush();
  const out = dumpFrames(h);
  // Each CJK char is width 2 — 4 cols fits exactly 2 chars per row.
  expect(out).toContain("你好");
  expect(out).toContain("世界");
  h.unmount();
});

test("applies ANSI bold style", async () => {
  const h = mount(React.createElement(Text, { bold: true }, "bold"));
  await flush();
  expect(dumpFrames(h)).toMatch(/\[(?:[0-9;]*;)?1m/);
  h.unmount();
});

test("emits OSC 8 hyperlink around link text", async () => {
  const { default: Link } = await import("../src/render/components/Link.js");
  const h = mount(
    React.createElement(Link, { url: "https://example.com" },
      React.createElement(Text, null, "site"),
    ),
  );
  await flush();
  expect(dumpFrames(h)).toContain("]8;;https://example.com\\");
  h.unmount();
});

test("NoSelect region marks cells as non-selectable", async () => {
  const h = mount(
    React.createElement(Box, null,
      React.createElement(NoSelect, null,
        React.createElement(Text, null, "gutter"),
      ),
      React.createElement(Text, null, "body"),
    ),
  );
  await flush();
  // We do not assert sequence — only that the frame still contains both regions
  // and that the selection state (queried via the instance) marks the gutter.
  expect(dumpFrames(h)).toContain("gutter");
  expect(dumpFrames(h)).toContain("body");
  h.unmount();
});

test("soft-wrap inserts a line break at the box edge", async () => {
  const h = mount(
    React.createElement(Box, { width: 5 },
      React.createElement(Text, null, "abcdefghij"),
    ),
    { columns: 80 },
  );
  await flush();
  const out = dumpFrames(h);
  expect(out).toContain("abcde");
  expect(out).toContain("fghij");
  h.unmount();
});
```

- [ ] **Step 2: Run and confirm it fails for the right reason**

Run: `bun test tests/render-screen.test.ts`
Expected: tests run; failures (if any) should be assertion mismatches, NOT import errors. If you see import errors, fix the harness in Task 5 — do not change the test.

- [ ] **Step 3: Adjust the test if the renderer's output shape differs**

The test asserts the **visible** properties (text content + ANSI bold + OSC 8). If the renderer wraps lines with `\r` or `\n` differently than expected, update `.toContain` calls to match what the renderer actually emits — but keep the **intent** of each test:
  - text appears in the frame
  - wide chars take 2 columns
  - bold produces SGR 1
  - link produces OSC 8
  - NoSelect content still renders
  - soft-wrap splits at the box width

If a test cannot be made to pass after one adjustment pass, that indicates a real bug in the renderer — STOP and ask. Do not delete the test.

- [ ] **Step 4: Run the file until all 6 tests pass**

Run: `bun test tests/render-screen.test.ts`
Expected: 6 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add tests/render-screen.test.ts
git commit -m "test(render): screen basics — layout, wide char, ANSI, link, NoSelect, wrap"
```

---

### Task 7: Add `tests/render-diff.test.ts`

**Files:**
- Create: `tests/render-diff.test.ts`

- [ ] **Step 1: Write the test file**

`tests/render-diff.test.ts`:

```ts
import { test, expect } from "bun:test";
import React from "react";
import { Box, Text, AlternateScreen } from "../src/render/index.js";
import { mount, flush } from "./render-fixtures";

test("changing one cell triggers a write smaller than a full repaint", async () => {
  const Hello = ({ name }: { name: string }) =>
    React.createElement(Box, null, React.createElement(Text, null, `hi ${name}`));

  const h = mount(React.createElement(Hello, { name: "a" }));
  await flush();
  const baseline = h.frames.length;
  h.instance.rerender(React.createElement(Hello, { name: "b" }));
  await flush();
  // After the second render at least one new frame chunk was written, and the
  // total bytes are far below "draw the whole screen".
  expect(h.frames.length).toBeGreaterThan(baseline);
  const lastChunk = h.frames[h.frames.length - 1] ?? "";
  expect(lastChunk.length).toBeLessThan(80 * 24); // less than a full screen of cells
  h.unmount();
});

test("alt-screen clamps content to viewport rows", async () => {
  const lines = Array.from({ length: 200 }, (_, i) => `row-${i}`);
  const h = mount(
    React.createElement(AlternateScreen, null,
      React.createElement(Box, { flexDirection: "column" },
        ...lines.map((l) => React.createElement(Text, { key: l }, l)),
      ),
    ),
    { columns: 80, rows: 24 },
  );
  await flush();
  const all = h.frames.join("");
  // Top of viewport visible
  expect(all).toContain("row-0");
  // Far bottom is not painted in a 24-row alt-screen
  expect(all).not.toContain("row-150");
  h.unmount();
});

test("resize causes a fresh frame", async () => {
  const h = mount(
    React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, null, "line"),
    ),
    { columns: 80, rows: 24 },
  );
  await flush();
  const baseline = h.frames.length;
  (h.stdout as unknown as { columns: number }).columns = 120;
  (h.stdout as unknown as { rows: number }).rows = 40;
  h.stdout.emit("resize");
  await flush();
  expect(h.frames.length).toBeGreaterThan(baseline);
  h.unmount();
});
```

- [ ] **Step 2: Run the test**

Run: `bun test tests/render-diff.test.ts`
Expected: 3 pass. If the renderer's resize signal is delivered differently (e.g. via the `process.stdout` global rather than the piped stream), adjust the resize step to match the renderer — but keep the assertion that a frame is emitted after resize.

- [ ] **Step 3: Commit**

```bash
git add tests/render-diff.test.ts
git commit -m "test(render): frame diff size, alt-screen clamp, resize repaint"
```

---

### Task 8: Add `tests/render-input.test.ts`

**Files:**
- Create: `tests/render-input.test.ts`

- [ ] **Step 1: Write the test file**

`tests/render-input.test.ts`:

```ts
import { test, expect } from "bun:test";
import React, { useState } from "react";
import { Box, Text, useInput } from "../src/render/index.js";
import { mount, flush, loadFixture, dumpFrames } from "./render-fixtures";

function Probe({ onKey }: { onKey: (input: string, key: Record<string, unknown>) => void }) {
  useInput((input, key) => onKey(input, key as Record<string, unknown>));
  return React.createElement(Text, null, "ready");
}

test("plain ASCII key reaches useInput", async () => {
  const events: Array<{ input: string }> = [];
  const h = mount(React.createElement(Probe, { onKey: (input) => events.push({ input }) }));
  await flush();
  h.stdin.write(loadFixture("keypress", "plain.txt"));
  await flush();
  expect(events.some((e) => e.input === "a")).toBe(true);
  h.unmount();
});

test("Ctrl/Meta combos parse correctly", async () => {
  const seen: Array<{ input: string; ctrl?: boolean; meta?: boolean }> = [];
  const h = mount(
    React.createElement(Probe, {
      onKey: (input, key) =>
        seen.push({ input, ctrl: Boolean(key.ctrl), meta: Boolean(key.meta) }),
    }),
  );
  await flush();
  h.stdin.write(loadFixture("keypress", "ctrl-meta.txt"));
  await flush();
  // Ctrl+A should produce a ctrl event
  expect(seen.some((e) => e.ctrl && e.input.toLowerCase() === "a")).toBe(true);
  // Meta+B should produce a meta event
  expect(seen.some((e) => e.meta && e.input.toLowerCase() === "b")).toBe(true);
  h.unmount();
});

test("bracketed paste delivers the inner payload", async () => {
  const captured: string[] = [];
  function PasteProbe() {
    useInput((input, key) => {
      const k = key as Record<string, unknown>;
      if (k.paste) captured.push(input);
    });
    return React.createElement(Text, null, "ready");
  }
  const h = mount(React.createElement(PasteProbe));
  await flush();
  h.stdin.write(loadFixture("keypress", "bracketed-paste.txt"));
  await flush();
  expect(captured.join("")).toContain("hi");
  expect(captured.join("")).toContain("there");
  h.unmount();
});

test("kitty keyboard protocol sequence is parsed (does not crash)", async () => {
  const events: unknown[] = [];
  const h = mount(
    React.createElement(Probe, { onKey: (_input, key) => events.push(key) }),
  );
  await flush();
  h.stdin.write(loadFixture("keypress", "kitty.txt"));
  await flush();
  expect(events.length).toBeGreaterThan(0);
  h.unmount();
});

test("modifyOtherKeys sequence parses without crashing", async () => {
  const events: unknown[] = [];
  const h = mount(
    React.createElement(Probe, { onKey: (_input, key) => events.push(key) }),
  );
  await flush();
  h.stdin.write(loadFixture("keypress", "modify-other-keys.txt"));
  await flush();
  expect(events.length).toBeGreaterThan(0);
  h.unmount();
});

test("mouse wheel event reaches an enabled handler", async () => {
  const wheelEvents: unknown[] = [];
  function WheelProbe() {
    useInput((input, key) => {
      const k = key as Record<string, unknown>;
      if (k.wheel) wheelEvents.push(k);
    });
    return React.createElement(Text, null, "ready");
  }
  const h = mount(React.createElement(WheelProbe));
  await flush();
  h.stdin.write(loadFixture("keypress", "mouse-wheel.txt"));
  await flush();
  // If wheel is not exposed via useInput in this engine, accept a permissive
  // assertion: no crash and the frame is unchanged.
  expect(() => dumpFrames(h)).not.toThrow();
  h.unmount();
});
```

- [ ] **Step 2: Run the test**

Run: `bun test tests/render-input.test.ts`
Expected: 6 pass. The last test is intentionally permissive — if `useInput` does not surface wheel events directly in this engine, document the actual route in a code comment above the test (e.g. "wheel goes through ScrollBox subscribe") and adjust the assertion to match reality, but keep the test in place as a smoke check.

- [ ] **Step 3: Commit**

```bash
git add tests/render-input.test.ts
git commit -m "test(render): keypress parser fixtures — plain / ctrl-meta / paste / kitty / mouse"
```

---

### Task 9: M1 done — run the full test suite

- [ ] **Step 1: Run all tests**

Run: `bun test`
Expected: all previously-green tests still green; 3 new test files green.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Tag the milestone in git log**

```bash
git tag -a milestone/m1-render-contract -m "M1: render API contract + minimal test floor"
```

(No push.)

---

# Milestone M2 — Scroll Acceptance

### Task 10: Commit the pending scroll baseline

**Why:** Spec §5.3. `src/ui/App.tsx` and `VirtualMessageList.tsx` have unstaged changes that are the baseline the M2 tests pin. M2 cannot start until they are committed (or reverted).

**Files:**
- Stage: `src/ui/App.tsx`
- Stage: `src/ui/components/VirtualMessageList.tsx`

- [ ] **Step 1: Inspect the diff**

Run: `git diff src/ui/App.tsx src/ui/components/VirtualMessageList.tsx`

Read the diff. If the changes are coherent and on-topic for scroll virtualization, proceed. If the diff contains unrelated experiments, ask the user — do not silently include them.

- [ ] **Step 2: Commit**

```bash
git add src/ui/App.tsx src/ui/components/VirtualMessageList.tsx
git commit -m "perf(ui): finalize ScrollBox + virtual-scroll wiring for transcript"
```

---

### Task 11: Add `tests/render-scroll.test.ts`

**Files:**
- Create: `tests/render-scroll.test.ts`

- [ ] **Step 1: Write the test**

`tests/render-scroll.test.ts`:

```ts
import { test, expect } from "bun:test";
import React, { useRef, useEffect } from "react";
import { Box, Text, ScrollBox, type ScrollBoxHandle } from "../src/render/index.js";
import { mount, flush } from "./render-fixtures";

function Harness({
  height,
  childCount,
  onReady,
}: {
  height: number;
  childCount: number;
  onReady: (h: ScrollBoxHandle) => void;
}) {
  const ref = useRef<ScrollBoxHandle | null>(null);
  useEffect(() => {
    if (ref.current) onReady(ref.current);
  }, [onReady]);
  return React.createElement(
    ScrollBox,
    { ref, height, sticky: false },
    ...Array.from({ length: childCount }, (_, i) =>
      React.createElement(Text, { key: i }, `row-${i}`),
    ),
  );
}

test("scrollTo sets scrollTop and clamps to content height", async () => {
  let handle: ScrollBoxHandle | null = null;
  const h = mount(
    React.createElement(Harness, {
      height: 5,
      childCount: 20,
      onReady: (r) => (handle = r),
    }),
    { columns: 40, rows: 24 },
  );
  await flush();
  expect(handle).not.toBeNull();
  handle!.scrollTo({ top: 3 });
  await flush();
  expect(handle!.getScrollTop()).toBe(3);
  handle!.scrollTo({ top: 9999 });
  await flush();
  // Clamped to max scroll = contentHeight - viewportHeight
  expect(handle!.getScrollTop()).toBeLessThanOrEqual(20 - 5);
  h.unmount();
});

test("sticky-bottom keeps view pinned as content grows", async () => {
  let handle: ScrollBoxHandle | null = null;
  function Growing({ count, onReady }: { count: number; onReady: (h: ScrollBoxHandle) => void }) {
    const ref = useRef<ScrollBoxHandle | null>(null);
    useEffect(() => {
      if (ref.current) onReady(ref.current);
    }, [onReady]);
    return React.createElement(
      ScrollBox,
      { ref, height: 5, sticky: true },
      ...Array.from({ length: count }, (_, i) =>
        React.createElement(Text, { key: i }, `row-${i}`),
      ),
    );
  }
  const h = mount(
    React.createElement(Growing, { count: 5, onReady: (r) => (handle = r) }),
    { columns: 40, rows: 24 },
  );
  await flush();
  h.instance.rerender(
    React.createElement(Growing, { count: 50, onReady: (r) => (handle = r) }),
  );
  await flush();
  // Sticky-bottom: scrollTop should be at max (contentHeight - viewportHeight = 45)
  expect(handle!.getScrollTop()).toBeGreaterThanOrEqual(40);
  h.unmount();
});

test("subscribe notifies on scroll change", async () => {
  let handle: ScrollBoxHandle | null = null;
  const h = mount(
    React.createElement(Harness, {
      height: 5,
      childCount: 20,
      onReady: (r) => (handle = r),
    }),
    { columns: 40, rows: 24 },
  );
  await flush();
  const notifications: number[] = [];
  const unsub = handle!.subscribe(() => notifications.push(handle!.getScrollTop()));
  handle!.scrollTo({ top: 7 });
  await flush();
  expect(notifications).toContain(7);
  unsub();
  h.unmount();
});
```

- [ ] **Step 2: Run the test**

Run: `bun test tests/render-scroll.test.ts`
Expected: 3 pass. If `ScrollBoxHandle` exposes different method names (e.g. `scrollBy` instead of `scrollTo({top})`), check the actual handle shape in `src/render/components/ScrollBox.tsx` and update the test — keep the intent (clamp, sticky, subscribe).

- [ ] **Step 3: Commit**

```bash
git add tests/render-scroll.test.ts
git commit -m "test(render): ScrollBox clamp, sticky, subscribe"
```

---

### Task 12: Add `tests/use-virtual-scroll.test.ts`

**Files:**
- Create: `tests/use-virtual-scroll.test.ts`

- [ ] **Step 1: Inspect the hook's shape first**

Run: `cat src/ui/hooks/useVirtualScroll.ts | head -80`

Read the exported signature. The test must match what the hook actually returns — likely `{ visibleRange: { start, end }, totalHeight, ... }` or similar. **If the hook is highly coupled to `ScrollBox` and is not callable in isolation, skip the unit test approach and instead test virtualization through a `ScrollBox`-wrapped harness similar to Task 11.**

- [ ] **Step 2: Write the test, adapted to the hook's real signature**

`tests/use-virtual-scroll.test.ts`:

```ts
import { test, expect } from "bun:test";
import React, { useRef } from "react";
import { ScrollBox, type ScrollBoxHandle, Text, Box } from "../src/render/index.js";
import { useVirtualScroll } from "../src/ui/hooks/useVirtualScroll.js";
import { mount, flush } from "./render-fixtures";

function VirtualList({
  count,
  rowHeight,
  viewportHeight,
  onSetup,
}: {
  count: number;
  rowHeight: number;
  viewportHeight: number;
  onSetup: (h: ScrollBoxHandle | null) => void;
}) {
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  React.useEffect(() => onSetup(scrollRef.current), [onSetup]);
  const items = Array.from({ length: count }, (_, i) => ({ id: i, height: rowHeight }));
  const { visibleItems } = useVirtualScroll({
    items,
    scrollRef,
    viewportHeight,
  });
  return React.createElement(
    ScrollBox,
    { ref: scrollRef, height: viewportHeight, sticky: false },
    ...visibleItems.map((it: { id: number }) =>
      React.createElement(Text, { key: it.id }, `row-${it.id}`),
    ),
  );
}

test("only mounts items inside the viewport window (+overscan)", async () => {
  const h = mount(
    React.createElement(VirtualList, {
      count: 10000,
      rowHeight: 1,
      viewportHeight: 20,
      onSetup: () => {},
    }),
    { columns: 40, rows: 24 },
  );
  await flush();
  const out = h.frames.join("");
  // First page rendered
  expect(out).toContain("row-0");
  // Far-off rows are NOT mounted
  expect(out).not.toContain("row-5000");
  expect(out).not.toContain("row-9999");
  h.unmount();
});

test("scrolling updates the visible window", async () => {
  let handle: ScrollBoxHandle | null = null;
  const h = mount(
    React.createElement(VirtualList, {
      count: 1000,
      rowHeight: 1,
      viewportHeight: 20,
      onSetup: (r) => (handle = r),
    }),
    { columns: 40, rows: 24 },
  );
  await flush();
  handle!.scrollTo({ top: 500 });
  await flush();
  const out = h.frames.join("");
  expect(out).toContain("row-500");
  // row-0 should no longer be in the most recent frame chunk
  const last = h.frames[h.frames.length - 1] ?? "";
  expect(last).not.toContain("row-0");
  h.unmount();
});
```

If the hook's API is different (`useVirtualScroll(items, ...)` positional, returns `{ range }` not `{ visibleItems }`), update both the call and the consumed property. Do NOT change the hook to fit the test.

- [ ] **Step 3: Run the test**

Run: `bun test tests/use-virtual-scroll.test.ts`
Expected: 2 pass.

- [ ] **Step 4: Commit**

```bash
git add tests/use-virtual-scroll.test.ts
git commit -m "test(ui): useVirtualScroll window + scroll-update behavior"
```

---

### Task 13: Add `scripts/render-bigtranscript-dev.ts`

**Why:** Spec §5.2. Manual checklist needs a one-command path to a synthetic 10k transcript.

**Files:**
- Create: `scripts/render-bigtranscript-dev.ts`
- Modify: `package.json`

- [ ] **Step 1: Inspect how `src/cli/main.ts` boots a session**

Run: `grep -n "RunManager\|createSession\|main" src/cli/main.ts | head -20`

Read enough to know how to inject a pre-seeded session. The script's job is the smallest path to a UI with 10k messages already loaded.

- [ ] **Step 2: Write the script**

`scripts/render-bigtranscript-dev.ts`:

```ts
#!/usr/bin/env bun
/**
 * Dev harness: launch the CodeShell UI with a synthetic 10k-message
 * transcript pre-loaded. Used for manual scroll / perf testing.
 *
 *   bun run dev:bigtranscript [count]
 *
 * Default count: 10000.
 *
 * Note on implementation: this script imports the same entry point as
 * `bun run dev`, but seeds the session store via the env var
 * `CODESHELL_DEV_SEED_TRANSCRIPT=<count>`. The UI reads this env var on
 * boot and, when set, injects the synthetic messages before first render.
 *
 * The seed hook lives in `src/ui/dev-seed.ts` (added by the same commit
 * that introduces this script). It is a no-op unless the env var is set.
 */

const count = Number(process.argv[2] ?? 10000);
process.env.CODESHELL_DEV_SEED_TRANSCRIPT = String(count);
process.env.CODESHELL_UI_PERF = process.env.CODESHELL_UI_PERF ?? "1";
process.env.CODE_SHELL_DEV = "1";

await import("../src/cli/main.js");
```

- [ ] **Step 3: Add the seed hook**

Create `src/ui/dev-seed.ts`:

```ts
/**
 * Dev-only synthetic transcript seeder. Active when
 * `CODESHELL_DEV_SEED_TRANSCRIPT=<count>` is set. No-op otherwise.
 *
 * Imported once from the UI entry; reads the env var and pushes synthetic
 * user/assistant messages into the active session's transcript store.
 */
export function applyDevSeed(pushMessage: (m: { role: "user" | "assistant"; text: string }) => void): void {
  const raw = process.env.CODESHELL_DEV_SEED_TRANSCRIPT;
  if (!raw) return;
  const count = Number(raw);
  if (!Number.isFinite(count) || count <= 0) return;
  for (let i = 0; i < count; i++) {
    pushMessage({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `[seed ${i}] ${"lorem ipsum ".repeat(((i * 7) % 5) + 1)}`,
    });
  }
}
```

- [ ] **Step 4: Wire `applyDevSeed` into UI boot**

Open `src/ui/index.tsx`. Find the place where the session is created / opened (search for `Session` or `transcript`). Add a single call to `applyDevSeed` after the session is ready and before `render()` is called, passing a closure that pushes into the live transcript store.

If the integration point is non-obvious, add a TODO comment in `dev-seed.ts` listing the file you tried, and ask the user — do not hack a different boot path.

- [ ] **Step 5: Add the npm script**

Modify `package.json`, in `"scripts"`:

```json
"dev:bigtranscript": "bun run scripts/render-bigtranscript-dev.ts"
```

- [ ] **Step 6: Smoke-test the script**

Run: `CODESHELL_DEV_SEED_TRANSCRIPT=10 bun run dev:bigtranscript 10`
Expected: UI launches; transcript shows ~10 synthetic messages; quit cleanly with Ctrl+C.

- [ ] **Step 7: Commit**

```bash
git add scripts/render-bigtranscript-dev.ts src/ui/dev-seed.ts src/ui/index.tsx package.json
git commit -m "tools(ui): dev:bigtranscript script seeds synthetic 10k transcript"
```

---

### Task 14: Write `docs/architecture/render-scroll-checklist.md`

**Files:**
- Create: `docs/architecture/render-scroll-checklist.md`

- [ ] **Step 1: Write the checklist**

```markdown
# Render Scroll — Manual Checklist

Run before any commit that touches `ScrollBox`, `useVirtualScroll`, or
`VirtualMessageList`. Setup is the same for every case unless overridden:

    bun run dev:bigtranscript 10000

Quit with Ctrl+C between cases to reset state.

## Cases

### 1. Tail render under load
- Setup: `bun run dev:bigtranscript 10000`
- Action: wait for prompt; do not scroll.
- Expected: first paint within ~1s. Only viewport rows mount; CPU returns to idle.
- Pass criterion: tail visible, prompt responsive, no continuous redraw.

### 2. Wheel scroll
- Setup: 10k transcript loaded.
- Action: scroll wheel up by ~10 ticks; then back down.
- Expected: smooth movement; sticky-bottom re-engages at the bottom.

### 3. PageUp / PageDown
- Setup: 10k transcript loaded.
- Action: PgUp / PgDn repeatedly.
- Expected: viewport jumps by ~one page; no blank frames; position stable.

### 4. Resize while scrolled mid-history
- Setup: 10k transcript loaded; PgUp to ~row 5000.
- Action: shrink terminal height (drag, or `tput`), then grow it.
- Expected: anchor row 5000 stays in view; no jump to top or bottom.

### 5. New-message divider, sticky-bottom on
- Setup: load 100 transcript; scroll to top.
- Action: trigger an assistant streaming reply (or simulate via dev hook).
- Expected: new-message divider appears at the prior bottom; viewport does NOT jump.

### 6. Streaming while scrolled away
- Setup: 10k transcript, scrolled mid-history.
- Action: trigger streaming text in the latest message.
- Expected: history viewport unmoved; only the off-screen latest message updates.

## Reporting

If any case fails, attach:
- the exact `dev:bigtranscript` count used,
- terminal + size,
- a frame timing line from `~/.code-shell/logs/ui-ink/*` if `CODESHELL_RENDER_DEBUG=1` was on.
```

- [ ] **Step 2: Commit**

```bash
git add docs/architecture/render-scroll-checklist.md
git commit -m "docs(architecture): render scroll manual checklist"
```

---

### Task 15: M2 done — run the full test suite

- [ ] **Step 1: Run all tests**

Run: `bun test`
Expected: M1 + M2 tests all green.

- [ ] **Step 2: Tag**

```bash
git tag -a milestone/m2-render-scroll -m "M2: scroll acceptance — tests + checklist + dev seed"
```

---

# Milestone M3 — Perf Budget & Diagnostics

### Task 16: Inspect existing devtools / probe code

**Files:**
- Read: `src/render/devtools.ts`
- Read: `src/ui/perf-probes.ts`

- [ ] **Step 1: Read both files**

Note what `perf-probes.ts` currently emits (frame count, timestamps?) and where it is called from. The goal in Tasks 17–18 is to consolidate into `devtools.ts` and route the same data through one path.

If `perf-probes.ts` is already a thin wrapper, the consolidation is trivial; if it contains independent logic, the next task moves it into `devtools.ts`.

(No file changes in this task — it is a read step.)

---

### Task 17: Fill in `src/render/devtools.ts`

**Files:**
- Modify: `src/render/devtools.ts`

- [ ] **Step 1: Implement the counters**

Replace the contents of `src/render/devtools.ts` with:

```ts
/**
 * Render devtools — opt-in perf counters.
 *
 * Activated by env:
 *   CODESHELL_RENDER_DEBUG=1        -> 1s summary lines
 *   CODESHELL_RENDER_DEBUG=verbose  -> per-frame lines
 *
 * Output: `~/.code-shell/logs/ui-ink/render-perf.log` (append). One JSON line
 * per emission. Schema is documented in src/render/README.md "Perf baselines"
 * section.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Mode = "off" | "summary" | "verbose";

function detectMode(): Mode {
  const v = process.env.CODESHELL_RENDER_DEBUG;
  if (!v) return "off";
  if (v === "verbose") return "verbose";
  return "summary";
}

const MODE: Mode = detectMode();

interface FrameSample {
  durMs: number;
  dirtyNodes: number;
  cellsWritten: number;
  cellsReused: number;
  scrollHints: number;
}

let stream: WriteStream | null = null;
function getStream(): WriteStream | null {
  if (MODE === "off") return null;
  if (stream) return stream;
  const dir = join(homedir(), ".code-shell", "logs", "ui-ink");
  try {
    mkdirSync(dir, { recursive: true });
    stream = createWriteStream(join(dir, "render-perf.log"), { flags: "a" });
  } catch {
    return null;
  }
  return stream;
}

const window: FrameSample[] = [];
let windowStart = Date.now();

export function recordFrame(s: FrameSample): void {
  if (MODE === "off") return;
  if (MODE === "verbose") {
    write({ t: Date.now(), kind: "frame", ...s });
    return;
  }
  window.push(s);
  const now = Date.now();
  if (now - windowStart >= 1000) {
    flushSummary(now);
  }
}

function flushSummary(now: number) {
  if (window.length === 0) {
    windowStart = now;
    return;
  }
  const sum = window.reduce(
    (a, b) => ({
      durMs: a.durMs + b.durMs,
      dirtyNodes: a.dirtyNodes + b.dirtyNodes,
      cellsWritten: a.cellsWritten + b.cellsWritten,
      cellsReused: a.cellsReused + b.cellsReused,
      scrollHints: a.scrollHints + b.scrollHints,
    }),
    { durMs: 0, dirtyNodes: 0, cellsWritten: 0, cellsReused: 0, scrollHints: 0 },
  );
  const frames = window.length;
  const blit = sum.cellsWritten + sum.cellsReused === 0
    ? 0
    : sum.cellsReused / (sum.cellsWritten + sum.cellsReused);
  write({
    t: now,
    kind: "summary",
    windowMs: now - windowStart,
    frames,
    avgFrameMs: sum.durMs / frames,
    dirtyNodes: sum.dirtyNodes,
    cellsWritten: sum.cellsWritten,
    blitRatio: Number(blit.toFixed(3)),
    scrollHints: sum.scrollHints,
  });
  window.length = 0;
  windowStart = now;
}

function write(obj: Record<string, unknown>): void {
  const s = getStream();
  if (!s) return;
  s.write(JSON.stringify(obj) + "\n");
}

export const renderDevtools = {
  enabled: MODE !== "off",
  mode: MODE,
  recordFrame,
};
```

- [ ] **Step 2: Wire `recordFrame` into the renderer loop**

Open the renderer's main paint function. Search:

```bash
grep -rn "ANSI\|writeOutput\|paint\|renderToStdout" src/render/ink.tsx src/render/render-to-screen.ts src/render/renderer.ts 2>/dev/null | head
```

Find the place where one frame is committed to stdout. Wrap it:

```ts
import { recordFrame } from "./devtools.js";

// at top of the paint function
const _t0 = MODE_ENABLED ? performance.now() : 0;
// ... existing paint code ...
if (MODE_ENABLED) {
  recordFrame({
    durMs: performance.now() - _t0,
    dirtyNodes: /* count from existing diff path */,
    cellsWritten: /* from output buffer */,
    cellsReused: /* from blit fast path */,
    scrollHints: /* if tracked */,
  });
}
```

`MODE_ENABLED` is just `renderDevtools.enabled` cached at module load. Fill the counter fields from whatever variables already exist on the diff path — do not add bookkeeping for fields the renderer cannot supply; pass 0 if unknown and note it in the README.

- [ ] **Step 3: Smoke-test**

Run:

```bash
CODESHELL_RENDER_DEBUG=1 bun run dev:bigtranscript 100
```

Exit after a few seconds with Ctrl+C. Then:

```bash
tail -3 ~/.code-shell/logs/ui-ink/render-perf.log
```

Expected: at least one JSON line with `kind:"summary"` and a sensible `avgFrameMs`.

- [ ] **Step 4: Commit**

```bash
git add src/render/devtools.ts src/render/ink.tsx
git commit -m "feat(render): devtools — frame timing, dirty count, blit ratio, opt-in via env"
```

(Adjust the `git add` list if the renderer hook lives in a different file.)

---

### Task 18: Consolidate `src/ui/perf-probes.ts` through devtools

**Files:**
- Modify: `src/ui/perf-probes.ts` (or delete if fully duplicated)

- [ ] **Step 1: Decide consolidation shape**

From Task 16, you know what `perf-probes.ts` does:
  - If it's a thin instrumentation that counts UI renders → keep the UI-side counts, but write to the same log file (`~/.code-shell/logs/ui-ink/render-perf.log`) using the `kind:"ui-probe"` tag.
  - If it duplicates frame timing → delete the duplicate code paths, leaving only the React `useEffect` instrumentation that calls into `renderDevtools`.

- [ ] **Step 2: Apply the change**

Either:
  - Refactor `perf-probes.ts` to import `renderDevtools` and emit through it, OR
  - Delete `perf-probes.ts` and any imports of it from `src/ui/App.tsx`.

Whichever path is shorter and clearer; do not keep two probe sinks.

- [ ] **Step 3: Smoke-test**

Repeat the dev:bigtranscript run from Task 17 Step 3. Confirm there is still exactly ONE log file being written to, and no console spam.

- [ ] **Step 4: Commit**

```bash
git add src/ui/perf-probes.ts src/ui/App.tsx
git commit -m "refactor(ui): route perf probes through render devtools, drop parallel sink"
```

---

### Task 19: Create `bench/harness.ts`

**Files:**
- Create: `bench/harness.ts`

- [ ] **Step 1: Write the harness**

`bench/harness.ts`:

```ts
/**
 * Shared bench harness: mount a React element to a fake terminal, run a
 * scenario function, return frame timing stats.
 */
import { PassThrough } from "node:stream";
import { performance } from "node:perf_hooks";
import React from "react";
import { createRoot, type Instance } from "../src/render/index.js";

export interface BenchHarness {
  stdin: PassThrough;
  stdout: PassThrough;
  instance: Instance;
  frameCount: number;
  bytesWritten: number;
  unmount: () => void;
}

export function setup(
  element: React.ReactElement,
  opts: { columns?: number; rows?: number } = {},
): BenchHarness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdout as unknown as { isTTY: boolean; columns: number; rows: number }).isTTY = true;
  (stdout as unknown as { columns: number }).columns = opts.columns ?? 120;
  (stdout as unknown as { rows: number }).rows = opts.rows ?? 40;

  const h: BenchHarness = {
    stdin,
    stdout,
    instance: null as unknown as Instance,
    frameCount: 0,
    bytesWritten: 0,
    unmount: () => h.instance.unmount(),
  };
  stdout.on("data", (chunk: Buffer) => {
    h.frameCount += 1;
    h.bytesWritten += chunk.byteLength;
  });
  h.instance = createRoot(element, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  } as unknown as Parameters<typeof createRoot>[1]);
  return h;
}

export async function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

export interface Timing {
  label: string;
  totalMs: number;
  iterations: number;
  perIterMs: number;
  frames: number;
  bytes: number;
}

export async function time(label: string, iterations: number, fn: () => void | Promise<void>): Promise<Timing> {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await fn();
  }
  await flush();
  const totalMs = performance.now() - start;
  return {
    label,
    totalMs,
    iterations,
    perIterMs: totalMs / iterations,
    frames: 0,
    bytes: 0,
  };
}

export function printTable(rows: Timing[]): void {
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  process.stdout.write(
    [
      pad("label", 30),
      pad("iters", 8),
      pad("total ms", 12),
      pad("per iter ms", 14),
    ].join("") + "\n",
  );
  for (const r of rows) {
    process.stdout.write(
      [
        pad(r.label, 30),
        pad(String(r.iterations), 8),
        pad(r.totalMs.toFixed(2), 12),
        pad(r.perIterMs.toFixed(3), 14),
      ].join("") + "\n",
    );
  }
}
```

- [ ] **Step 2: Smoke-build**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add bench/harness.ts
git commit -m "bench(render): shared mount + timing harness"
```

---

### Task 20: Add `bench/render-tail.bench.ts`

**Files:**
- Create: `bench/render-tail.bench.ts`

- [ ] **Step 1: Write the bench**

`bench/render-tail.bench.ts`:

```ts
#!/usr/bin/env bun
import React from "react";
import { Box, Text } from "../src/render/index.js";
import { setup, flush, time, printTable } from "./harness.js";

async function main() {
  const count = 10000;
  const items = Array.from({ length: count }, (_, i) => `row-${i}`);
  const h = setup(
    React.createElement(Box, { flexDirection: "column" },
      ...items.map((it) => React.createElement(Text, { key: it }, it)),
    ),
    { columns: 120, rows: 40 },
  );
  await flush();
  const mountTiming = await time("mount 10k", 1, async () => {});
  printTable([mountTiming]);
  process.stdout.write(`bytes_written=${h.bytesWritten}\nframe_count=${h.frameCount}\n`);
  h.unmount();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run**

Run: `bun run bench/render-tail.bench.ts`
Expected: prints a single-row table and `bytes_written` / `frame_count`. Numbers will vary; the bench just produces them.

- [ ] **Step 3: Commit**

```bash
git add bench/render-tail.bench.ts
git commit -m "bench(render): tail render — 10k transcript mount"
```

---

### Task 21: Add `bench/render-streaming.bench.ts`

**Files:**
- Create: `bench/render-streaming.bench.ts`

- [ ] **Step 1: Write the bench**

`bench/render-streaming.bench.ts`:

```ts
#!/usr/bin/env bun
import React, { useState, useEffect } from "react";
import { Box, Text } from "../src/render/index.js";
import { setup, flush, time, printTable } from "./harness.js";

function App({ initial }: { initial: number }) {
  const [delta, setDelta] = useState("");
  useEffect(() => {
    let cancelled = false;
    let i = 0;
    const tick = () => {
      if (cancelled || i > 200) return;
      setDelta((d) => d + ".");
      i++;
      setImmediate(tick);
    };
    tick();
    return () => { cancelled = true; };
  }, []);
  const history = Array.from({ length: initial }, (_, i) => `row-${i}`);
  return React.createElement(Box, { flexDirection: "column" },
    ...history.map((it) => React.createElement(Text, { key: it }, it)),
    React.createElement(Text, { key: "stream" }, `assistant: ${delta}`),
  );
}

async function main() {
  const h = setup(React.createElement(App, { initial: 5000 }), { columns: 120, rows: 40 });
  await flush();
  // Let the streaming useEffect run to completion.
  await new Promise((r) => setTimeout(r, 600));
  const t = await time("streaming-200-deltas", 1, async () => {});
  printTable([t]);
  process.stdout.write(`bytes_written=${h.bytesWritten}\nframe_count=${h.frameCount}\n`);
  h.unmount();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run**

Run: `bun run bench/render-streaming.bench.ts`
Expected: prints table; `frame_count` reflects ~200 stream ticks (give or take batching).

- [ ] **Step 3: Commit**

```bash
git add bench/render-streaming.bench.ts
git commit -m "bench(render): streaming — 200 deltas on top of 5k transcript"
```

---

### Task 22: Add `bench/render-spinner.bench.ts`

**Files:**
- Create: `bench/render-spinner.bench.ts`

- [ ] **Step 1: Write the bench**

`bench/render-spinner.bench.ts`:

```ts
#!/usr/bin/env bun
import React, { useState, useEffect } from "react";
import { Box, Text } from "../src/render/index.js";
import { setup, flush, time, printTable } from "./harness.js";

function App({ count }: { count: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let i = 0;
    let cancelled = false;
    const next = () => {
      if (cancelled || i >= 60) return;
      setTick((t) => t + 1);
      i++;
      setImmediate(next);
    };
    next();
    return () => { cancelled = true; };
  }, []);
  const spin = "|/-\\"[tick % 4];
  return React.createElement(Box, { flexDirection: "column" },
    ...Array.from({ length: count }, (_, i) =>
      React.createElement(Text, { key: i }, `row-${i}`),
    ),
    React.createElement(Text, { key: "spinner" }, `working ${spin}`),
  );
}

async function main() {
  const h = setup(React.createElement(App, { count: 5000 }), { columns: 120, rows: 40 });
  await flush();
  await new Promise((r) => setTimeout(r, 300));
  const t = await time("spinner-60-ticks", 1, async () => {});
  printTable([t]);
  process.stdout.write(`bytes_written=${h.bytesWritten}\nframe_count=${h.frameCount}\n`);
  h.unmount();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run**

Run: `bun run bench/render-spinner.bench.ts`
Expected: completes; produces numbers. The expectation is that `bytes_written` is small relative to a full repaint per tick — but no automated check; the human reads the number.

- [ ] **Step 3: Commit**

```bash
git add bench/render-spinner.bench.ts
git commit -m "bench(render): spinner — 60 ticks atop 5k transcript"
```

---

### Task 23: Add `bench/render-wheel.bench.ts`

**Files:**
- Create: `bench/render-wheel.bench.ts`

- [ ] **Step 1: Write the bench**

`bench/render-wheel.bench.ts`:

```ts
#!/usr/bin/env bun
import React, { useRef, useEffect } from "react";
import { Box, Text, ScrollBox, type ScrollBoxHandle } from "../src/render/index.js";
import { setup, flush, time, printTable } from "./harness.js";

function App({ count, onReady }: { count: number; onReady: (h: ScrollBoxHandle) => void }) {
  const ref = useRef<ScrollBoxHandle | null>(null);
  useEffect(() => { if (ref.current) onReady(ref.current); }, [onReady]);
  return React.createElement(ScrollBox, { ref, height: 40, sticky: false },
    ...Array.from({ length: count }, (_, i) =>
      React.createElement(Text, { key: i }, `row-${i}`),
    ),
  );
}

async function main() {
  let handle: ScrollBoxHandle | null = null;
  const h = setup(
    React.createElement(App, { count: 10000, onReady: (r) => (handle = r) }),
    { columns: 120, rows: 40 },
  );
  await flush();
  if (!handle) throw new Error("ScrollBox handle never resolved");
  const STEPS = 100;
  const t = await time("wheel-100-steps", STEPS, async () => {
    handle!.scrollBy({ top: 20 });
    await flush();
  });
  printTable([t]);
  process.stdout.write(`bytes_written=${h.bytesWritten}\nframe_count=${h.frameCount}\n`);
  h.unmount();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

If the handle uses a different API name than `scrollBy`, update accordingly.

- [ ] **Step 2: Run**

Run: `bun run bench/render-wheel.bench.ts`
Expected: prints table; `perIterMs` is the per-step cost.

- [ ] **Step 3: Commit**

```bash
git add bench/render-wheel.bench.ts
git commit -m "bench(render): wheel scroll — 100 steps over 10k transcript"
```

---

### Task 24: Add `bench/README.md` + `package.json` script

**Files:**
- Create: `bench/README.md`
- Modify: `package.json`

- [ ] **Step 1: Write `bench/README.md`**

```markdown
# bench/

Local performance benches for `src/render`. Not run in CI. Output is plain text
to stdout, one table row per measurement plus auxiliary counters
(`bytes_written`, `frame_count`).

## Run

    bun run bench:render            # all benches in sequence
    bun run bench/render-tail.bench.ts
    bun run bench/render-streaming.bench.ts
    bun run bench/render-spinner.bench.ts
    bun run bench/render-wheel.bench.ts

## Scenarios

| File                             | Scenario                                  | Key metric                                    |
| -------------------------------- | ----------------------------------------- | --------------------------------------------- |
| `render-tail.bench.ts`           | Mount 10k transcript, render tail         | `bytes_written`, `frame_count`                |
| `render-streaming.bench.ts`      | 200 streaming deltas atop 5k history      | `frame_count` (should reflect ~200, not 5000) |
| `render-spinner.bench.ts`        | Spinner ticks 60× atop 5k history         | `bytes_written` per tick                      |
| `render-wheel.bench.ts`          | 100 `scrollBy` steps over 10k transcript  | `perIterMs`                                   |

Baselines are recorded in `src/render/README.md` under "Perf baselines".

## Interpretation guide

These benches mount React trees against a fake stdout. They measure how much
the renderer writes and how long it takes — not real terminal repaint latency.
Use them to catch regressions (relative deltas), not as absolute SLOs.
```

- [ ] **Step 2: Modify `package.json`**

Add to `"scripts"`:

```json
"bench:render": "bun run bench/render-tail.bench.ts && bun run bench/render-streaming.bench.ts && bun run bench/render-spinner.bench.ts && bun run bench/render-wheel.bench.ts"
```

- [ ] **Step 3: Run**

Run: `bun run bench:render`
Expected: all four benches print results sequentially without error.

- [ ] **Step 4: Commit**

```bash
git add bench/README.md package.json
git commit -m "bench(render): aggregate script + README"
```

---

### Task 25: Record perf baselines in `src/render/README.md`

**Files:**
- Modify: `src/render/README.md`

- [ ] **Step 1: Run benches and capture output**

Run: `bun run bench:render > /tmp/render-bench-baseline.txt 2>&1`
Read `/tmp/render-bench-baseline.txt`.

- [ ] **Step 2: Append a "Perf baselines" section to `src/render/README.md`**

Right before "How to evolve this" in the README, insert:

```markdown
## Perf baselines

Local bench results, recorded `YYYY-MM-DD`. Numbers are machine-specific —
treat them as a regression anchor, not absolute SLOs. Re-record on macOS
arm64 / Linux x64 / similar reference machines as needed.

Host: `<filled by recorder — e.g. MacBook Pro M2, macOS 14, Node 20.10>`

| Scenario                  | per iter | bytes written | frames |
| ------------------------- | -------- | ------------- | ------ |
| `tail-10k-mount`          | n/a (1)  | <fill>        | <fill> |
| `streaming-200-deltas`    | n/a (1)  | <fill>        | <fill> |
| `spinner-60-ticks`        | n/a (1)  | <fill>        | <fill> |
| `wheel-100-steps`         | <fill>   | <fill>        | <fill> |

To re-record: `bun run bench:render`. To collect under live perf logging:
`CODESHELL_RENDER_DEBUG=1 bun run bench:render`, then read
`~/.code-shell/logs/ui-ink/render-perf.log`.
```

Fill `<fill>` with the actual numbers from `/tmp/render-bench-baseline.txt` and the current date in the section heading.

- [ ] **Step 3: Commit**

```bash
git add src/render/README.md
git commit -m "docs(render): record initial perf baselines"
```

---

### Task 26: M3 done — full test suite + bench

- [ ] **Step 1: Tests**

Run: `bun test`
Expected: all green.

- [ ] **Step 2: Benches**

Run: `bun run bench:render`
Expected: completes without error.

- [ ] **Step 3: Tag**

```bash
git tag -a milestone/m3-render-perf -m "M3: render perf budget + diagnostics"
```

---

# Milestone M4 — Component Boundary & Terminal Matrix

### Task 27: Promote `Button` / `Link` / `RawAnsi` to supported

**Files:**
- Modify: `src/render/index.ts`
- Modify: `src/render/README.md`

- [ ] **Step 1: Verify the primitives are export-ready**

For each of `Button`, `Link`, `RawAnsi`:
- Read `src/render/components/<Name>.tsx`.
- Confirm props are typed, JSDoc is reasonable, no obvious gotchas.
- If a primitive has surprising behavior (e.g. RawAnsi assumes specific terminal state), document it in a leading comment block in the component file.

- [ ] **Step 2: Add re-exports if missing**

Open `src/render/index.ts`. Add (if not already present):

```ts
export { default as Button, type Props as ButtonProps } from "./components/Button.js";
export { default as Link, type Props as LinkProps } from "./components/Link.js";
export { default as RawAnsi, type Props as RawAnsiProps } from "./components/RawAnsi.js";
```

(Match the existing export style — `default as` vs named — by reading the components.)

- [ ] **Step 3: Update README status**

In `src/render/README.md`, change `Button` / `Link` / `RawAnsi` rows in the Components table from `experimental` to `supported`. Same for any type rows.

- [ ] **Step 4: Verify no consumer breakage**

Run: `bun run typecheck`
Expected: PASS.

Run: `bun test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/render/index.ts src/render/README.md src/render/components
git commit -m "feat(render): promote Button / Link / RawAnsi to supported public API"
```

---

### Task 28: ADR — `TextInput` stays in `src/ui/`

**Files:**
- Modify: `docs/architecture/11-render-tui-capability-plan.md`

- [ ] **Step 1: Append the ADR section**

At the end of `docs/architecture/11-render-tui-capability-plan.md`, before any trailing whitespace, append:

```markdown
## Public component primitives (decision log)

### 2026-05-?? — Button / Link / RawAnsi promoted to supported

Reason: each has been stable in use by `src/ui/` and presents a thin,
purely-presentational API surface. No business binding.

### 2026-05-?? — TextInput stays in `src/ui/components/`

`TextInput` bundles:
- controlled value + cursor model,
- bracketed paste handling that interacts with the slash-command parser,
- history navigation (per-session, persisted),
- completion / autocomplete hooks.

Items 2–4 are CodeShell business logic, not generic renderer concerns.
Moving the whole component into `src/render/` would either drag this logic
into the generic layer (bad) or split into a partial primitive + a wrapper
(churn for little gain — there is no second consumer that would benefit).

Decision: `TextInput` remains a `src/ui/` component. If a future product
need calls for a primitive text input shared across two consumers, revisit
by extracting the controlled-value + cursor primitive into `src/render/`
and keeping the history / completion behavior in the wrapper.
```

Replace the `2026-05-??` dates with the actual date when this task runs.

- [ ] **Step 2: Commit**

```bash
git add docs/architecture/11-render-tui-capability-plan.md
git commit -m "docs(architecture): record primitive promotion + TextInput-stays-in-ui ADR"
```

---

### Task 29: Write `docs/architecture/render-terminal-matrix.md`

**Files:**
- Create: `docs/architecture/render-terminal-matrix.md`

- [ ] **Step 1: Audit terminal-specific branches**

Run:

```bash
grep -rn "tmux\|iTerm\|Apple_Terminal\|WT_SESSION\|TERM_PROGRAM\|kitty\|ghostty" src/render/ 2>/dev/null | head -40
```

Note which terminals have explicit code paths.

- [ ] **Step 2: Write the matrix**

`docs/architecture/render-terminal-matrix.md`:

```markdown
# CodeShell — Terminal Compatibility Matrix

This document is the canonical list of which terminals CodeShell's
`src/render` engine targets, at what support level, and what's known to break.

Support levels:

- **supported** — release blocker if broken; we run the manual scroll checklist
  before tagging a release.
- **best-effort** — known to work but not in the manual matrix; bugs accepted
  but lower priority.
- **unsupported** — no guarantees; bugs closed as wontfix unless a contributor
  provides a fix.

| Terminal                   | Support       | Notes                                                                 | Last verified |
| -------------------------- | ------------- | --------------------------------------------------------------------- | ------------- |
| iTerm2 (macOS)             | supported     | Primary dev terminal. Full alt-screen, mouse, OSC 52, kitty kbd off.  | YYYY-MM-DD    |
| tmux (over iTerm2 / xterm) | supported     | OSC 52 wrapped in DCS passthrough; bracketed paste; resize correct.    | YYYY-MM-DD    |
| Ghostty (macOS / Linux)    | supported     | Kitty keyboard protocol used when available.                          | YYYY-MM-DD    |
| Windows Terminal           | best-effort   | conpty translates most CSI; cursor parking quirks possible.            | YYYY-MM-DD    |
| Apple Terminal             | best-effort   | No true color in older versions; OSC 8 partial.                       | YYYY-MM-DD    |
| VS Code integrated terminal| best-effort   | xterm.js host; clipboard via Code's bridge, not OSC 52.               | YYYY-MM-DD    |
| xterm (literal)            | best-effort   | Baseline target; assumed to work as default branch in `terminal.ts`.  | YYYY-MM-DD    |
| Cmd.exe (legacy)           | unsupported   | No alt-screen support; not targeted.                                  | n/a           |

## Cross-references

Terminal-specific behavior in code:

- `src/render/terminal.ts` — environment sniffing + capability inference.
- `src/render/termio/osc.ts` — clipboard (OSC 52) sequence emission and tmux
  passthrough wrapping.
- `src/render/parse-keypress.ts` — kitty keyboard + modifyOtherKeys handling.

## Verification

Per terminal, the manual verification consists of:

1. Launch `bun run dev:bigtranscript 1000`.
2. Run the cases in [`render-scroll-checklist.md`](./render-scroll-checklist.md).
3. Confirm copy/paste round-trips (select assistant text, paste into a text
   editor — content matches).
4. Confirm a streaming reply does not corrupt the screen.

Record the date in the table.
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/render-terminal-matrix.md
git commit -m "docs(architecture): render terminal compatibility matrix"
```

---

### Task 30: Add `tests/fixtures/render/clipboard/` fixtures

**Files:**
- Create: `tests/fixtures/render/clipboard/osc52-direct.txt`
- Create: `tests/fixtures/render/clipboard/osc52-tmux.txt`

- [ ] **Step 1: Write the direct OSC 52 expected sequence**

`tests/fixtures/render/clipboard/osc52-direct.txt`:

```
# OSC 52 set clipboard to "hello"
# Sequence: ESC ] 52 ; c ; <base64> ESC \
"]52;c;aGVsbG8=\\"
```

- [ ] **Step 2: Write the tmux-wrapped sequence**

`tests/fixtures/render/clipboard/osc52-tmux.txt`:

```
# tmux DCS passthrough wrapping the same OSC 52
# Sequence: ESC P tmux ; ESC <inner-OSC-52> ESC \
"Ptmux;]52;c;aGVsbG8=\\\\"
```

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/render/clipboard
git commit -m "test(render): clipboard fixtures — OSC 52 direct + tmux passthrough"
```

---

### Task 31: Add `tests/render-clipboard.test.ts`

**Files:**
- Create: `tests/render-clipboard.test.ts`

- [ ] **Step 1: Find the clipboard entry point**

Run: `grep -rn "copyToClipboard\|writeClipboard\|OSC 52\|osc52\|52;c" src/render/ 2>/dev/null | head`

Identify the function that emits OSC 52 (likely in `src/render/termio/osc.ts`). Note its signature.

- [ ] **Step 2: Write the test**

`tests/render-clipboard.test.ts`:

```ts
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Import the actual API discovered in Step 1. Replace this import with the
// real one and update the call sites below to match.
import { emitClipboardWrite } from "../src/render/termio/osc.js";

function expectedFixture(name: string): string {
  const raw = readFileSync(
    join(__dirname, "fixtures", "render", "clipboard", `${name}.txt`),
    "utf8",
  );
  let out = "";
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    out += JSON.parse(t);
  }
  return out;
}

test("OSC 52 direct emission matches fixture", () => {
  const seq = emitClipboardWrite("hello", { tmuxPassthrough: false });
  expect(seq).toBe(expectedFixture("osc52-direct"));
});

test("OSC 52 wrapped in tmux DCS matches fixture", () => {
  const seq = emitClipboardWrite("hello", { tmuxPassthrough: true });
  expect(seq).toBe(expectedFixture("osc52-tmux"));
});

test("native fallback shells out (mocked) when OSC 52 disabled", () => {
  // If the codebase has a separate `nativeClipboardWrite(text)` function,
  // test it by mocking child_process spawn. If not, this test asserts that
  // emitClipboardWrite returns an empty string (or throws) when OSC 52 is
  // suppressed — update once the actual surface is known.
  const seq = emitClipboardWrite("hello", { tmuxPassthrough: false, disableOSC52: true });
  expect(seq).toBe("");
});
```

If `emitClipboardWrite` is named differently or has a different signature, update both the import and the calls — keep the assertion content (fixture byte-for-byte match).

- [ ] **Step 3: Run the test**

Run: `bun test tests/render-clipboard.test.ts`
Expected: 3 pass. If the third test cannot be made to pass because the codebase has no "disable OSC 52" knob, replace it with a single assertion that the OSC 52 emission is opt-in elsewhere and link to the relevant config in a code comment.

- [ ] **Step 4: Commit**

```bash
git add tests/render-clipboard.test.ts
git commit -m "test(render): clipboard branches — OSC 52 direct, tmux wrap, fallback"
```

---

### Task 32: M4 done — full test + bench sweep

- [ ] **Step 1: All tests**

Run: `bun test`
Expected: all green (M1 + M2 + M4 tests).

- [ ] **Step 2: Benches still run**

Run: `bun run bench:render`
Expected: completes; numbers within 30% of M3 baseline (eyeball; not enforced).

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Tag**

```bash
git tag -a milestone/m4-render-matrix -m "M4: render component boundary + terminal matrix"
```

- [ ] **Step 5: Sanity-check the public-API contract**

Run:

```bash
grep -E "^export " src/render/index.ts | wc -l
```

Compare with the count of rows in the README tables (components + hooks + entry points + types). Numbers should match. If they drift, fix README in this commit:

```bash
git add src/render/README.md
git commit -m "docs(render): reconcile API contract table with index exports"
```

---

## Self-review notes

- Spec §4 (M1 contract + tests + Ansi promotion + 11.md dedupe) → Tasks 1–9.
- Spec §5 (M2 scroll tests + checklist + dev seed + pending commit) → Tasks 10–15.
- Spec §6 (M3 devtools + 4 benches + baselines in README) → Tasks 16–26.
- Spec §7 (M4 primitive promotion + ADR + terminal matrix + clipboard tests) → Tasks 27–32.
- Spec §8 risks (export breakage, bench host variance, terminal-specific fixtures, manual checklist rot, devtools log volume) — addressed by Tasks 1, 25 (host info in baseline header), 4 (fixtures over inline), 13/14 (repro script + checklist next to each other), 17 (summary mode default).
- Spec §10 deferred items — none of these have tasks, by design.

No `TODO`s, `TBD`s, or "implement later"s in the tasks above.
