# @cjhyy/code-shell-core

UI-agnostic agent orchestration framework. The headless core of [`code-shell`](https://github.com/cjhyy/codeshell): turn an LLM + a tool registry + a transcript into a multi-turn agent loop, with permissions, hooks, MCP support, and pluggable approval backends.

Compatible with Anthropic and OpenAI-protocol providers (Claude, DeepSeek, GPT, Gemini, Qwen, …). No terminal UI dependencies — embed it in a CLI, a web service, a Slack bot, a desktop app.

## Install

```bash
npm install @cjhyy/code-shell-core
# or
bun add @cjhyy/code-shell-core
```

Requires Node ≥ 20.10.

## Quickstart

```ts
import {
  Engine,
  HeadlessApprovalBackend,
} from "@cjhyy/code-shell-core";

const engine = new Engine({
  llm: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
  cwd: process.cwd(),
  // Headless approval — "approve-all" trusts the model fully; use
  // "approve-read-only" or a custom ApprovalBackend in production.
  approvalBackend: new HeadlessApprovalBackend("approve-all"),
  headless: true,
});

const result = await engine.run(
  "list files in this directory and summarise their purpose",
);

console.log(result.text);
console.log("turns:", result.turnCount, "reason:", result.reason);
```

Streaming events:

```ts
await engine.run("...", {
  onStream(event) {
    if (event.type === "text_delta") process.stdout.write(event.text);
    if (event.type === "tool_use_start") console.log("→", event.toolCall);
  },
});
```

Restrict the tool set:

```ts
new Engine({
  llm: { /* … */ },
  // Whitelist — only these built-in tools are registered.
  enabledBuiltinTools: ["Read", "Glob", "Grep", "WebFetch"],
  // Or blacklist — registers every built-in except these.
  // disabledBuiltinTools: ["Bash", "Write", "Edit"],
});
```

## What's included

- **Engine** — turn loop, transcript management, session persistence, resume.
- **Tool system** — registry, executor, permission classifier, schema validation. Built-in tools for filesystem, shell, web fetch, sub-agents, plan mode, tasks.
- **LLM clients** — Anthropic, OpenAI (and any OpenAI-protocol endpoint). Provider catalog covers DeepSeek, Qwen, OpenRouter, Gemini.
- **MCP** — connect to Model Context Protocol servers (stdio / SSE / streamable-http / in-process).
- **Hooks** — `pre_tool_use`, `post_tool_use`, `on_user_prompt_submit`, `on_session_start`, `on_session_end`, more.
- **Protocol** — `AgentServer` / `AgentClient` over JSON-RPC for running the engine out-of-process.
- **Run manager** — queue, schedule, and persist multi-engine workflows.

## Designing for production

- **Approval backend.** `HeadlessApprovalBackend("approve-all")` is fine for trusted prompts. For untrusted input, implement `ApprovalBackend` to gate destructive tools (Write/Edit/Bash) through your own auth.
- **Permission rules.** Pass `permissionRules` to the engine for fine-grained allow/deny per tool + args pattern. Bash commands additionally get a built-in safety classifier (dangerous commands like `rm -rf` always require explicit approval).
- **Hooks** are the right place for audit logging, prompt rewriting, and policy enforcement.
- **Memory.** The engine ships with an extract-memories + auto-dream pipeline that persists to `~/.code-shell/memory/`. Disable by passing a no-op `MemoryOrchestrator`, or scope to a project by setting `CODE_SHELL_HOME`.

## Stability

Pre-1.0 — APIs may change between minor versions. Major exports (`Engine`, `ToolRegistry`, `PermissionClassifier`, `BUILTIN_TOOLS`, types under `./types`) are the stable surface; deep imports into subdirectories may shift.

See [CHANGELOG.md](https://github.com/cjhyy/codeshell/blob/main/CHANGELOG.md) in the monorepo.

## License

MIT © maki maki. See [LICENSE](./LICENSE).
