/**
 * Extra slash commands — /login, /logout, /mcp (config & auth);
 * /skills, /log (read-only inspection); /models (interactive panel).
 */

import type { SlashCommand } from "../registry.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { scanSkills } from "../../../skills/index.js";

export const extraCommands: SlashCommand[] = [
  {
    name: "/login",
    group: "config",
    description: "Reconfigure API key and provider interactively",
    usage: "/login [api-key]",
    execute: async (arg, ctx) => {
      const key = arg.trim();
      if (key) {
        const settingsDir = join(homedir(), ".code-shell");
        const settingsFile = join(settingsDir, "settings.json");
        mkdirSync(settingsDir, { recursive: true });

        let settings: Record<string, any> = {};
        if (existsSync(settingsFile)) {
          try {
            settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
          } catch {}
        }
        if (!settings.model) settings.model = {};
        settings.model.apiKey = key;
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf-8");
        ctx.addStatus("✓ API key saved. Restart code-shell to apply.");
        return;
      }
      if (ctx.startOnboarding) {
        ctx.startOnboarding();
      } else {
        ctx.addStatus("Onboarding wizard only available in REPL mode. Restart code-shell.");
      }
    },
  },

  {
    name: "/logout",
    group: "config",
    description: "Remove saved API key and configuration",
    execute: (_arg, ctx) => {
      const settingsFile = join(homedir(), ".code-shell", "settings.json");
      if (!existsSync(settingsFile)) {
        ctx.addStatus("No saved config.");
        return;
      }
      try {
        const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
        const cleared: string[] = [];
        if (settings.model?.apiKey) {
          delete settings.model.apiKey;
          cleared.push("model.apiKey");
        }
        if (Array.isArray(settings.models)) {
          let n = 0;
          for (const m of settings.models) {
            if (m && typeof m === "object" && m.apiKey) {
              delete m.apiKey;
              n++;
            }
          }
          if (n > 0) cleared.push(`models[].apiKey (${n})`);
        }
        if (settings.arena) {
          delete settings.arena;
          cleared.push("arena");
        }

        // Detect provider env vars that would silently override a "logged out"
        // state on next startup, so the user knows /logout alone isn't enough.
        const ENV_KEYS = [
          "ANTHROPIC_API_KEY",
          "OPENAI_API_KEY",
          "OPENROUTER_API_KEY",
          "DEEPSEEK_API_KEY",
        ];
        const activeEnv = ENV_KEYS.filter((k) => process.env[k]);

        if (cleared.length === 0) {
          const envNote = activeEnv.length
            ? `\nNote: env var(s) still set: ${activeEnv.join(", ")} — unset to fully log out.`
            : "";
          ctx.addStatus(`No saved API key.${envNote}`);
          return;
        }

        writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf-8");
        const envNote = activeEnv.length
          ? `\n⚠ Env var(s) still set: ${activeEnv.join(", ")} — unset to fully log out.`
          : "";
        ctx.addStatus(
          `✓ Cleared: ${cleared.join(", ")}. Restart to re-enter onboarding.${envNote}`,
        );
      } catch (err) {
        ctx.addStatus(`Failed: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "/mcp",
    group: "config",
    description: "Show MCP server connection status",
    usage: "/mcp [list|status]",
    execute: async (_arg, ctx) => {
      const configResult = await ctx.client.query("config");
      const config = configResult.data as any;
      const servers = config.mcpServers ?? {};
      const names = Object.keys(servers);

      if (names.length === 0) {
        ctx.addStatus(
          "No MCP servers configured.\n" +
            "Add to .code-shell/settings.json:\n" +
            '  "mcpServers": { "name": { "command": "...", "args": [...] } }',
        );
        return;
      }

      const lines = names.map((name) => {
        const s = servers[name];
        const transport = s.transport ?? "stdio";
        const cmd = s.command ?? s.url ?? "?";
        return `  ${name} [${transport}] — ${cmd}`;
      });
      ctx.addStatus(`MCP Servers (${names.length}):\n${lines.join("\n")}`);
    },
  },

  {
    name: "/models",
    group: "config",
    description: "Open the model management panel (list, switch, sync)",
    execute: (_arg, ctx) => {
      if (ctx.openModelManager) {
        ctx.openModelManager();
      } else {
        ctx.addStatus("Model manager only available in REPL mode. Use /model <key> to switch.");
      }
    },
  },

  {
    name: "/skills",
    group: "config",
    description: "List skills available to the model",
    execute: (_arg, ctx) => {
      try {
        const skills = scanSkills(ctx.cwd);
        if (skills.length === 0) {
          ctx.addStatus(
            "No skills found.\n" +
              "Add .md files to one of:\n" +
              "  .code-shell/skills/   .claude/skills/   (project)\n" +
              "  ~/.code-shell/skills/   ~/.claude/skills/  (global)",
          );
          return;
        }
        const lines = skills.map((s) => `  ${s.name} — ${s.description || "(no description)"}`);
        ctx.addStatus(`Skills (${skills.length}):\n${lines.join("\n")}`);
      } catch (err) {
        ctx.addStatus(`Failed to scan skills: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "/log",
    aliases: ["/logs"],
    group: "config",
    description: "Show recent log entries; filter by sid / turn / cat",
    usage: "/log [n] | /log sid <id> [n] | /log turn <id> [n] | /log cat <name> [n]",
    execute: (arg, ctx) => {
      const logDir = join(homedir(), ".code-shell", "logs");
      const dateStr = new Date().toISOString().slice(0, 10);
      const logFile = join(logDir, `${dateStr}.log`);

      if (!existsSync(logFile)) {
        ctx.addStatus(`No logs found for today (${dateStr}).`);
        return;
      }

      // Parse: "[mode value] [n]". Modes: sid|turn|cat. Defaults: tail mode + 20.
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      let mode: "tail" | "sid" | "turn" | "cat" = "tail";
      let value: string | null = null;
      let countArg: string | undefined;
      if (parts[0] === "sid" || parts[0] === "turn" || parts[0] === "cat") {
        mode = parts[0];
        value = parts[1] ?? null;
        countArg = parts[2];
        if (!value) {
          ctx.addStatus(`Usage: /log ${mode} <value> [n]`);
          return;
        }
      } else {
        countArg = parts[0];
      }
      // Filtered queries can scan up to 2000 entries; tail caps at 200 to
      // keep the chat output readable.
      const cap = mode === "tail" ? 200 : 2000;
      const count = Math.max(1, Math.min(parseInt(countArg ?? "") || 20, cap));

      try {
        const content = readFileSync(logFile, "utf-8");
        const lines = content
          .trim()
          .split("\n")
          .filter((l) => l.trim());

        // Filter by mode. We parse JSON once and reuse it for the formatter
        // so we don't pay JSON.parse twice per matched line.
        type Entry = {
          t?: string;
          l?: string;
          msg?: string;
          cat?: string;
          sid?: string;
          turn?: number;
          turnId?: string;
          d?: {
            latencyMs?: number;
            duration_ms?: number;
            usage?: { totalTokens?: number };
            tool?: string;
            stopReason?: string;
            decision?: string;
            approved?: boolean;
            ttft_ms?: number;
            error?: string;
          };
        };
        const matched: Array<{ raw: string; e: Entry | null }> = [];
        for (const line of lines) {
          let e: Entry | null = null;
          try {
            e = JSON.parse(line) as Entry;
          } catch {
            // Non-JSON line — only keep it for unfiltered tail mode.
            if (mode === "tail") matched.push({ raw: line, e: null });
            continue;
          }
          if (mode === "sid" && e.sid !== value) continue;
          if (mode === "turn" && e.turnId !== value) continue;
          if (mode === "cat" && e.cat !== value) continue;
          matched.push({ raw: line, e });
        }

        const recent = matched.slice(-count);
        const formatted = recent.map(({ raw, e }) => {
          if (!e) return `  ${raw.slice(0, 120)}`;
          const time = e.t?.split("T")[1]?.slice(0, 12) ?? "";
          const level = (e.l ?? "").toUpperCase().padEnd(5);
          const msg = e.msg ?? "";
          let head = `  ${time} ${level}`;
          // Always surface turn ID inline for filtered views so the user
          // sees boundaries between turns at a glance.
          if (mode !== "turn" && e.turnId) head += ` [t#${e.turn}/${e.turnId}]`;
          if (mode === "tail" && e.cat) head += ` ${e.cat}`;
          let detail = "";
          const d = e.d;
          if (d) {
            if (d.duration_ms !== undefined) detail += ` ${d.duration_ms}ms`;
            else if (d.latencyMs !== undefined) detail += ` ${d.latencyMs}ms`;
            if (d.ttft_ms !== undefined) detail += ` ttft=${d.ttft_ms}ms`;
            if (d.usage?.totalTokens) detail += ` ${d.usage.totalTokens}tok`;
            if (d.tool) detail += ` tool=${d.tool}`;
            if (d.decision) detail += ` decision=${d.decision}`;
            if (d.approved !== undefined) detail += ` approved=${d.approved}`;
            if (d.stopReason) detail += ` [${d.stopReason}]`;
            if (d.error) detail += ` err=${d.error.slice(0, 80)}`;
          }
          return `${head} ${msg}${detail}`;
        });

        const header =
          mode === "tail"
            ? `Recent logs (${recent.length}/${lines.length})`
            : `Logs filtered by ${mode}=${value} (${recent.length}/${matched.length}, scanned ${lines.length})`;
        ctx.addStatus(`${header}:\n${formatted.join("\n")}`);
      } catch (err) {
        ctx.addStatus(`Error reading logs: ${(err as Error).message}`);
      }
    },
  },
];
