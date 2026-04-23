#!/usr/bin/env node

/**
 * code-shell — general orchestration framework with a terminal coding preset
 */

import { Command } from "commander";
import { runCommand } from "./commands/run.js";
import { replCommand } from "./commands/repl.js";
import { setup } from "../bootstrap/setup.js";
import { costTracker } from "./cost-tracker.js";
import { hasApiKey, runOnboarding } from "./onboarding.js";
import type { AgentPresetName } from "../preset/index.js";

const program = new Command();

program
  .name("code-shell")
  .description("Code Shell — general orchestration framework with a terminal coding assistant preset")
  .version("0.1.0");

// ─── Shared options ───────────────────────────────────────────────

function addCommonOptions(cmd: Command): Command {
  return cmd
    .option("-m, --model <model>", "Model name (e.g. anthropic/claude-opus-4-6)")
    .option("-p, --provider <provider>", "LLM provider (anthropic, openai)", "openai")
    .option("--preset <preset>", "Agent preset (general, terminal-coding)")
    .option("--base-url <url>", "LLM API base URL (e.g. https://openrouter.ai/api/v1)")
    .option("--api-key <key>", "API key (or set OPENROUTER_API_KEY / ANTHROPIC_API_KEY env var)")
    .option("--permission-mode <mode>", "Permission mode (default, acceptEdits, bypassPermissions)")
    .option("-o, --output <format>", "Output format (text, json, jsonl, stream-json)", "text")
    .option("--max-turns <n>", "Maximum turns", "30")
    .option("--effort <level>", "Reasoning effort (low, medium, high, max)", "high");
}

// ─── run ──────────────────────────────────────────────────────────

addCommonOptions(
  program
    .command("run")
    .description("Execute a single task (headless mode)")
    .argument("<task>", "The task to execute"),
)
  .option("--resume <sessionId>", "Resume a previous session")
  .action(async (task: string, opts) => {
    await runCommand({ task, ...resolveOpts(opts) });
  });

// ─── repl (default) ──────────────────────────────────────────────

addCommonOptions(
  program
    .command("repl")
    .description("Interactive REPL mode (default)"),
)
  .action(async (opts) => {
    await replCommand(resolveOpts(opts));
  });

// ─── sessions ─────────────────────────────────────────────────────

program
  .command("sessions")
  .description("List recent sessions")
  .option("-n, --limit <n>", "Number of sessions to show", "10")
  .action(async (opts) => {
    const { SessionManager } = await import("../session/session-manager.js");
    const sm = new SessionManager();
    const sessions = sm.list(parseInt(opts.limit));

    if (sessions.length === 0) {
      console.log("No sessions found.");
      return;
    }

    for (const s of sessions) {
      const date = new Date(s.startedAt).toLocaleString();
      const status = s.status === "completed" ? "done" : s.status;
      console.log(`  ${s.sessionId}  ${date}  ${status}  ${s.model}  turns:${s.turnCount}`);
    }
  });

// ─── arena ────────────────────────────────────────────────────────

addCommonOptions(
  program
    .command("arena")
    .description("Multi-model review arena — agent gathers context, multiple models discuss")
    .argument("<topic>", "What to review (agent will find relevant code)")
    .option("--models <models>", "Models to use (e.g. claude,gpt4o,deepseek)")
    .option("--mode <mode>", "Arena mode: review, discussion, or planning (auto-detected if omitted)"),
)
  .action(async (topic: string, opts) => {
    const resolved = resolveOpts(opts);
    const { runArenaReview } = await import("./commands/arena.js");
    const { SettingsManager } = await import("../settings/manager.js");
    const settings = new SettingsManager(process.cwd()).get();
    const apiKey = resolved.apiKey ?? settings.model.apiKey ??
      process.env.OPENROUTER_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("Error: No API key provided.");
      process.exit(1);
    }
    let arg = topic;
    if (opts.models) arg = `--models ${opts.models} ${arg}`;
    if (opts.mode) arg = `--mode ${opts.mode} ${arg}`;
    await runArenaReview(arg, {
      llm: {
        provider: resolved.provider ?? settings.model.provider ?? "openai",
        model: resolved.model ?? settings.model.name ?? "anthropic/claude-opus-4-6",
        apiKey,
        baseUrl: resolved.baseUrl ?? settings.model.baseUrl ?? "https://openrouter.ai/api/v1",
        temperature: 0.3,
        enableStreaming: false,
      },
    });
  });

