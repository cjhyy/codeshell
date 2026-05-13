# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and while the project is pre-1.0 we treat any 0.x → 0.(x+1) bump as potentially
breaking.

## [Unreleased]

## [0.1.6] - 2026-05-13

### Added
- **Built-in skills bundled with the package.** The skill scanner now also
  reads `skills-builtin/` shipped inside the installed npm package. First
  built-in is `codeshell-help` — answers questions about code-shell itself
  (slash commands, provider/model setup, settings keys, hooks, MCP,
  debugging flags) so a fresh install can self-document without the user
  having to write their own help skill.
- **Headless mode in Engine.** New `headless: true` config flag (set by the
  `run` command) puts InvestigationGuard into soft mode: the third re-read
  of the same target turns into a stronger reminder instead of a hard
  block, since unattended automations have no human to retry the task.

### Fixed
- `code-shell run` now resolves API keys / baseUrl / model from
  `settings.providers[]` and `settings.models[]` in addition to the legacy
  `settings.model.*` mirror — matches what Engine reconciles at startup,
  fixes "no API key found" false negatives for users on the new shape.
- Read-only filesystem (CI containers) no longer floods the log with
  `tool_result.persist_failed` warnings — demoted to debug.

## [0.1.5] - 2026-05-13

### Added
- **Auto-installing updater.** Background update check probes `npm config get
  prefix` for write permission; if writable, registers a detached `npm i -g`
  on process exit so the next launch picks up the new version. File lock at
  `~/.code-shell/.update.lock` (5min stale-takeover) prevents concurrent
  installs from corrupting each other. Disable with `DISABLE_AUTOUPDATER=1`,
  `settings.autoUpdates: false`, or dev mode. New `UpdateBanner` UI
  surfaces "will install on exit" or the manual `sudo` command.
- **Provider/model two-layer redesign.** `providers[]` is now the source of
  credentials/baseUrl; `models[]` references a provider by key. Legacy
  flat `models[]` config auto-migrates on startup (with `.bak` snapshot).
  New `ProviderModelFlow` unifies `/login` onboarding and the
  ModelManager's add/refresh flows.
- **Per-provider model fetcher + cache.** `model-fetcher.ts` queries each
  provider's models endpoint with a 20s timeout; `model-cache.ts` persists
  results with a 7-day TTL under `~/.code-shell/cache/`.
- **/init redesign.** New per-scenario templates (create / improve /
  migrate / empty / rules-scaffold) driven by a repo-state detector.
- **Tool-result-storage.** Content-addressed store keeps large tool outputs
  out of in-memory history while remaining retrievable.
- **AskUser options.** The `__ask_user__` tool now supports header /
  multi-choice options / multiSelect, rendered as an option picker.
- **Investigation guard.** Runtime enforcement of the "investigation has a
  budget" rule from `coding.md`: re-reading the same target prepends a
  reminder; a third re-read is hard-blocked. Four+ consecutive read-only
  calls (or three+ silent turns) inject a strategy-change reminder.
- **Per-session verbose recorder.** Dev-only JSONL trace under `log/<date>/
  session-<sid>.jsonl` capturing every LLM request/response, tool call, and
  engine event. Gated on `CODE_SHELL_DEV=1` / `--debug` / running from src.
  7-day retention, argv secrets redacted, per-record output clipped to 256 KB.
- **Pasted-noise sanitizer.** Engine rejects tasks that are >70% ANSI/box
  characters (typical pasted terminal output) instead of running on them.
- **Slimmer `/export markdown`.** Reasoning blocks are collapsible, tool_use
  shows tool name + formatted args, tool_result over 2 KB spills to a
  sidecar file alongside the markdown.
- **Live session heartbeat.** `state.json` is now flushed every turn with
  current `turnCount` and token usage, so external observers see live
  progress instead of a stale snapshot from the last completed run.

### Changed (breaking)
- `SessionStatus` is now `"active" | "paused" | TerminalReason` instead of
  `"active" | "paused" | "completed" | "errored"`. `state.json` records the
  raw terminal reason (e.g. `aborted_streaming`, `model_error`,
  `prompt_too_long`) so callers can distinguish user cancellation from real
  failures. Downstream code that narrows the old four-value union will
  need to widen its match.

