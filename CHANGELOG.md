# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and while the project is pre-1.0 we treat any 0.x → 0.(x+1) bump as potentially
breaking.

## [Unreleased]

### Added
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
