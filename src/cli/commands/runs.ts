/**
 * `runs` command group — manage long-running agent tasks.
 *
 * Subcommands:
 *   code-shell runs list     — List recent runs
 *   code-shell runs get      — Inspect a run
 *   code-shell runs submit   — Submit a new managed run
 *   code-shell runs resume   — Resume a waiting/blocked run
 *   code-shell runs cancel   — Cancel a run
 *   code-shell runs events   — View run event log
 *   code-shell runs recover  — Recover crashed runs
 */

import { Command } from "commander";
import { FileRunStore } from "../../run/FileRunStore.js";
import { RunManager } from "../../run/RunManager.js";
import { SettingsManager } from "../../settings/manager.js";
import { resolveApiKey } from "../onboarding.js";
import type { LLMConfig, PermissionMode } from "../../types.js";
import type { AgentPresetName } from "../../preset/index.js";
import type { RunStatus } from "../../run/types.js";

// ─── Helpers ─────────────────────────────────────────────────────

function createRunManager(): RunManager {
  const cwd = process.cwd();
  const settings = new SettingsManager(cwd).get();

  const apiKey = resolveApiKey(undefined, settings.model.apiKey);

  const llm: LLMConfig = {
    provider: settings.model.provider ?? "openai",
    model: settings.model.name ?? "anthropic/claude-opus-4-6",
    apiKey,
    baseUrl: settings.model.baseUrl ?? "https://openrouter.ai/api/v1",
    temperature: settings.model.temperature,
    maxTokens: settings.model.maxTokens ?? 8192,
    enableStreaming: true,
  };

  const store = new FileRunStore();
  return new RunManager({
    store,
    executor: {
      llm,
      maxTurns: 30,
      maxContextTokens: settings.context.maxTokens,
      sessionStorageDir: settings.session.storageDir,
      permissionMode: (settings.permissions.defaultMode ?? "acceptEdits") as PermissionMode,
      mcpServers: settings.mcpServers,
    },
  });
}

function formatDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

function formatStatus(status: RunStatus): string {
  const icons: Record<RunStatus, string> = {
    queued: "[ ]",
    running: "[>]",
    waiting_input: "[?]",
    waiting_approval: "[!]",
    blocked: "[x]",
    completed: "[+]",
    failed: "[-]",
    cancelled: "[~]",
  };
  return `${icons[status]} ${status}`;
}

// ─── Command ─────────────────────────────────────────────────────

