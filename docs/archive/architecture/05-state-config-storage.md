# State, Config, and Storage

## Configuration Sources

[`SettingsManager`](../../src/settings/manager.ts) loads JSON settings in priority order:

```text
managed     ~/.code-shell/settings.managed.json
user        ~/.code-shell/settings.json
project     <cwd>/.code-shell/settings.json
local       <cwd>/.code-shell/settings.local.json
flags       CLI/runtime overrides
```

Later sources override earlier sources through deep merge. `null` deletes inherited keys.

The schema lives in [`src/settings/schema.ts`](../../src/settings/schema.ts). Important groups:

- `agent`: preset, enabled/disabled tools, custom prompt overrides;
- `activeKey`, `models`, `providers`, legacy `model`: model configuration;
- `permissions`: default mode and explicit rules;
- `context`: max tokens and compaction thresholds;
- `session`: storage directory and max history;
- `mcpServers`: MCP transport configs;
- `instructions`: project instruction filenames and scanning behavior;
- `arena`: default participants;
- `search`: search provider config;
- `sandbox`: shell sandbox mode/roots/network.

## Session Storage

[`SessionManager`](../../src/session/session-manager.ts) defaults to:

```text
~/.code-shell/sessions/<sessionId>/
  state.json
  transcript.jsonl
  tool-results/
```

`state.json` tracks session metadata, status, model/provider, turn count, usage, invoked skills, summary, and optional persisted cost state.

`transcript.jsonl` is append-only event history managed by [`Transcript`](../../src/session/transcript.ts). Event types include:

- `session_meta`
- `message`
- `tool_use`
- `tool_result`
- `turn_boundary`
- `summary`
- `content_replace`
- `file_history`
- `plan_operation`
- `error`

## Context Storage and Compaction

[`ContextManager`](../../src/context/manager.ts) has a staged pressure strategy:

1. Persist large tool results to disk and replace them with preview plus filepath.
2. Hard truncate oversized tool results that remain inline.
3. Apply per-message aggregate tool-result budgets.
4. Run micro-compaction on old compactable tool results after a pressure floor.
5. Prefer LLM summary compaction when near the context gate.
6. Fall back to snip/window/emergency compaction when summary is unavailable or insufficient.

Tool-result persistence lives beside the transcript:

```text
~/.code-shell/sessions/<sessionId>/tool-results/<toolUseId>.txt
```

This keeps massive command/file outputs recoverable by path without bloating every future model request.

## Run Storage

Managed runs use [`RunManager`](../../src/run/RunManager.ts) and [`FileRunStore`](../../src/run/FileRunStore.ts). Default layout:

```text
~/.code-shell/runs/<runId>/
  run.json
  events.jsonl
  checkpoints/<checkpointId>.json
  approvals/<approvalId>.json
  artifacts/refs.jsonl
```

`RunSnapshot` state transitions are defined in [`src/run/types.ts`](../../src/run/types.ts):

```text
queued -> running -> waiting_input -> queued
queued -> running -> waiting_approval -> queued
queued -> running -> blocked -> queued
queued -> running -> completed|failed|cancelled
queued -> cancelled
```

Run storage is intentionally separate from session storage. A run can link to one or more Engine sessions, while preserving its own queue/checkpoint/approval/artifact history.

## Model Cache

Model discovery uses:

- [`model-fetcher.ts`](../../src/llm/model-fetcher.ts) for provider model lists;
- [`model-cache.ts`](../../src/llm/model-cache.ts) for cached catalog data;
- [`scripts/sync-models.ts`](../../scripts/sync-models.ts) and `src/data/` for bundled catalogs.

`ModelPool.reloadCachedContextWindows()` patches model entries with cached context lengths when available.

## Memory

Memory has two layers:

- [`session/memory.ts`](../../src/session/memory.ts): project/user memory loading for prompt context.
- [`services/memory-orchestrator.ts`](../../src/services/memory-orchestrator.ts): end-of-session extraction, session summary, and optional consolidation.

The prompt composer injects memory context into the user-context reminder message, alongside project instructions.

## Logs

[`logger.ts`](../../src/logging/logger.ts) writes JSONL logs under:

```text
~/.code-shell/logs/
  engine-YYYY-MM-DD.log
  ui-ink-YYYY-MM-DD.log
```

Routing is based on log category:

- UI/render/stream categories go to `ui-ink`.
- Engine/model/tool/context/MCP/sandbox categories go to `engine`.

The logger stamps a process-wide session ID, allowing merged log queries by `sid`.

## Local Project State

Project-local mutable state lives under:

```text
<cwd>/.code-shell/
  settings.json
  settings.local.json
  skills/
```

`settings.local.json` is used for local-only permission grants and should not be committed.