### Changed
- API key resolution centralized into `resolveApiKey()` (one canonical
  fallback chain: option → settings → all provider env vars). Replaces five
  drifting copies in `repl.ts`, `run.ts`, `runs.ts`, `main.ts`,
  `core-commands.ts`. Side effect: `runs` and `/doctor` now also pick up
  provider env vars they previously ignored (e.g. `OPENROUTER_API_KEY`).
- Refreshed `openrouter-models.json` (367 → 365; dropped retired Claude 3.7
  Sonnet variants; corrected Kimi K2.5 / Pareto Code / MiniMax M2.5 context
  windows).

## [0.1.4] - 2026-05-09

### Fixed
- **Multi-model `apiKey` ignored on startup.** When `settings.json` defined
  a model in `models[]` (with its own `apiKey`/`baseUrl`) and the top-level
  `model.apiKey` was empty, the runtime fell through to
  `OPENROUTER_API_KEY` env, producing 401s against non-OpenRouter
  endpoints (e.g. DeepSeek direct). Engine constructor now merges the
  active pool entry's `apiKey`/`baseUrl` back into `config.llm` —
  matching the existing `/model` switch path.
- **Banner version hardcoded.** `Banner.tsx`, `printBanner`, and
  `commander.version()` all displayed `v0.1.0` regardless of
  `package.json`. Now read dynamically via `getCurrentVersion()`.
- **`updater.ts` ESM crash.** `require("../../package.json")` is unavailable
  in ESM builds. Replaced with a walk-up + `createRequire` fallback that
  works in both ESM and CJS bundles. Also corrected the npm package name
  used by the update check (`@cjhyy/code-shell`, not `code-shell`).

## [0.1.0-alpha.1] - 2026-04-30

### Changed (breaking)
- **Tool timeout system rewritten.** Removed the hardcoded
  `LEGACY_LONG_TIMEOUT_TOOLS = {Agent, Arena}` whitelist in
  `tool-system/registry.ts`. Tools now declare their own timeout via
  `RegisteredTool.timeoutMs` at registration time. Precedence:
  `executeTool(opts.timeoutMs)` > `tool.timeoutMs` > `DEFAULT_TOOL_TIMEOUT_MS`
  (120s). Custom long-running tools registered via `engine.registerCustomTool`
  can now set a higher timeout instead of being silently capped at 120s.
- **Bash internal 600s cap removed.** `bash.ts` no longer clamps the
  user-supplied `timeout` argument. The outer registry caps via the tool's
  declared `timeoutMs` (default 1h for Bash). Long-running shell loops
  (`until cond; do ...; done`) are now feasible.
- **Agent `max_turns` upper bound (30) removed.** Sub-agents that need to do
  more turns (deep research, large refactors) are no longer artificially
  capped. Default remains 15.
- **Sub-agent LLM call timeout (60s) removed.** `agent.ts` no longer clamps
  `subAgentConfig.llm.timeout` to 60s, which was breaking slow models
  (e.g. extended thinking).

### Added
- **`Agent(run_in_background: true)`** — fire-and-forget sub-agents. Returns
  an `agent_id` immediately instead of blocking the parent turn. The agent
  runs detached in the same process; restarting loses its state.
- **`AgentStatus(agent_id?)`** — query background agent state
  (running / completed / failed / cancelled), or list all when `agent_id` is
  omitted. Returns the result text once completed.
- **`AgentCancel(agent_id)`** — abort a running background agent.
- New module `src/tool-system/builtin/agent-registry.ts` — in-process
  registry for async agent handles.

### Notes
- Cross-process / restart-survivable long tasks still belong to `RunManager`
  in `@cjhyy/code-shell/run`, not to `Agent(run_in_background)`. The split
  mirrors Claude Code's REPL/Agent-tool/Routines architecture.

## [0.1.0-alpha.0] - 2026-04-28

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