export function createRunsCommand(): Command {
  const runs = new Command("runs").description("Manage long-running agent tasks");

  // ─── list ────────────────────────────────────────────────────

  runs
    .command("list")
    .description("List recent runs")
    .option("-n, --limit <n>", "Number of runs to show", "20")
    .option("-s, --status <status>", "Filter by status (queued, running, completed, etc.)")
    .option("-t, --tag <tag>", "Filter by tag")
    .action(async (opts) => {
      const manager = createRunManager();
      const snapshots = await manager.list({
        limit: parseInt(opts.limit),
        status: opts.status as RunStatus | undefined,
        tag: opts.tag,
      });

      if (snapshots.length === 0) {
        console.log("No runs found.");
        return;
      }

      console.log(`\n  ${"ID".padEnd(18)} ${"Status".padEnd(22)} ${"Created".padEnd(22)} Objective`);
      console.log("  " + "─".repeat(90));

      for (const r of snapshots) {
        const id = r.runId.slice(0, 16);
        const status = formatStatus(r.status);
        const created = formatDate(r.createdAt);
        const obj = r.objective.slice(0, 40).replace(/\n/g, " ");
        console.log(`  ${id.padEnd(18)} ${status.padEnd(22)} ${created.padEnd(22)} ${obj}`);
      }
      console.log();
    });

  // ─── get ─────────────────────────────────────────────────────

  runs
    .command("get")
    .description("Inspect a run")
    .argument("<runId>", "Run ID")
    .action(async (runId: string) => {
      const manager = createRunManager();
      const run = await manager.get(runId);

      if (!run) {
        console.error(`Run not found: ${runId}`);
        process.exit(1);
      }

      console.log(`
  Run: ${run.runId}
  Status:    ${formatStatus(run.status)}
  Objective: ${run.objective.slice(0, 100)}
  Preset:    ${run.preset}
  CWD:       ${run.cwd}
  Created:   ${formatDate(run.createdAt)}
  Started:   ${formatDate(run.startedAt)}
  Finished:  ${formatDate(run.finishedAt)}
  Attempts:  ${run.attemptCount}
  Session:   ${run.sessionId ?? "—"}
  Tags:      ${run.tags.length > 0 ? run.tags.join(", ") : "—"}
  Summary:   ${run.summary ?? "—"}
  Error:     ${run.error ?? "—"}
`);
    });

  // ─── submit ──────────────────────────────────────────────────

  runs
    .command("submit")
    .description("Submit a new managed run")
    .argument("<objective>", "Task objective")
    .option("--preset <preset>", "Agent preset")
    .option("--tag <tags>", "Comma-separated tags")
    .action(async (objective: string, opts) => {
      const manager = createRunManager();
      const tags = opts.tag ? opts.tag.split(",").map((t: string) => t.trim()) : [];

      const run = await manager.submit({
        objective,
        preset: opts.preset as AgentPresetName | undefined,
        tags,
      });

      console.log(`\n  Run submitted: ${run.runId}`);
      console.log(`  Status: ${formatStatus(run.status)}`);
      console.log(`  Objective: ${run.objective.slice(0, 80)}\n`);

      // Attach and stream output
      console.log("  Streaming output...\n");
      const detach = manager.attach(run.runId, (event) => {
        if (event.type === "engine_stream") {
          const e = event.event;
          if (e.type === "text_delta") {
            process.stdout.write(e.text);
          } else if (e.type === "tool_use_start") {
            console.log(`\n  [tool] ${e.toolCall.toolName}`);
          }
        } else if (event.type === "run_status_changed") {
          const s = event.run.status;
          if (s === "completed" || s === "failed" || s === "cancelled") {
            console.log(`\n\n  Run ${s}: ${event.run.runId}`);
            if (event.run.error) console.log(`  Error: ${event.run.error}`);
            detach();
          } else if (s === "waiting_input" || s === "waiting_approval") {
            console.log(`\n\n  Run paused: ${s}`);
            console.log(`  Use: code-shell runs resume ${event.run.runId}`);
            detach();
          }
        }
      });
    });

  // ─── resume ──────────────────────────────────────────────────

  runs
    .command("resume")
    .description("Resume a waiting or blocked run")
    .argument("<runId>", "Run ID")
    .option("--input <text>", "User input to provide")
    .option("--approve", "Approve pending approval")
    .option("--reject", "Reject pending approval")
    .action(async (runId: string, opts) => {
      const manager = createRunManager();
      const run = await manager.get(runId);

      if (!run) {
        console.error(`Run not found: ${runId}`);
        process.exit(1);
      }

      const store = new FileRunStore();
      let approvalDecision: { approvalId: string; approved: boolean; reason?: string } | undefined;

      if (opts.approve || opts.reject) {
        const pendingApproval = await store.getPendingApproval(runId);
        if (!pendingApproval) {
          console.error("No pending approval found for this run.");
          process.exit(1);
        }
        approvalDecision = {
          approvalId: pendingApproval.approvalId,
          approved: !!opts.approve,
          reason: opts.reject ? "rejected by user" : undefined,
        };
      }

      await manager.resume(runId, {
        userInput: opts.input,
        approvalDecision,
      });

      console.log(`\n  Run resumed: ${runId}\n`);
    });

  // ─── cancel ──────────────────────────────────────────────────

  runs
    .command("cancel")
    .description("Cancel a run")
    .argument("<runId>", "Run ID")
    .option("--reason <text>", "Cancellation reason")
    .action(async (runId: string, opts) => {
      const manager = createRunManager();

      try {
        await manager.cancel(runId, opts.reason);
        console.log(`\n  Run cancelled: ${runId}\n`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // ─── events ──────────────────────────────────────────────────

  runs
    .command("events")
    .description("View run event log")
    .argument("<runId>", "Run ID")
    .option("-n, --limit <n>", "Number of events to show", "50")
    .action(async (runId: string, opts) => {
      const manager = createRunManager();
      const events = await manager.getEvents(runId);

      if (events.length === 0) {
        console.log("No events found.");
        return;
      }

      const limit = parseInt(opts.limit);
      const shown = events.slice(-limit);

      console.log(`\n  Events for run ${runId} (showing last ${shown.length} of ${events.length}):\n`);

      for (const e of shown) {
        const time = new Date(e.timestamp).toLocaleTimeString();
        const data = Object.keys(e.data).length > 0
          ? " " + JSON.stringify(e.data).slice(0, 80)
          : "";
        console.log(`  ${time}  ${e.type}${data}`);
      }
      console.log();
    });

  // ─── recover ─────────────────────────────────────────────────

  runs
    .command("recover")
    .description("Recover crashed runs (run on startup)")
    .action(async () => {
      const manager = createRunManager();
      const recovered = await manager.recover();

      if (recovered.length === 0) {
        console.log("No crashed runs found.");
      } else {
        console.log(`\n  Recovered ${recovered.length} run(s):`);
        for (const id of recovered) {
          const run = await manager.get(id);
          console.log(`    ${id}  ${formatStatus(run?.status ?? "blocked")}`);
        }
        console.log();
      }
    });

  return runs;
}
