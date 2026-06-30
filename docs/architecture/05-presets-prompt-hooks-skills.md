# 05 · Presets, Prompt, Hooks, Skills

> How CodeShell stays domain-agnostic: behavior is *configuration* (presets + prompt sections), and extension points (hooks, skills) layer onto a generic core. Source-mapped against `packages/core/src/preset/`, `prompt/`, `hooks/`, and `skills/`.

This is where the README's central claim lives — "core only carries mechanism, not policy." Coding behavior is a preset, not a fork.

## 1. Presets (`preset/index.ts`, ~293 LOC)

A preset is the bundle that turns the generic engine into a specific agent. An `AgentPreset` selects four things:

```ts
interface AgentPreset {
  promptSections: readonly string[];      // markdown section names
  injectGitStatus: boolean;
  builtinTools: string[];                  // the tool whitelist
  defaultPermissionRules: PermissionRule[];
}
```

Two built-ins (`BUILTIN_AGENT_PRESETS`):
- **`general`** (`DEFAULT_AGENT_PRESET`) — sections `[base, orchestration, browser, tone]`, `GENERAL_BUILTIN_TOOLS`, git status off. For research/ops/automation.
- **`terminal-coding`** (`DEFAULT_CLI_PRESET`) — adds the `coding` section and `EnterWorktree`/`ExitWorktree`/`NotebookEdit`/`LSP`/`Brief`/`Arena`, git status on. The CLI default.

Key functions: `resolveAgentPreset(name)` (builtin → custom `_customPresets` → throw), `resolveBuiltinToolNames(preset, ±overrides)`, `buildPresetSystemPrompt(preset, activeToolNames)`, and `registerPreset` for SDK consumers.

