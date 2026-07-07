# @cjhyy/code-shell-tui

Terminal UI for [`code-shell`](https://github.com/cjhyy/codeshell) — an Ink-based REPL and headless CLI on top of [`@cjhyy/code-shell-core`](https://www.npmjs.com/package/@cjhyy/code-shell-core).

This package owns the `code-shell` terminal client: the interactive REPL, the React/Ink render layer, themes, key bindings, slash commands, and the CLI subcommands. It imports the core engine; the core has no terminal dependencies.

## Install

```bash
npm install -g @cjhyy/code-shell-tui
# or run without installing
npx @cjhyy/code-shell-tui
```

Most users install the meta package [`@cjhyy/code-shell`](https://www.npmjs.com/package/@cjhyy/code-shell) instead, whose `code-shell` bin loads this CLI. Installing this package directly gives you the same `code-shell` binary.

Requires Node ≥ 20.10 and an ESM-capable runtime.

## Usage

```bash
# Interactive REPL (default — terminal-coding preset)
code-shell

# Run the general orchestrator preset
code-shell --preset general

# One-shot / headless execution
code-shell run "summarize the changes in this repo and list follow-ups"
```

### Subcommands

| Command | Purpose |
| --- | --- |
| (default) | Interactive Ink REPL |
| `run` | Execute a single task (headless). Reads the task from stdin if omitted and piped. |
| `repl` | Interactive REPL mode (the default when no subcommand is given). |
| `sessions` | List recent sessions. |
| `arena` | Multi-model review arena — the agent gathers context, then multiple models discuss (a differentiator: review/compare across models). |
| `plugin` | Manage installed plugins: `install`, `list`, `update`, and `uninstall`. |

Skill management and the model registry are surfaced **inside** the REPL (slash commands, `@`-mentions) and in the desktop app, rather than as top-level CLI subcommands.

### Interactive features

- Fullscreen (alt-screen) or flow mode (`/fullscreen off`, or `CODESHELL_FULLSCREEN=0`)
- Slash commands with auto-complete and usage hints
- `@`-mention file / skill search
- `Shift+Tab` permission-mode cycling, vim-mode input, input history
- Session resume, transcript browsing, and cost/usage reporting

## Configuration

Preset and tool selection come from `~/.code-shell/settings.json` (with project-level overrides under `<cwd>/.code-shell/`):

```json
{
  "agent": {
    "preset": "general",
    "enabledBuiltinTools": ["LSP"],
    "disabledBuiltinTools": ["WebSearch"],
    "appendSystemPrompt": "Prefer long-horizon planning."
  }
}
```

### Environment flags

- `CODESHELL_FULLSCREEN=0|false|off` — start in flow mode instead of fullscreen.
- Stream idle watchdog is enabled by default: it aborts an LLM stream idle for `CODESHELL_STREAM_IDLE_TIMEOUT_MS` ms (default `90000`) and retries via the engine's `withRetry` policy (capped by `CODESHELL_STREAM_WATCHDOG_RETRIES`, default `2`). Set `CODESHELL_ENABLE_STREAM_WATCHDOG=0` to opt out.
- `CODE_SHELL_HOME` — relocate the `~/.code-shell` state directory (sessions, settings, memory).

## Relationship to other packages

- **[`@cjhyy/code-shell-core`](https://www.npmjs.com/package/@cjhyy/code-shell-core)** — the headless engine this CLI drives. Embed it directly for non-terminal hosts.
- **[`@cjhyy/code-shell`](https://www.npmjs.com/package/@cjhyy/code-shell)** — meta package; re-exports core and ships the `code-shell` bin that loads this CLI.

## Stability

Pre-1.0 — APIs and CLI flags may change between minor versions. See [CHANGELOG.md](https://github.com/cjhyy/codeshell/blob/main/CHANGELOG.md) in the monorepo.

## License

MIT © maki maki.
