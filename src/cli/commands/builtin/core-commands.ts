/**
 * Core slash commands — migrated from App.tsx switch-case + new essentials.
 */

import type { SlashCommand } from "../registry.js";
import { costTracker } from "../../cost-tracker.js";
import { execSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const coreCommands: SlashCommand[] = [
  // ─── Existing (migrated from App.tsx) ───────────────────────────

  {
    name: "/exit",
    aliases: ["/quit"],
    description: "Exit the REPL",
    execute: (_arg, ctx) => ctx.exit(),
  },

  {
    name: "/clear",
    description: "Clear chat history",
    execute: (_arg, ctx) => ctx.clearChat(),
  },

  {
    name: "/cost",
    description: "Show token usage and cost",
    execute: (_arg, ctx) => {
      if (costTracker.getRequestCount() === 0) {
        ctx.addStatus("No API requests yet.");
      } else {
        const t = costTracker.getTotalTokens();
        ctx.addStatus(
          `Tokens: ${t.total} (in: ${t.prompt}, out: ${t.completion}) | ` +
            `Cost: $${costTracker.getEstimatedCost().toFixed(4)} | ` +
            `Requests: ${costTracker.getRequestCount()}`,
        );
      }
    },
  },

  {
    name: "/effort",
    description: "Set reasoning effort level",
    usage: "/effort <low|medium|high|max>",
    execute: (arg, ctx) => {
      if (arg && ["low", "medium", "high", "max"].includes(arg)) {
        ctx.setEffort(arg);
        ctx.addStatus(`Effort set to: ${arg}`);
      } else {
        ctx.addStatus(`Current effort: ${ctx.effort}. Use /effort <low|medium|high|max>`);
      }
    },
  },

  {
    name: "/tasks",
    description: "Show task list",
    execute: (_arg, ctx) => {
      if (ctx.tasks.length === 0) ctx.addStatus("No tasks.");
    },
  },

  {
    name: "/model",
    description: "Show or switch model",
    usage: "/model [key]  — switch to model by key, or show current + available",
    execute: async (arg, ctx) => {
      const key = arg.trim();

      if (!key) {
        // Show current model + available models from pool
        try {
          const result = await ctx.client.query("models");
          const models = (result.data as any[]) ?? [];
          if (models.length === 0) {
            ctx.addStatus(`Model: ${ctx.model}\n  (No model pool configured. Add "models" to settings.json)`);
            return;
          }
          const lines = models.map((m: any) => {
            const marker = m.active ? " ← active" : "";
            return `  ${m.key.padEnd(16)} ${m.model}${marker}`;
          });
          ctx.addStatus(`Model: ${ctx.model}\n\nAvailable models (/model <key> to switch):\n${lines.join("\n")}`);
        } catch {
          ctx.addStatus(`Model: ${ctx.model}`);
        }
        return;
      }

      // Switch model
      try {
        const result = await ctx.client.configure({ model: key });
        const data = result as any;
        const newModel = data?.model ?? key;
        ctx.setModel(newModel);
        ctx.addStatus(`Switched to: ${key} (${newModel})`);
      } catch (err) {
        ctx.addStatus(`Failed to switch model: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "/session",
    description: "Show current session ID",
    execute: (_arg, ctx) => ctx.addStatus(`Session: ${ctx.sessionId ?? "none"}`),
  },

  {
    name: "/sessions",
    description: "List recent sessions",
    execute: async (_arg, ctx) => {
      try {
        const result = await ctx.client.query("sessions");
        const sessions = (result.data as any[]) ?? [];
        if (sessions.length === 0) {
          ctx.addStatus("No sessions.");
        } else {
          const lines = sessions.slice(0, 10).map((s: any, i: number) => {
            const date = new Date(s.startedAt).toLocaleString();
            const marker = s.sessionId === ctx.sessionId ? " ← current" : "";
            const summary = s.summary ? `  "${s.summary}"` : "";
            return `  ${i + 1}. ${date}  turns:${s.turnCount}${marker}${summary}`;
          });
          ctx.addStatus("Recent Sessions (use /resume <number> or /resume <query>):\n" + lines.join("\n"));
        }
      } catch (err) {
        ctx.addStatus(`Error: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "/tools",
    description: "List available tools",
    execute: async (_arg, ctx) => {
      try {
        const result = await ctx.client.query("tools");
        const tools = (result.data as any[]) ?? [];
        ctx.addStatus(`Available Tools (${tools.length}):\n  ${tools.map((t: any) => t.name).join(", ")}`);
      } catch (err) {
        ctx.addStatus(`Error: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "/memory",
    group: "context",
    description: "Manage persistent memories",
    usage: "/memory [list | add <name> <content> | delete <name> | open]",
    execute: async (arg, ctx) => {
      const { MemoryManager } = await import("../../../session/memory.js");
      const mm = new MemoryManager(ctx.cwd);

      const parts = arg.trim().split(/\s+/);
      const sub = parts[0] || "list";

      try {
        if (sub === "list" || !arg.trim()) {
          const entries = mm.loadAll();
          if (entries.length === 0) {
            ctx.addStatus("No memories stored. Use /memory add <name> <content> to create one.");
          } else {
            const lines = entries.map((e: any, i: number) =>
              `  ${i + 1}. [${e.type}] ${e.name} — ${e.description}`,
            );
            ctx.addStatus("Memories:\n" + lines.join("\n") + "\n\nUse /memory delete <name> to remove.");
          }
        } else if (sub === "add") {
          const name = parts[1];
          const content = parts.slice(2).join(" ");
          if (!name || !content) {
            ctx.addStatus("Usage: /memory add <name> <content>\nExample: /memory add user_role I am a backend engineer");
            return;
          }
          mm.save({
            name,
            description: content.slice(0, 80),
            type: "user",
            content,
          });
          ctx.addStatus(`Memory "${name}" saved.`);
        } else if (sub === "delete" || sub === "rm") {
          const name = parts[1];
          if (!name) { ctx.addStatus("Usage: /memory delete <name>"); return; }
          const deleted = mm.delete(name);
          ctx.addStatus(deleted ? `Memory "${name}" deleted.` : `Memory "${name}" not found.`);
        } else if (sub === "open") {
          const dir = mm.getMemoryDir();
          const editor = process.env.EDITOR || process.env.VISUAL || "vi";
          ctx.addStatus(`Memory directory: ${dir}\nOpen with: ${editor} ${dir}`);
        } else {
          ctx.addStatus("Usage: /memory [list | add <name> <content> | delete <name> | open]");
        }
      } catch (err) {
        ctx.addStatus(`Memory error: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "/fork",
    description: "Fork current session",
    execute: async (_arg, ctx) => {
      if (!ctx.sessionId) {
        ctx.addStatus("No active session to fork.");
        return;
      }
      // Fork still needs server-side query for session detail
      ctx.addStatus("Fork is not yet supported via client protocol.");
    },
  },

  {
    name: "/compact",
    group: "context",
    description: "Force context compaction now",
    execute: async (_arg, ctx) => {
      ctx.addStatus("Compacting context...");
      try {
        const result = await ctx.client.query("compact");
        const data = result.data as any;
        if (data.before === data.after) {
          ctx.addStatus(`Context is already compact (${data.before} tokens). No compaction needed.`);
        } else {
          const saved = data.before - data.after;
          const pct = ((saved / data.before) * 100).toFixed(0);
          ctx.addStatus(
            `Compacted: ${data.before} → ${data.after} tokens (saved ${saved} tokens, ${pct}%)`,
          );
        }
      } catch (err) {
        ctx.addStatus(`Compaction failed: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "/arena",
    description: "Multi-model review arena",
    usage: "/arena <topic>",
    execute: async (arg, ctx) => {
      if (!arg) {
        ctx.addStatus("Usage: /arena <topic>\nExample: /arena review my latest changes\n  /arena --models claude,gpt4o review the auth module\n  /arena --mode discussion should we use REST or GraphQL");
        return;
      }
      ctx.addStatus(`Starting arena: ${arg}`);
      ctx.setIsRunning(true);
      try {
        const configResult = await ctx.client.query("config");
        const config = configResult.data as any;
        const { runArenaReview, formatArenaResultForSession } = await import("../arena.js");
        const result = await runArenaReview(arg, {
          llm: {
            provider: config.llm.provider ?? "openai",
            model: config.llm.model,
            apiKey: config.llm.apiKey,
            baseUrl: config.llm.baseUrl ?? "https://openrouter.ai/api/v1",
            temperature: config.llm.temperature ?? 0.3,
            maxTokens: config.llm.maxTokens,
            enableStreaming: false,
          },
        }, {
          // Progress goes through addStatus (dim text),
          // final result goes through addMessage (full markdown rendering).
          output: (text: string) => ctx.addStatus(text),
          outputMessage: (text: string) => ctx.addMessage(text),
        });
        if (result) {
          // Store arena result as context for the next user message,
          // so the LLM can reference it (e.g. "帮我翻译").
          const sessionResult = formatArenaResultForSession(result);
          ctx.setNextContext(sessionResult);
        }
      } catch (err) {
        ctx.addStatus(`Arena error: ${(err as Error).message}`);
      }
      ctx.setIsRunning(false);
    },
  },

  // ─── New commands ───────────────────────────────────────────────

  {
    name: "/resume",
    description: "Resume a previous session",
    usage: "/resume [number|query]",
    execute: async (arg, ctx) => {
      if (!arg) {
        try {
          const result = await ctx.client.query("sessions");
          const sessions = (result.data as any[]) ?? [];
          if (sessions.length === 0) {
            ctx.addStatus("No sessions to resume.");
            return;
          }
          const lines = sessions.slice(0, 10).map((s: any, i: number) => {
            const date = new Date(s.startedAt).toLocaleString();
            const summary = s.summary ? `  "${s.summary}"` : "";
            return `  ${i + 1}. ${date}  turns:${s.turnCount}${summary}`;
          });
          ctx.addStatus("Recent sessions (use /resume <number> or /resume <query>):\n" + lines.join("\n"));
        } catch (err) {
          ctx.addStatus(`Error: ${(err as Error).message}`);
        }
        return;
      }

      try {
        const input = arg.trim();
        const sessResult = await ctx.client.query("sessions");
        const allSessions = (sessResult.data as any[]) ?? [];

        let sessionId: string = input;

        // Try numeric index first (1-based)
        const num = parseInt(input, 10);
        if (!isNaN(num) && num >= 1 && num <= allSessions.length) {
          sessionId = allSessions[num - 1].sessionId;
        } else {
          // Try query matching against summary, fallback to raw input as ID
          const query = input.toLowerCase();
          const match = allSessions.find((s: any) =>
            (s.summary && s.summary.toLowerCase().includes(query)) ||
            s.sessionId.startsWith(input),
          );
          if (match) sessionId = match.sessionId;
        }

        // Get session detail to restore transcript
        const detailResult = await ctx.client.query("session_detail", sessionId);
        const session = detailResult.data as any;

        ctx.setSessionId(sessionId);

        if (ctx.loadChatEntries && session?.transcript) {
          const events = session.transcript;
          const entries: import("../registry.js").RestoredChatEntry[] = [];

          for (const event of events) {
            switch (event.type) {
              case "message": {
                const role = event.data.role as string;
                const content = event.data.content;
                if (role === "user" && typeof content === "string") {
                  entries.push({ type: "user", text: content });
                } else if (role === "assistant" && typeof content === "string") {
                  entries.push({ type: "assistant_text", text: content });
                }
                break;
              }
              case "tool_use": {
                entries.push({
                  type: "tool_start",
                  toolName: event.data.toolName as string,
                  args: (event.data.args as Record<string, unknown>) ?? {},
                });
                break;
              }
              case "tool_result": {
                entries.push({
                  type: "tool_result",
                  toolName: event.data.toolName as string,
                  result: event.data.result as string | undefined,
                  error: event.data.error as string | undefined,
                });
                break;
              }
            }
          }

          ctx.loadChatEntries(entries);
        }

        ctx.addStatus(
          `Resumed session ${sessionId.slice(0, 8)}… (${session?.state?.turnCount ?? "?"} turns)`,
        );
      } catch (err) {
        ctx.addStatus(`Resume failed: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "/diff",
    group: "git",
    description: "Show git diff",
    usage: "/diff [file]",
    execute: (_arg, ctx) => {
      try {
        const file = _arg || "";
        const stat = execSync(`git diff --stat HEAD ${file}`, {
          cwd: ctx.cwd,
          encoding: "utf-8",
          timeout: 10000,
        }).trim();

        if (!stat) {
          ctx.addStatus("No changes.");
          return;
        }

        const diff = execSync(`git diff HEAD ${file} --no-color`, {
          cwd: ctx.cwd,
          encoding: "utf-8",
          timeout: 10000,
        }).trim();

        ctx.addStatus(`${stat}\n\n${diff.slice(0, 5000)}${diff.length > 5000 ? "\n... (truncated)" : ""}`);
      } catch {
        ctx.addStatus("Not a git repository or git not available.");
      }
    },
  },

  {
    name: "/status",
    description: "Show system status",
    execute: async (_arg, ctx) => {
      try {
        const configResult = await ctx.client.query("config");
        const config = configResult.data as any;
        const toolsResult = await ctx.client.query("tools");
        const tools = (toolsResult.data as any[]) ?? [];

        const lines = [
          `Model:       ${ctx.model}`,
          `Effort:      ${ctx.effort}`,
          `Permission:  ${config.permissionMode ?? "acceptEdits"}`,
          `Session:     ${ctx.sessionId ?? "none"}`,
          `CWD:         ${ctx.cwd}`,
          `Tools:       ${tools.length} registered`,
        ];

        // Git info
        try {
          const branch = execSync("git branch --show-current", {
            cwd: ctx.cwd,
            encoding: "utf-8",
            timeout: 5000,
          }).trim();
          lines.push(`Git branch:  ${branch}`);
        } catch {
          // not a git repo
        }

        // Token usage
        const t = costTracker.getTotalTokens();
        if (t.total > 0) {
          lines.push(`Tokens:      ${t.total} (in: ${t.prompt}, out: ${t.completion})`);
          lines.push(`Cost:        $${costTracker.getEstimatedCost().toFixed(4)}`);
        }

        ctx.addStatus(lines.join("\n"));
      } catch (err) {
        ctx.addStatus(`Error: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "/version",
    description: "Show version",
    execute: (_arg, ctx) => {
      try {
        const pkg = JSON.parse(
          execSync("cat package.json", { cwd: ctx.cwd, encoding: "utf-8", timeout: 3000 }),
        );
        ctx.addStatus(`code-shell v${pkg.version ?? "0.1.0"}`);
      } catch {
        ctx.addStatus("code-shell v0.1.0");
      }
    },
  },

  {
    name: "/export",
    description: "Export session transcript",
    usage: "/export [json|markdown]",
    execute: async (arg, ctx) => {
      if (!ctx.sessionId) {
        ctx.addStatus("No active session to export.");
        return;
      }
      const format = arg === "json" ? "json" : "markdown";
      try {
        const detailResult = await ctx.client.query("session_detail", ctx.sessionId);
        const session = detailResult.data as any;
        const events = session?.transcript ?? [];

        if (format === "json") {
          const outPath = join(ctx.cwd, `session-${ctx.sessionId}.json`);
          writeFileSync(outPath, JSON.stringify(events, null, 2), "utf-8");
          ctx.addStatus(`Exported ${events.length} events to ${outPath}`);
        } else {
          const lines: string[] = [`# Session ${ctx.sessionId}\n`];
          for (const ev of events) {
            if (ev.type === "message") {
              const role = ev.data.role as string;
              const content =
                typeof ev.data.content === "string"
                  ? ev.data.content
                  : JSON.stringify(ev.data.content);
              lines.push(`## ${role}\n\n${content}\n`);
            }
          }
          const outPath = join(ctx.cwd, `session-${ctx.sessionId}.md`);
          writeFileSync(outPath, lines.join("\n"), "utf-8");
          ctx.addStatus(`Exported to ${outPath}`);
        }
      } catch (err) {
        ctx.addStatus(`Export failed: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "/config",
    group: "config",
    description: "View or update settings",
    usage: "/config [show | set <key> <value> | get <key>]",
    execute: async (arg, ctx) => {
      const { SettingsManager } = await import("../../../settings/manager.js");
      const sm = new SettingsManager(ctx.cwd);

      const parts = arg.trim().split(/\s+/);
      const sub = parts[0] || "show";

      try {
        if (sub === "show" || !arg.trim()) {
          const settings = sm.get();
          ctx.addStatus(JSON.stringify(settings, null, 2));
        } else if (sub === "get") {
          const key = parts[1];
          if (!key) { ctx.addStatus("Usage: /config get <key>  (e.g. model.name)"); return; }
          const settings = sm.get();
          const val = key.split(".").reduce((o: any, k) => o?.[k], settings);
          ctx.addStatus(`${key} = ${JSON.stringify(val)}`);
        } else if (sub === "set") {
          const key = parts[1];
          const value = parts.slice(2).join(" ");
          if (!key || !value) { ctx.addStatus("Usage: /config set <key> <value>  (e.g. model.name claude-opus-4-6)"); return; }
          // Try to parse JSON values (booleans, numbers, objects)
          let parsed: unknown = value;
          try { parsed = JSON.parse(value); } catch { /* keep as string */ }
          await ctx.client.query("config_set", key, parsed);
          ctx.addStatus(`Set ${key} = ${JSON.stringify(parsed)}`);
        } else {
          ctx.addStatus("Usage: /config [show | set <key> <value> | get <key>]");
        }
      } catch (err) {
        ctx.addStatus(`Config error: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "/init",
    group: "config",
    description: "Initialize CODESHELL.md with codebase documentation",
    execute: async (_arg, ctx) => {
      // Create .code-shell/settings.json if missing
      const configDir = join(ctx.cwd, ".code-shell");
      const configFile = join(configDir, "settings.json");
      if (!existsSync(configFile)) {
        mkdirSync(configDir, { recursive: true });
        writeFileSync(configFile, JSON.stringify({
          model: { provider: "openai", name: "anthropic/claude-opus-4-6", baseUrl: "https://openrouter.ai/api/v1" },
          permissions: { defaultMode: "acceptEdits", rules: [] },
          mcpServers: {},
        }, null, 2), "utf-8");
      }

      ctx.addStatus("Analyzing codebase and generating CODESHELL.md...");
      ctx.setIsRunning(true);

      const instrFile = join(ctx.cwd, "CODESHELL.md");
      const hasExisting = existsSync(instrFile);
      // Also check for CLAUDE.md / AGENTS.md to migrate from
      const hasClaude = existsSync(join(ctx.cwd, "CLAUDE.md"));
      const hasAgents = existsSync(join(ctx.cwd, "AGENTS.md"));

      try {
        const migrationNote = (hasClaude || hasAgents)
          ? `\nIMPORTANT: This project has existing AI tool configs:${hasClaude ? "\n- CLAUDE.md (Claude Code)" : ""}${hasAgents ? "\n- AGENTS.md (Codex)" : ""}\nRead them and incorporate their relevant rules into CODESHELL.md. Do not duplicate — absorb and improve.`
          : "";

        const prompt = `Set up a CODESHELL.md for this repo. CODESHELL.md is loaded into every Code Shell session, so it must be concise — only include what would cause mistakes without it.
${migrationNote}
## Phase 1: Explore the codebase

Survey the project by reading key files:
- Manifest files: package.json, Cargo.toml, pyproject.toml, go.mod, pom.xml, etc.
- README.md
- Build configs: Makefile, tsconfig.json, webpack.config, vite.config, etc.
- CI config: .github/workflows/, .gitlab-ci.yml, etc.
- Existing AI tool configs: CLAUDE.md, AGENTS.md, .cursor/rules, .cursorrules, .github/copilot-instructions.md, .windsurfrules, .clinerules
- .codeshell/rules/ directory

Detect:
- Build, test, and lint commands (especially non-standard ones)
- Languages, frameworks, and package manager
- Project structure (monorepo, multi-module, or single project)
- Code style rules that differ from language defaults
- Formatter configuration (prettier, biome, ruff, black, gofmt, rustfmt)
- Non-obvious gotchas, required env vars, or workflow quirks

${hasExisting ? `## Phase 2: Improve existing CODESHELL.md

CODESHELL.md already exists at ${instrFile}. Read it, then propose specific improvements:
- Add missing build/test/lint commands
- Remove generic advice the model already knows
- Add gotchas or conventions found in the codebase but missing
- Incorporate relevant rules from other AI tool configs (CLAUDE.md, AGENTS.md, .cursor/rules, etc.)

Show proposed changes as diffs and explain why each change helps. Do not silently overwrite.` : `## Phase 2: Write CODESHELL.md

Write a minimal CODESHELL.md at: ${instrFile}

Every line must pass this test: "Would removing this cause the model to make mistakes?" If no, cut it.

Prefix with:
\`\`\`
# CODESHELL.md

This file provides guidance to Code Shell when working with code in this repository.
\`\`\`

Include:
- Build/test/lint commands the model can't guess (non-standard scripts, flags, sequences)
- Code style rules that DIFFER from language defaults
- Testing instructions and quirks (e.g., "run single test with: pytest -k 'test_name'")
- Repo etiquette (branch naming, PR conventions, commit style)
- Required env vars or setup steps
- Non-obvious gotchas or architectural decisions
- Important parts from existing AI tool configs (CLAUDE.md, AGENTS.md, .cursor/rules, etc.)

Exclude:
- File-by-file structure or component lists (discoverable by reading code)
- Standard language conventions the model already knows
- Generic advice ("write clean code", "handle errors")
- Commands obvious from manifest files (e.g., standard "npm test", "cargo test")
- Information that changes frequently — use @path/to/file syntax to reference it

Be specific: "Use 2-space indentation in TypeScript" > "Format code properly."`}

## Phase 3: Set up rules directory

If the project has multiple concerns, create focused rule files in .codeshell/rules/:
- code-style.md — formatting, naming, patterns
- testing.md — how to run tests, test conventions

Each rule file can have frontmatter to scope it:
\`\`\`yaml
---
description: TypeScript code style rules
globs: "**/*.ts"
---
\`\`\`

Only create rules that are specific and useful. Skip if the project is simple enough for a single CODESHELL.md.

## Phase 4: Summary

Recap what was created. Remind the user to review and tweak — these files are a starting point.`;

        const result = await ctx.client.run(prompt, ctx.sessionId);
        ctx.setSessionId(result.sessionId);

        if (existsSync(instrFile)) {
          ctx.addStatus(`CODESHELL.md ${hasExisting ? "updated" : "created"} at ${instrFile}`);
        } else {
          ctx.addStatus("Init completed. Check output above for details.");
        }
      } catch (err) {
        ctx.addStatus(`Init failed: ${(err as Error).message}`);
      }
      ctx.setIsRunning(false);
    },
  },

  {
    name: "/doctor",
    description: "Run diagnostic checks",
    execute: async (_arg, ctx) => {
      const checks: string[] = [];

      // Runtime
      const isBun = typeof (globalThis as any).Bun !== "undefined";
      if (isBun) {
        checks.push(`Runtime: Bun ${(globalThis as any).Bun.version}`);
      } else {
        checks.push(`Runtime: Node ${process.version}`);
      }
      checks.push(`Platform: ${process.platform} ${process.arch}`);

      // Git
      try {
        const gitVersion = execSync("git --version", { encoding: "utf-8", timeout: 5000 }).trim();
        checks.push(`Git:     ${gitVersion}`);
      } catch {
        checks.push(`Git:     ✗ not found`);
      }

      // Query config from server
      try {
        const configResult = await ctx.client.query("config");
        const config = configResult.data as any;
        checks.push(`Model:   ${config.model}`);
        checks.push(`CWD:     ${config.cwd}`);
      } catch {
        checks.push(`Model:   ${ctx.model}`);
      }

      // Tools
      try {
        const toolsResult = await ctx.client.query("tools");
        const tools = (toolsResult.data as any[]) ?? [];
        checks.push(`Tools:   ${tools.length} registered`);
      } catch {
        checks.push(`Tools:   unknown`);
      }

      // Settings file
      const localConfig = join(ctx.cwd, ".code-shell", "settings.json");
      checks.push(`Config:  ${existsSync(localConfig) ? localConfig : "none (using defaults)"}`);

      // CODESHELL.md / CLAUDE.md
      const instrFile = join(ctx.cwd, "CODESHELL.md");
      const claudeMd = join(ctx.cwd, "CLAUDE.md");
      if (existsSync(instrFile)) {
        checks.push(`Instructions: ✓ CODESHELL.md found`);
      } else if (existsSync(claudeMd)) {
        checks.push(`Instructions: ✓ CLAUDE.md found (compat)`);
      } else {
        checks.push(`Instructions: not found`);
      }

      // Session storage
      const sessionDir = join(homedir(), ".code-shell", "sessions");
      checks.push(`Sessions: ${sessionDir}`);

      // gh CLI
      try {
        execSync("gh --version", { encoding: "utf-8", timeout: 5000 });
        checks.push(`gh CLI:  ✓ available`);
      } catch {
        checks.push(`gh CLI:  ✗ not found (needed for PR commands)`);
      }

      ctx.addStatus("Diagnostics:\n" + checks.map((c) => `  ${c}`).join("\n"));
    },
  },

  {
    name: "/help",
    description: "Show help",
    execute: (_arg, ctx) => {
      ctx.addStatus("Use /help to see available commands.");
    },
  },
];