**The tool whitelist is the enforcement mechanism.** `GENERAL_BUILTIN_TOOLS` is the curated list; `ToolRegistry.registerBuiltins(names)` filters `BUILTIN_TOOLS` by it and *silently drops anything not listed*. This is the other half of the "add a builtin tool = change two places" gotcha from [02](02-tool-system.md) — the table **and** this whitelist. The in-file comments explain why each group is whitelisted (e.g. `BashOutput`/`KillShell`/`ListShells` must be visible or the model can't read back a `run_in_background` Bash job).

**Tool-gated sections**: `TOOL_GATED_SECTIONS` maps a section to the tools it needs (`browser → [browser_observe, browser_act, browser_navigate]`). `buildPresetSystemPrompt` drops the `browser` section when no browser tool is active, so the model never reads browser instructions it can't act on.

## 2. Prompt assembly (`prompt/`)

| File | Role | ~LOC |
|------|------|------|
| `prompt/composer.ts` | `PromptComposer` — orchestrates system prompt + dynamic context | ~300 |
| `prompt/section-cache.ts` | `SectionCache` — per-section memoization with `cacheBreak` | ~43 |
| `prompt/section-loader.ts` | `loadSection`/`availableSections` — markdown section I/O | ~62 |
| `prompt/instruction-scanner.ts` | `scanInstructions`/`combineInstructions` — CLAUDE.md/CODESHELL.md hierarchy | ~239 |

The prompt is built in two parts around a **cache breakpoint**:

**Cached system prefix** (`buildSystemPrompt`): `runtime_header` (model/cwd/platform/shell) → `custom_system` → `tool_definitions` (name + one-line description; full schemas go via the native tools field) → `behavior` (the preset sections, with tool-gated filtering) → `append_system` → `personalization` (language + user profile). `SectionCache` memoizes each section; the `behavior` section sets `cacheBreak: true` because its content varies with `activeToolNames`.

**Dynamic context, past the breakpoint** (`buildDynamicContextMessage`): a user-role `<system-reminder>` carrying skills listing + git status + memory index — placed at the *end* of the messages array specifically because these change within a session (install a skill, edit a file, extract a memory) and shouldn't re-bill the cached prefix. (The prompt-cache-gaps memory note tracks where cache breakpoints are still incomplete.)

**Instruction scanning** (`scanInstructions`): walks from cwd up to the git root, collecting `CODESHELL.md`/`CLAUDE.md`/`AGENTS.md` (+ `.codeshell/rules/*.md`, `.claude/rules/*.md`, `*.local.md` overrides) plus user-level files under `~/.code-shell/`. Entries are de-duped (first wins) and ordered managed → user → project-root → cwd → local; `combineInstructions` joins them with labeled separators. This becomes a cacheable user-context message.

## 3. Hooks (`hooks/`)

Hooks are the cross-layer interception points.

| File | Role | ~LOC |
|------|------|------|
| `hooks/registry.ts` | `HookRegistry` — priority chain, result aggregation | ~145 |
| `hooks/events.ts` | `HookEventName` (16 events), `HookContext`, `HookResult` | ~156 |
| `hooks/inject.ts` | `wrapHookMessages` — pack hook messages into one `<system-reminder>` | ~30 |
| `hooks/shell-runner.ts` | run shell-hook subprocesses (trusted code, fail-silent) | ~244 |

The 16 events span the lifecycle: `on_session_start/end`, `on_agent_start/end`, `on_turn_start/end`, `pre_tool_use`, `on_tool_start`, `post_tool_use`, `on_tool_end`, `on_permission_check`, `user_prompt_submit`, `on_stop`, `post_compact`, `file_changed`, `notification`.

`HookRegistry.emit` runs handlers in priority order and aggregates results with strict rules:
- **decision: strictest wins** (`deny > ask > allow`) — a low-priority handler can never relax a high-priority `deny`. This is the registry-level half of the A1 hardening described in [02](02-tool-system.md).
- **messages**: appended; **data**: merged; **updatedInput/updatedPrompt**: last-write-wins; **continueSession** (on_stop): any `true` blocks termination.

Two design points worth holding onto:
- **Hooks are the *only* cross-layer array concatenation** — user hooks + project hooks + plugin hooks all run (the memory note on hooks-global-and-toggle warns not to generalize this special case to other settings). Plugin hooks register at priority 80, settings hooks at 50, SDK at 0.
- **Shell hooks are trusted code.** `runShellHook` spawns a subprocess (JSON `HookContext` on stdin, `HookResult` on stdout, exit 2 = deny with stderr reason), bypassing the Bash permission/sandbox path entirely — configuring a shell hook is implicitly trusting it. Guardrails: a timeout (default 60 s, SIGTERM→SIGKILL), an output cap, and **fail-silent** (malformed output, timeout, or any non-2 exit returns `{}` so a bad hook never crashes the turn). This trust model is documented in the archived plugin/shell-hook trust doc.

## 4. Skills (`skills/`)

Skills are lightweight, versioned capability extensions discovered from `~/.code-shell/skills/`, `.code-shell/skills/`, and installed plugins (`<plugin>:<name>`).

`scanSkills(cwd, opts?)` (`skills/scanner.ts`) memoizes a full scan, then filters: an `skillAllowlist` (hard isolation, e.g. for sub-agents) keeps only listed skills; `disabledPlugins` drops `<plugin>:*`; `disabledSkills` drops exact names. The cache key folds in `userHome()`, the installed-plugins mtime, and the skills-dir mtime, so adding/removing a skill busts it automatically — but *editing* a `SKILL.md` requires an explicit `invalidateSkillCache()` (install paths call it). A `SkillDefinition` carries `name`, `description`, `content`, `filePath`, `source`. The directory name is authoritative over the frontmatter `name`.

The discovered skills feed `buildSkillListing` (grouped by namespace) into the dynamic-context message, and the `Skill` tool dispatches them. CodeShell *consumes* CC- and Codex-format skills; it does not yet have an interactive skill-creator (the reference memory note compares CC's `skill-creator` and Codex's `$skill-creator`).

## 5. The assembly, in one picture

```
Engine.run
  ├─ resolveAgentPreset(name)                         → AgentPreset
  ├─ resolveBuiltinToolNames(preset, ±overrides)      → tool whitelist
  │     └─ ToolRegistry.registerBuiltins(names)       (drops non-whitelisted)
  ├─ PromptComposer.buildSystemPrompt(tools)          → cached system prefix
  │     └─ buildPresetSystemPrompt(preset, active)    (tool-gated sections)
  ├─ buildUserContextMessage()                        → CLAUDE.md/AGENTS.md (cacheable)
  └─ buildDynamicContextMessage()                     → skills + git + memory (past cache break)

per event ─ HookRegistry.emit(event, data) → aggregated HookResult (strictest decision wins)
```

## 6. Where to read next
- The tools the whitelist gates and how hooks ride the executor: [02 · Tool system](02-tool-system.md)
- The `on_stop` goal judge that uses the hook chain: [06 · Long-running orchestration](06-long-running-orchestration.md)
- Plugin hooks and per-hook toggles: [07 · Plugins, capabilities, credentials, memory](07-plugins-capabilities-credentials-memory.md)
