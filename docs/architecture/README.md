# CodeShell Architecture

Source-anchored architecture of CodeShell. The directory has two kinds of documents:

- **Function-level chapters `00`–`10`** (Chinese) describe _how the system works_, one
  slice of the monorepo per chapter. Each chapter lists every non-test source file in
  its slice, the significant classes and functions, the main call chains (with
  Mermaid diagrams), the seams to other chapters, and a closing list of design
  invariants, pitfalls and known drift. Read [`00-overview.md`](00-overview.md) first:
  it carries the package dependency graph, the public entry contracts, where the
  Engine runs in each host, an end-to-end trace of one message, and a cross-chapter
  list of known issues. The slices are:
  - `01`–`05` — `packages/core`, split by subsystem (engine and turn loop; tool
    system and hooks; LLM, context and sessions; protocol, plugins, skills and Links;
    package entries, settings, composition and runtime);
  - `06` — the capability packages around core (coding, pet, host, link,
    optimization-lab, cdp, browser-devtools, arena);
  - `07`–`10` — the hosts (TUI; Desktop main process; Desktop renderer, mobile and
    `packages/web`; server and the IM chat gateway).
- **Topical chapters `11`–`16`** cut across packages: the flat feature inventory
  (`11`, the _breadth map_ — "does capability X exist and where"), package boundaries
  and release units (`12`), plugin parity (`13`), digital humans and Pet (`14`), the
  Codex harness comparison and roadmap (`15`), and platform consolidation (`16`).
  [`local-link-mvp.md`](local-link-mvp.md) is a standalone design note for the
  local-first Link providers.

### Baseline and drift

Chapters `00`–`10` were written on 2026-10-20 against `main` @ `df2ca0bda`
(2026-10-19, version 0.9.45). Every `file:line` anchor in them refers to that commit;
line numbers drift as the code moves, so search by symbol name when an anchor is off.
Facts that changed after the baseline are corrected in place with a note (for example
the per-project memory root). The topical chapters carry their own dates.

### Diagrams

Chapters `00`–`10` use source-controlled Mermaid diagrams. The generated PNG diagrams
under [`images/`](images/) are used by the archived 2026-07 chapters and by the
feature inventory; they stay here so those links keep resolving. Interactive Archify
diagrams (standalone HTML viewers plus their JSON sources) live under
[`archify/`](archify/): the runtime overview, the platform-consolidation target, and
the two full-repository Run / Steer / Stop sequence diagrams. Regenerated visual-check
runs and earlier iterations are git-ignored there and must never be written to the
repo root.

### Archived editions

The 2026-07 edition of chapters `00`–`10` (English, organised by concern rather than
by package) is kept for history in
[`docs/archive/architecture-2026-07/`](../archive/architecture-2026-07/README.md); only
its relative links were repaired after the move. Its README maps each old chapter to
the chapters that replace it. The 2026-05 set lives in
[`docs/archive/architecture/`](../archive/architecture/README.md). Both are history:
when they disagree with this directory, this directory wins.

These documents describe the as-built system. For _what changed in which release_ see
the repo-root [`CHANGELOG.md`](../../CHANGELOG.md); for _planned / not-yet-built_ work
see [`docs/todo/`](../todo/README.md).

## Chapters

| #   | Chapter                                                                                  | Covers                                                                                                     |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 00  | [总览 Overview](00-overview.md)                                                          | Package graph, entry contracts, host topology, end-to-end message trace, known issues                      |
| 01  | [core: Engine & Turn Loop](01-core-engine.md)                                            | `engine/` `run/` `goal/` `automation/` `agent/` `operations/`                                              |
| 02  | [core: Tool System & Hooks](02-core-tool-system.md)                                      | `tool-system/` (builtin tools, executor, permissions, MCP, sandbox) and `hooks/`                           |
| 03  | [core: LLM, Context, Sessions](03-core-llm-session-context.md)                           | `llm/` `model-*` `context/` `session/` `prompt/` `cost-*`                                                  |
| 04  | [core: Protocol, Plugins, Skills, Links](04-core-protocol-plugins-links.md)              | `protocol/` `plugins/` `skills/` `links/` `sources/`                                                       |
| 05  | [core: Entries, Settings, Composition, Runtime](05-core-runtime-settings-composition.md) | Package entries, `settings/` `credentials/` `composition/` `preset/` `profile/` `panel-apps/` `runtime/`   |
| 06  | [Capability Packages](06-capability-packages.md)                                         | coding, pet, host, link, optimization-lab, cdp, browser-devtools, arena                                    |
| 07  | [TUI](07-tui.md)                                                                         | `packages/tui` and the root meta package                                                                   |
| 08  | [Desktop Main Process](08-desktop-main.md)                                               | Electron main / preload / shared / browser-library / chrome-extension                                      |
| 09  | [Desktop Renderer, Mobile, Web](09-desktop-renderer-mobile-web.md)                       | Renderer UI, mobile entry, `packages/web`                                                                  |
| 10  | [Server & Chat](10-server-chat.md)                                                       | `packages/server` (HTTP+WS, pairing, relay, panels) and `packages/chat` (IM gateway)                       |
| 11  | [Feature Inventory](11-feature-inventory.md)                                             | Flat breadth map — 179 capabilities across desktop main / renderer / TUI                                   |
| 12  | [Package Boundaries & Release Units](12-package-boundaries-and-release-units.md)         | Monorepo dependency direction, Pet split rationale, exports and publish boundaries                         |
| 13  | [Plugin Parity & Video Editor](13-plugin-parity-and-video-editor.md)                     | Codex compatibility matrix, remaining gaps, and the video-editor reference plugin                          |
| 14  | [Digital Humans, Sessions & Pet](14-digital-human-and-pet.md)                            | Session binding, long-term memory, cross-Session messages, and the Pet independence boundary               |
| 15  | [Codex Open Harness Comparison & Roadmap](15-codex-harness-comparison-and-roadmap.md)    | Source-backed comparison, gaps, non-goals, priorities, and phased evolution plan                           |
| 16  | [Platform Consolidation](16-platform-consolidation.md)                                   | HostRuntime, Protocol v2, unified policy/execution, thin cloud + sandbox tasks; v1.1 2026-10-14, S0 已实施 |
