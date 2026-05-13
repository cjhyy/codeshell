---
name: codeshell-help
description: Use when the user asks how to use code-shell itself — slash commands, login/model setup, settings.json keys, hooks, MCP servers, debugging flags, or "how do I X in code-shell". Skip for general programming questions.
when_to_use: User asks about code-shell features, configuration, slash commands, or runtime behavior. Not for code questions in the user's own project.
---

# Using code-shell

You are running inside **code-shell**, a terminal coding agent. This skill answers user questions about code-shell itself. Quote sections directly where helpful. If a topic isn't covered, say so — don't invent commands.

## Getting started

- `code-shell` — start an interactive REPL in the current directory.
- `code-shell run "<prompt>"` — one-shot non-interactive run, prints final answer and exits.
- `code-shell runs <sid>` — resume a saved session by id.
- First launch shows an onboarding flow that walks through provider + model setup.

## Slash commands (run inside the REPL)

Type `/` and the menu appears. The full list:

### Core
- `/help` — show the slash menu.
- `/exit` — quit the REPL.
- `/clear` — clear the conversation (keeps session id).
- `/compact` — manually trigger context compaction.
- `/status` — current model, effort, token usage, working dir.
- `/version` — code-shell version.
- `/cost` — token cost summary for the session.
- `/sid` — print the current session id.
- `/session` — open the session picker.
- `/resume` — resume the most recent session.
- `/diff` — show working-tree diff.
- `/tasks` — current task list (TaskCreate/TaskUpdate state).
- `/tools` — list available tools.
- `/memory` — open the per-project memory file.
- `/export markdown` — export the current conversation to a markdown file.

### Models / providers
- `/login` — add a new provider + model via the unified ProviderModelFlow.
- `/logout` — remove a provider's stored credentials.
- `/model` — quick-switch the active model.
- `/models` — open the ModelManager (add, refresh, delete providers and models).

### Configuration
- `/config` — open `settings.json` for the active scope.
- `/permissions` — manage tool permission rules.
- `/hooks` — list hooks configured in settings.
- `/mcp` — list and manage MCP servers.
- `/skills` — list discovered skills.
- `/effort` — set reasoning effort (low / medium / high) for reasoning models.

### Git / review
- `/commit` — agent drafts a commit from staged changes.
- `/branch` — branch operations.
- `/review` — review pending changes.
- `/pr-comments` — fetch GitHub PR comments.
- `/autofix-pr` — apply review suggestions.
- `/security-review` — run a security-focused review of pending changes.

### Misc
- `/init` — scaffold or refresh `CODESHELL.md` / project rules based on repo state.
- `/copy` — copy last response to clipboard.
- `/undo` — undo the most recent file edit done by the agent.
- `/update` — check for and install code-shell updates (auto-installs on exit when npm prefix is writable).
- `/log` — open the session log file.
- `/files` — list files the agent has touched this session.
- `/release-notes` — show CHANGELOG for the running version.
- `/feedback` — open the feedback URL.
- `/voice` — voice input (if enabled).

## Provider + model setup

code-shell uses a **two-layer config**: `providers[]` holds credentials and base URLs; `models[]` references a provider by key.

- New users: `/login` runs the full wizard — pick provider kind (anthropic / openai / openrouter / deepseek / custom), enter API key, optional base URL, then pick a model from the fetched list.
- Existing users with the legacy flat `models[]` shape: auto-migrated on startup with a `.bak` snapshot written next to `settings.json`.
- Refresh a provider's model list: `/models` → select provider → Refresh. Cached for 7 days under `~/.code-shell/cache/`.

## settings.json — key fields

Located at `~/.code-shell/settings.json` (user scope) or `.code-shell/settings.json` (project scope, takes precedence).

- `providers[]` — `[{ key, kind, baseUrl, apiKey }]`. Source of credentials.
- `models[]` — `[{ id, providerKey, displayName, contextLength, ... }]`.
- `model` — the default active model id.
- `autoUpdates` — `false` disables the background updater.
- `permissions` — allow/deny rules for the Bash tool and others.
- `hooks` — shell commands to run on events (SessionStart, PreToolUse, etc.).
- `mcpServers` — `{ name: { command, args, env } }` map of MCP servers.

## Hooks

Hooks are shell commands the harness runs on events. Configured in `settings.json` under `hooks`. Common events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`. Use them for automated behaviors ("each time X happens, run Y") — memory or preferences can't do this because the model doesn't fire actions on schedule, the harness does.

## MCP servers

`code-shell` speaks the Model Context Protocol. Add servers in `settings.json` under `mcpServers`. Each entry is a stdio command code-shell spawns; its tools/resources become available to the agent automatically. List with `/mcp`.

## Debugging

- `CODE_SHELL_DEV=1 code-shell` — dev mode: enables the per-session verbose recorder (JSONL traces under `log/<date>/session-<sid>.jsonl`, 7-day retention), disables auto-update, shows extra UI.
- `--debug` flag has the same effect as `CODE_SHELL_DEV=1`.
- Logs: `~/.code-shell/log/` for general logs; per-session JSONL traces appear there when dev mode is on.
- Investigation guard: re-reading the same file 3× is hard-blocked. 4+ consecutive read-only tool calls inject a "change strategy" reminder. This is intentional — break the loop, don't fight it.
- Update install log: `~/.code-shell/update.log`.

## Memory

code-shell has a per-project memory system at `.code-shell/memory/` (relative to project root) and a global one at `~/.code-shell/memory/`. The `MEMORY.md` index is auto-loaded into context every session. Individual memory files are loaded on demand. Edit with `/memory` or directly.

## Skills

Skills are markdown files with frontmatter that get discovered automatically. Locations scanned:
- `<cwd>/.code-shell/skills/` — project-level
- `<cwd>/.claude/skills/` — project-level (Claude Code compat)
- `~/.code-shell/skills/` — user-level
- `~/.claude/skills/` — user-level (Claude Code compat)
- Built-in skills shipped with the package (e.g. this one).

List discovered skills with `/skills`. Invoke a skill with the `Skill` tool by name. Frontmatter `description` tells the model when to use it.

## Common questions

**"How do I switch models?"** — `/model <id>` or pick from `/models`.

**"How do I add a new provider?"** — `/login`, then follow the wizard. Or edit `settings.json` `providers[]` directly.

**"Why is auto-update not working?"** — `/update` shows the disabled reason. Common: dev build, `DISABLE_AUTOUPDATER=1`, `settings.autoUpdates: false`, or the npm global prefix isn't writable (use the shown `sudo` command).

**"Where's my session saved?"** — `~/.code-shell/sessions/<sid>/`. State, messages, and tool results all there.

**"How do I see what tools an agent has?"** — `/tools`.

**"How do I limit what Bash commands the agent can run?"** — `/permissions` or edit `settings.permissions` directly.
