#!/usr/bin/env node

/**
 * code-shell — general orchestration framework with a terminal coding preset
 */

import { Command } from "commander";
import { positiveIntOption } from "./parse-int-option.js";
import { runCommand } from "./commands/run.js";
import { replCommand } from "./commands/repl.js";
import { resolveTaskFromArgOrStdin } from "./input/read-stdin.js";
import { setup } from "../bootstrap/setup.js";
import { costTracker, installCostTracking, hasApiKey, resolveApiKey, getCurrentVersion } from "@cjhyy/code-shell-core";
import { CHALK_COLORIZER } from "../utils/colorizer.js";
import type { AgentPresetName } from "@cjhyy/code-shell-core";
import type { SessionStatus } from "@cjhyy/code-shell-core";

function formatSessionStatus(s: SessionStatus): string {
  switch (s) {
    case "completed":
      return "done";
    case "aborted_streaming":
    case "aborted_tools":
      return "aborted";
    case "prompt_too_long":
      return "ptl";
    case "model_error":
    case "image_error":
      return "error";
    case "goal_budget_exhausted":
      return "budget";
    case "stop_hook_prevented":
    case "hook_stopped":
      return "hook_stop";
    default:
      return s;
  }
}

const program = new Command();

program
  .name("code-shell")
  .description("Code Shell — general orchestration framework with a terminal coding assistant preset")
  .version(getCurrentVersion());

// ─── Shared options ───────────────────────────────────────────────

function addCommonOptions(cmd: Command): Command {
  return cmd
    .option("-m, --model <model>", "Model name (e.g. anthropic/claude-opus-4-6)")
    // No default here: a hard "openai" default would make opts.provider always
    // truthy, so the `options.provider ?? settings.model.provider` fallback in
    // repl.ts/run.ts could never reach the user's configured provider. The
    // "openai" last-resort default lives at the tail of those ?? chains.
    .option("-p, --provider <provider>", "LLM provider (anthropic, openai)")
    .option("--preset <preset>", "Agent preset (general, terminal-coding)")
    .option("--base-url <url>", "LLM API base URL (e.g. https://openrouter.ai/api/v1)")
    .option("--api-key <key>", "API key (or set OPENROUTER_API_KEY / ANTHROPIC_API_KEY env var)")
    .option("--permission-mode <mode>", "Permission mode (default, acceptEdits, bypassPermissions)")
    .option("-o, --output <format>", "Output format (text, json, jsonl, stream-json)", "text")
    .option("--max-turns <n>", "Maximum turns", positiveIntOption("--max-turns"), 100)
    .option("--effort <level>", "Reasoning effort (low, medium, high, max)", "high");
}

// ─── run ──────────────────────────────────────────────────────────