// ─── runs ────────────────────────────────────────────────────────

import { createRunsCommand } from "./commands/runs.js";
program.addCommand(createRunsCommand());

// ─── Default: if no command, go to REPL or run ───────────────────
// Don't use addCommonOptions on the root program — Commander shares
// the option namespace between the root and subcommands, causing
// subcommand options (e.g. --output on `run`) to get the root's
// default instead of the user-supplied value. Duplicate the options
// inline and enable passThroughOptions so subcommands parse their own.

program
  .argument("[task]", "Task to execute (or omit for REPL mode)")
  .option("-m, --model <model>", "Model name (e.g. anthropic/claude-opus-4-6)")
  .option("-p, --provider <provider>", "LLM provider (anthropic, openai)", "openai")
  .option("--preset <preset>", "Agent preset (general, terminal-coding)")
  .option("--base-url <url>", "LLM API base URL (e.g. https://openrouter.ai/api/v1)")
  .option("--api-key <key>", "API key (or set OPENROUTER_API_KEY / ANTHROPIC_API_KEY env var)")
  .option("--permission-mode <mode>", "Permission mode (default, acceptEdits, bypassPermissions)")
  .option("-o, --output <format>", "Output format (text, json, jsonl, stream-json)", "text")
  .option("--max-turns <n>", "Maximum turns", "30")
  .option("--effort <level>", "Reasoning effort (low, medium, high, max)", "high")
  .option("--resume <sessionId>", "Resume a previous session")
  .option("--prefill <text>", "Pre-fill the input box without submitting")
  .passThroughOptions()
  .action(async (task: string | undefined, opts) => {
    const resolved = resolveOpts(opts);
    if (task) {
      await runCommand({ task, ...resolved });
    } else {
      await replCommand({ ...resolved, prefill: opts.prefill });
    }
  });

// ─── Helpers ──────────────────────────────────────────────────────

function resolveOpts(opts: Record<string, string | undefined>) {
  return {
    model: opts.model,
    provider: opts.provider,
    preset: opts.preset as AgentPresetName | undefined,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    permissionMode: opts.permissionMode,
    output: opts.output as "text" | "json" | "jsonl" | "stream-json" | undefined,
    maxTurns: opts.maxTurns ? parseInt(opts.maxTurns) : undefined,
    resume: opts.resume,
    effort: opts.effort as "low" | "medium" | "high" | "max" | undefined,
  };
}

// ─── Initialization ──────────────────────────────────────────────

// PreAction hook: run setup + onboarding before any command executes
program.hook("preAction", async (thisCommand) => {
  const cmdName = thisCommand.name();
  const opts = thisCommand.opts();

  // Skip onboarding for info-only commands
  const skipOnboarding = ["sessions", "help", "version"].includes(cmdName);

  // Run first-time setup if no API key is found
  if (!skipOnboarding && !opts.apiKey && !hasApiKey()) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "Error: No API key configured and stdin is not a TTY.\n" +
        "Set an API key via environment variable (e.g. OPENROUTER_API_KEY) " +
        "or run Code Shell interactively to complete onboarding.\n",
      );
      process.exit(1);
    }
    const result = await runOnboarding();
    // Inject into command opts so downstream action picks them up.
    // Also saved to ~/.code-shell/settings.json for future runs.
    thisCommand.setOptionValue("apiKey", result.apiKey);
    if (!opts.model) thisCommand.setOptionValue("model", result.model);
    if (!opts.provider) thisCommand.setOptionValue("provider", result.provider);
    if (!opts.baseUrl) thisCommand.setOptionValue("baseUrl", result.baseUrl);
  }

  await setup({
    cwd: process.cwd(),
    permissionMode: (opts.permissionMode ?? "acceptEdits") as import("../types.js").PermissionMode,
  });
});

// Print cost summary on exit
process.on("exit", () => {
  const tokens = costTracker.getTotalTokens();
  if (tokens.total > 0) {
    process.stdout.write("\n" + costTracker.formatSummary() + "\n");
  }
});

// ─── Parse ────────────────────────────────────────────────────────

program.parse();
