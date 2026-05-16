# Extension Points

CodeShell has several extension layers. Use the narrowest one that matches the job.

## Presets

Presets define an agent's default brain and hands:

- prompt sections;
- whether git status is injected;
- built-in tool list;
- default permission rules.

Built-ins are in [`src/preset/index.ts`](../../src/preset/index.ts):

- `general`
- `terminal-coding`

External code can call `registerPreset()` and then pass the preset name to `Engine`, `RunManager`, or `defineProduct()`.

Use a preset when you need a different default behavior profile but still use the same Engine and tool system.

## Prompt Sections

Prompt behavior is assembled by [`PromptComposer`](../../src/prompt/composer.ts) from:

- runtime header;
- tool definitions;
- preset prompt sections from [`src/prompt/sections`](../../src/prompt/sections);
- skill listing;
- custom system prompt;
- append system prompt;
- project/user context message.

Use prompt sections for reusable instruction blocks. Use `customSystemPrompt` only when replacing the behavioral prompt wholesale is intended.

## Skills

Skills are local markdown files with frontmatter, discovered by [`scanSkills()`](../../src/skills/scanner.ts) from:

```text
<cwd>/.code-shell/skills
<cwd>/.claude/skills
~/.code-shell/skills
~/.claude/skills
skills-builtin/
```

Skills are listed in the system prompt and can also be invoked through the `Skill` tool.

Use skills for procedural knowledge and reusable instructions, not for code execution.

## Custom Tools

Custom tools can be registered directly on Engine:

```ts
engine.registerCustomTool(definition, executor);
```

For productized use, put custom tools in a `ProductAdapter` and let `defineProduct()` pass them into `EngineRunner`.

Use custom tools when the agent needs a first-class domain action that is not well served by shell commands or MCP.

## MCP Servers

Configure MCP servers through settings or Engine config. `MCPManager` discovers tools and resources at runtime.

Use MCP when:

- a tool provider already speaks MCP;
- the tool should be reusable across products;
- the integration needs external process or network lifecycle separation.

## Hooks

Hooks are registered through [`HookRegistry`](../../src/hooks/registry.ts) and used by `ToolExecutor` and `TurnLoop`.

Current event categories include:

- turn start/end;
- tool start/end;
- pre/post tool use.

Use hooks for policy, observability, or cross-cutting behavior. Prefer tools for user-visible capabilities.

## Product Adapter

[`defineProduct()`](../../src/product/define.ts) is the high-level productization API.

A product definition has:

- preset: the behavior profile;
- adapter: tools, MCP servers, enabled/disabled built-ins, permission rules, hooks;
- contract: evaluator, tags, metadata, max turns, max context, concurrency.

It returns:

- a configured `RunManager`;
- the registered preset;
- the custom tools list.

Use this when building a domain-specific agent product on top of CodeShell.

## RunManager

[`RunManager`](../../src/run/RunManager.ts) wraps Engine execution with:

- submit/start/resume/cancel;
- queue and concurrency;
- state transition validation;
- checkpoints;
- approvals and waiting states;
- artifact references;
- event sourcing;
- heartbeat and locks;
- evaluator hooks.

Use RunManager for long-running or externally controlled workflows where a single `Engine.run()` result is not enough.

## Arena

[`Arena`](../../src/arena/arena.ts) provides evidence-driven multi-model analysis.

Pipeline:

1. plan mode/lenses/sources;
2. collect evidence;
3. compose strategy;
4. select context tools;
5. run participant research in parallel;
6. register claims;
7. cross-review;
8. debate and adjudicate contested claims;
9. build consensus.

[`IterativeArena`](../../src/arena/iterate/iterative-arena.ts) is a separate authoring loop: create draft, critique, revise, check convergence.

Use Arena when multiple model perspectives and explicit evidence trails matter.

## Slash Commands

Slash commands extend the REPL UI without becoming model tools. They can query/configure the server, update UI state, or inject context.

Add commands through the command files under [`src/cli/commands/builtin`](../../src/cli/commands/builtin), then register them in `App.tsx`.

Use slash commands for direct user controls, not autonomous model actions.

## Choosing the Right Extension

| Need | Best extension |
|---|---|
| New agent behavior/profile | Preset |
| Reusable instruction procedure | Skill |
| New autonomous capability | Built-in or custom tool |
| External tool provider | MCP |
| Cross-cutting policy/telemetry | Hook |
| Domain-specific product | `defineProduct()` |
| Long-running lifecycle | `RunManager` |
| Multi-model review/planning | `Arena` |
| User-only terminal command | Slash command |
