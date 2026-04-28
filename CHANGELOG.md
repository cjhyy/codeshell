# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and while the project is pre-1.0 we treat any 0.x → 0.(x+1) bump as potentially
breaking.

## [Unreleased]

### Added
- **`IterativeArena` — multi-model authoring loop.** Pipeline: tournament v1
  (every participant writes a draft, the author merges anonymized drafts into
  v1) → critique-revise rounds (parallel critics produce anchored critiques
  with severity/category, author rewrites). Two formats out of the box: `code`
  and `document`. Configurable convergence (default: stop when no blockers
  remain and either all critiques are minor/praise or the draft barely moved),
  optional `humanCheckpoint` for interactive use, and `authorRotation` of
  `fixed` / `round-robin` / `best-critic`. Public API exported from
  `src/index.ts`. New types: `IterateConfig`, `IterateResult`, `Draft`,
  `Critique`, `ConvergenceSignal`, `Round`, etc.
  - Use `IterativeArena` to **produce** a draft from scratch (PRD, design doc,
    code module). Use the existing `Arena` to **review** an existing artifact.
- `eslint.config.js` (ESLint v9 flat config) with typescript-eslint preset.
- `LICENSE` (MIT) and `CHANGELOG.md` at the repository root.
- `prepublishOnly` script to run typecheck + tests + build before publish.
- `node >= 20` engine constraint alongside the existing `bun >= 1.3` hint.

### Fixed
- TypeScript compilation is now clean (was 50+ errors).
  - Removed zombie `cli/transports/`, `cli/handlers/`, `cli/remoteIO.ts`,
    `cli/structuredIO.ts`, `cli/ndjsonSafeStringify.ts` — these were copied
    from the Claude Code source tree but depended on modules that were never
    ported and had no active callers.
  - `engine/model-facade.ts`: aligned field names with the real `TokenUsage`
    interface (`promptTokens`/`completionTokens`/`cacheCreationTokens`) and
    used `LLMClientBase.model` instead of the non-existent `modelName`.
  - `utils/env.ts`, `ink/termio/osc.ts`, `utils/fullscreen.ts`: small type
    drift fixes.
- Test suite is green (was 3 failing):
  - Plan-mode tests were asserting an old `plan_file` parameter shape.
  - `estimateTokens` test hard-coded an outdated char→token ratio.
- `SavePRD` and `LoadTemplate` custom tools in `examples/prd-agent` now reject
  filenames that resolve outside the intended directory (path-traversal fix).
- `WebFetch` rejects non-HTTP(S) URLs and URLs whose literal hostname matches
  loopback / link-local / RFC1918 / cloud-metadata (`169.254.169.254`) ranges,
  and strips client-supplied `Authorization` / `Cookie` / `Host` headers.
  Note: this does not defeat DNS rebinding or IPv4-decimal (e.g.
  `http://2130706433/`) encoding — a defense-in-depth proxy is still
  recommended for untrusted LLM input.
- Bash read-only classifier no longer auto-approves commands that contain
  `;`, `&&`, `||`, backticks, `$(...)`, or redirections. Removed `node -e`,
  `python -c`, and `sed -n` from the read-only prefix list — those can execute
  arbitrary code.
- LSP client (`lsp/client.ts`) now `unref()`s the spawned process, clears its
  per-request 30s timeout on resolve/reject, and fully removes listeners +
  drains pending requests on `shutdown()`.
- `SessionManager.saveState` performs an atomic `.tmp` → rename instead of a
  bare `writeFileSync`, so two processes writing the same session no longer
  corrupt each other.
- MCP connect now times out after 15 s so a misbehaving server can't hang the
  whole startup sequence.
- OpenAI/OpenRouter 401 "Provider returned error" now surfaces a clearer
  message hinting the model may not support function calling on the current
  provider, instead of the opaque SDK message.
- Context manager `recordActualUsage` is now actually invoked from the turn
  loop after each model response, so the hybrid estimator has real API data
  instead of always falling back to character-count heuristics.
- `examples/prd-agent/src/chat.ts` picks `openai/gpt-4.1-mini` as the default
  model when using OpenRouter, because `openai/gpt-4o-mini` gets routed to an
  Azure backend that rejects tool calls with 401.

### Removed
- `TodoWrite` tool. It was a 6-line wrapper around `TaskCreate` and its
  presence confused models into using two equivalent interfaces. Use the
  `Task*` family (`TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, etc.).

### Changed
- Arena research-phase prompts no longer hard-cap output at "exactly 3 to 6
  findings". The new instruction asks for "as many findings as the topic
  warrants — typically 5-15", with each `summary` field expected to be 80+
  words with concrete evidence. Debate-turn prompts likewise replaced
  "Be concise" with a 150-300 word target. This addresses persistent reports
  that Arena output was too thin for non-trivial topics.
- IterativeArena critics can now use web search via the `enableWebSearch`
  config flag. When enabled (and a SERPER_API_KEY / TAVILY_API_KEY /
  SEARXNG_URL is configured), each critic runs a tool-use loop and may call
  `web_search` / `web_fetch` up to `maxArgueToolRounds` times before
  emitting critiques. New `Critique.evidence` field carries the URLs they
  consulted. New `fabrication` value in `CritiqueCategory`. Format prompts
  (draft / merge / revise / argue, both `code` and `document`) now ban
  invented numbers, citations, and URLs; unknowable specifics must be
  marked `[需调研]` / `[TBD: ...]`.

### Fixed
- IterativeArena: `extractTag` now tolerates LLM responses where the
  closing `</v1_content>` / `</v_next_content>` marker is missing (e.g. due
  to max_tokens truncation). Previously the parser fell back to "use the
  whole response as content", which left literal `<v1_content>` text at the
  start of v1.md.
- IterativeArena: tournament draft / merge / single-author v1 / revise all
  now request `maxTokens: 32000`. The previous 8k default truncated
  long-form drafts mid-sentence and broke downstream parsing.
- IterativeArena: convergence no longer treats "zero critiques" as
  "all_minor_or_praise". Zero is almost always a parsing or timeout
  failure on the critic side, not a sign the draft is done. The loop now
  continues to the next round (and naturally stops at `maxRounds`).
  Convergence also requires at least 3 critiques before declaring success
  on the "no blockers / no majors" branch.