addCommonOptions(
  program
    .command("run")
    .description("Execute a single task (headless mode). Reads the task from stdin if omitted and piped.")
    .argument("[task]", "The task to execute (or pipe it via stdin)"),
)
  .option("--resume <sessionId>", "Resume a previous session")
  .option("--output-last-message <file>", "Write the final assistant message to a file")
  .option("--no-wait-background-agents", "Exit without waiting for in-flight background agents")
  .option(
    "--background-wait-ms <ms>",
    "Max ms to wait for background agents to finish",
    positiveIntOption("--background-wait-ms"),
  )
  .action(async (task: string | undefined, opts) => {
    const resolvedTask = await resolveTaskFromArgOrStdin(task);
    if (!resolvedTask) {
      console.error(
        "Error: no task provided. Pass a <task> argument or pipe a prompt via stdin.",
      );
      process.exit(2);
    }
    await runCommand({
      task: resolvedTask,
      ...resolveOpts(opts),
      // Commander maps --no-wait-background-agents to waitBackgroundAgents=false.
      waitBackgroundAgents: opts.waitBackgroundAgents as boolean | undefined,
      backgroundWaitMs: opts.backgroundWaitMs as number | undefined,
    });
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
  .option("-n, --limit <n>", "Number of sessions to show", positiveIntOption("--limit"), 10)
  .action(async (opts) => {
    const { SessionManager } = await import("@cjhyy/code-shell-core");
    const sm = new SessionManager();
    const sessions = sm.list(opts.limit as number);

    if (sessions.length === 0) {
      console.log("No sessions found.");
      return;
    }

    for (const s of sessions) {
      const date = new Date(s.startedAt).toLocaleString();
      const status = formatSessionStatus(s.status);
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
    const { SettingsManager } = await import("@cjhyy/code-shell-core");
    const settings = new SettingsManager(process.cwd()).get();
    const apiKey = resolveApiKey(resolved.apiKey, settings.model.apiKey);
    if (!apiKey) {
      console.error("Error: No API key provided.");
      process.exit(1);
    }
    await runArenaReview({ topic, models: opts.models, mode: opts.mode }, {
      llm: {
        provider: resolved.provider ?? settings.model.provider ?? "openai",
        model: resolved.model ?? settings.model.name ?? "anthropic/claude-opus-4-6",
        apiKey,
        baseUrl: resolved.baseUrl ?? settings.model.baseUrl ?? "https://openrouter.ai/api/v1",
      },
      clientDefaults: { temperature: 0.3 },
    });
  });

// ─── runs ────────────────────────────────────────────────────────

import { createRunsCommand } from "./commands/runs.js";
program.addCommand(createRunsCommand());

// ─── plugin ──────────────────────────────────────────────────────

import { createPluginCommand } from "./commands/plugin.js";
program.addCommand(createPluginCommand());

// ─── Default: if no command, go to REPL or run ───────────────────
// Don't use addCommonOptions on the root program — Commander shares
// the option namespace between the root and subcommands, causing
// subcommand options (e.g. --output on `run`) to get the root's
// default instead of the user-supplied value. Duplicate the options
// inline and enable passThroughOptions so subcommands parse their own.

program
  .argument("[task]", "Task to execute (or omit for REPL mode)")
  .option("-m, --model <model>", "Model name (e.g. anthropic/claude-opus-4-6)")
  // No "openai" default — see addCommonOptions: the default would shadow the
  // user's settings.model.provider via the ?? fallback in repl.ts/run.ts.
  .option("-p, --provider <provider>", "LLM provider (anthropic, openai)")
  .option("--preset <preset>", "Agent preset (general, terminal-coding)")
  .option("--base-url <url>", "LLM API base URL (e.g. https://openrouter.ai/api/v1)")
  .option("--api-key <key>", "API key (or set OPENROUTER_API_KEY / ANTHROPIC_API_KEY env var)")
  .option("--permission-mode <mode>", "Permission mode (default, acceptEdits, bypassPermissions)")
  .option("-o, --output <format>", "Output format (text, json, jsonl, stream-json)", "text")
  .option("--max-turns <n>", "Maximum turns", positiveIntOption("--max-turns"), 100)
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

function resolveOpts(opts: Record<string, unknown>) {
  return {
    model: opts.model as string | undefined,
    provider: opts.provider as string | undefined,
    preset: opts.preset as AgentPresetName | undefined,
    baseUrl: opts.baseUrl as string | undefined,
    apiKey: opts.apiKey as string | undefined,
    permissionMode: opts.permissionMode as string | undefined,
    output: opts.output as "text" | "json" | "jsonl" | "stream-json" | undefined,
    // commander's argParser already converted --max-turns to a number.
    maxTurns: opts.maxTurns as number | undefined,
    resume: opts.resume as string | undefined,
    effort: opts.effort as "low" | "medium" | "high" | "max" | undefined,
    outputLastMessage: opts.outputLastMessage as string | undefined,
  };
}

// ─── Initialization ──────────────────────────────────────────────

// PreAction hook: shared setup before any command executes.
//
// Onboarding is no longer driven from here. REPL-style commands render the
// Ink-based OnboardingPrompt themselves when no API key is configured;
// headless commands (run, arena) check for a key in their own action and
// error out if missing. This keeps the input stack unified on Ink and
// avoids the raw-mode/Ink stdin handoff we used to have to do.
program.hook("preAction", async (thisCommand) => {
  const opts = thisCommand.opts();
  await setup({
    cwd: process.cwd(),
    permissionMode: (opts.permissionMode ?? "acceptEdits") as import("@cjhyy/code-shell-core").PermissionMode,
  });
});

// Print cost summary on exit
process.on("exit", () => {
  const tokens = costTracker.getTotalTokens();
  if (tokens.total > 0) {
    process.stdout.write("\n" + costTracker.formatSummary(CHALK_COLORIZER) + "\n");
  }
});

// ─── Parse ────────────────────────────────────────────────────────

/** Print an error the way a CLI should — message + stack, no JSON noise. */
function reportFatal(err: unknown): never {
  process.stderr.write(
    (err instanceof Error ? (err.stack ?? err.message) : String(err)) + "\n",
  );
  process.exit(1);
}

// Backstop for any promise that rejects outside the awaited parse chain
// (e.g. a fire-and-forget started by a command). Without this, Node prints a
// raw "UnhandledPromiseRejection" stack and the deliberate exit code is lost.
process.on("unhandledRejection", reportFatal);

// Funnel every LLM call through the singleton cost tracker before any
// command runs. Awaited so an early sub-agent can't fire before the hook
// is installed.
await installCostTracking();

// parseAsync (not parse) so commander awaits each async .action() handler and
// a rejection surfaces here instead of floating off as an unhandledRejection
// with a raw stack and a collapsed exit code.
try {
  await program.parseAsync();
} catch (err) {
  reportFatal(err);
}
