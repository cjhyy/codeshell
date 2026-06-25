# review

**One-line role.** Builds the structured code-review instruction (prompt) sent to the model for the `/review` command.

## 职责 / Responsibility

This module is a pure, testable prompt builder for the `/review` slash command (TODO 7.3). It turns a unified diff or full-file content into an LLM instruction that asks for prioritized (P0–P3), confidence-scored, location-precise findings across four review dimensions. It does **not** gather the diff, call the model, or parse the response — the TUI/desktop command does the I/O and the model does the reasoning. The module's only job is to assemble a consistent, optionally machine-readable (`--json`) prompt string.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `review-prompt.ts` | The entire module: dimension types, `parseDimensions`, and `buildReviewPrompt`. |
| `review-prompt.test.ts` | `bun:test` coverage for dimension parsing, fence selection, JSON mode, truncation, and labels. |

## 公开接口 / Public API

All re-exported from the package root (`@codeshell/core` `src/index.ts`).

```ts
type ReviewDimension = "security" | "performance" | "readability" | "correctness";

const ALL_DIMENSIONS: ReviewDimension[]; // canonical order: correctness, security, performance, readability

interface ReviewPromptOptions {
  content: string;             // unified diff (incremental) or full file contents
  dimensions?: ReviewDimension[]; // defaults to all four
  incremental?: boolean;       // true = diff (```diff fence); false = whole file (plain fence + "code" wording)
  json?: boolean;              // emit a machine-readable JSON findings array instead of prose
  label?: string;              // e.g. a file path, shown as `for \`<label>\``
  maxChars?: number;           // truncate content (default 12000)
}

// Normalize a comma/space list of dimension names; unknown names dropped,
// falls back to ALL_DIMENSIONS if input is empty or yields none. Result keeps canonical order.
function parseDimensions(input: string | undefined): ReviewDimension[];

// Assemble the review instruction string.
function buildReviewPrompt(opts: ReviewPromptOptions): string;
```

## 怎么用 / How to use

Real call site: the TUI `/review` command (`packages/tui/src/cli/commands/builtin/git-commands.ts`). It parses flags, fetches the git diff itself, builds the prompt, then runs it through the client.

```ts
import { buildReviewPrompt, parseDimensions } from "@codeshell/core";

// --dimensions=security,performance  → ["security","performance"]; bad/empty → all four
const dimensions = parseDimensions(dimFlag?.split("=")[1]);

const diff = getGitDiff(cwd, { file, staged });
if (!diff) return; // nothing to review

const prompt = buildReviewPrompt({
  content: diff,
  dimensions,
  incremental: true, // reviewing a diff
  json,              // from --json flag
  label: file,       // optional scoped path
});

const result = await client.run(prompt, sessionId);
```

Full-file (non-incremental) review uses a plain fence and "code" wording:

```ts
const prompt = buildReviewPrompt({
  content: fileContents,
  incremental: false,
  label: "src/a.ts",
});
```

## 注意 / Gotchas

- **Pure function, no I/O.** It never reads git, files, or calls the model — callers must supply `content` and run the returned prompt. Don't add side effects here.
- **`parseDimensions` never returns empty.** Empty/whitespace input and all-unknown input both fall back to `ALL_DIMENSIONS`; a partially-valid list keeps only the recognized names (`"security,bogus"` → `["security"]`).
- **Output order is canonical, not input order.** Dimensions are filtered from `ALL_DIMENSIONS`, so `parseDimensions("readability correctness")` returns `["correctness","readability"]`.
- **Content is truncated to `maxChars` (default 12000)** with a `…(truncated)…` marker appended — large diffs are silently clipped, so the model may not see the whole change.
- **`incremental` defaults to diff behavior.** Only an explicit `incremental: false` switches to the plain (whole-file) fence and wording; `undefined` is treated as a diff.
- **`json: true` demands a bare JSON object** (no prose, no markdown fence) with a fixed finding shape (`priority`/`dimension`/`confidence`/`location`/`title`/`detail`/`suggestion`). Dimension labels are bilingual (Chinese label + English hint); don't strip the Chinese — a test asserts on `安全`/`性能`.
- **ESM import paths use `.js`** (e.g. `from "./review-prompt.js"`) per the package's NodeNext resolution, even though the source is `.ts`.
