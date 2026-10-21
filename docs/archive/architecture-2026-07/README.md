# CodeShell Architecture (2026-07 edition, archived)

> Historical snapshot. These chapters were written in July 2026 and last refreshed
> before the 0.9.4x releases; several statements (for example the TUI `arena`
> subcommand and the Desktop CDP browser path) no longer match the source.
> The current set lives in [`docs/architecture/`](../../architecture/README.md).

They were replaced on 2026-10-20 by the function-level rewrite of chapters 00–10.
Links to chapters 11–16 and to `images/` point back into `docs/architecture/`.

| #   | Chapter                                                                                     | Superseded by (current `docs/architecture/`)                                                    |
| --- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 00  | [Overview & Reading Path](00-overview.md)                                                   | `00-overview.md`                                                                                |
| 01  | [Engine & Turn Loop](01-engine-and-turn-loop.md)                                            | `01-core-engine.md`, `03-core-llm-session-context.md` (context management)                      |
| 02  | [Tool System](02-tool-system.md)                                                            | `02-core-tool-system.md`                                                                        |
| 03  | [LLM & Model Layer](03-llm-and-model-layer.md)                                              | `03-core-llm-session-context.md`                                                                |
| 04  | [Protocol & Sessions](04-protocol-and-sessions.md)                                          | `04-core-protocol-plugins-links.md` (protocol), `03-core-llm-session-context.md` (sessions)     |
| 05  | [Presets, Prompt, Hooks, Skills](05-presets-prompt-hooks-skills.md)                         | `02` (hooks), `03` (prompt), `04` (skills), `05-core-runtime-settings-composition.md` (presets) |
| 06  | [Long-Running Orchestration](06-long-running-orchestration.md)                              | `01-core-engine.md` (sub-agents, run, goal, cron)                                               |
| 07  | [Plugins, Capabilities, Credentials, Memory](07-plugins-capabilities-credentials-memory.md) | `04` (plugins), `05` (capabilities, credentials)                                                |
| 08  | [Arena & Integrations](08-arena-and-integrations.md)                                        | `06-capability-packages.md`                                                                     |
| 09  | [TUI Package](09-tui.md)                                                                    | `07-tui.md`                                                                                     |
| 10  | [Desktop & Mobile](10-desktop-and-mobile.md)                                                | `08-desktop-main.md`, `09-desktop-renderer-mobile-web.md`, `10-server-chat.md`                  |
