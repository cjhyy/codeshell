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
        let removed = false;
        if (settings.model?.apiKey) {
          delete settings.model.apiKey;
          removed = true;
        }
        if (settings.arena) {
          delete settings.arena;
          removed = true;
        }
        if (removed) {
          writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf-8");
          ctx.addStatus("✓ API key and Arena config cleared. Restart to re-enter onboarding.");
        } else {
          ctx.addStatus("No saved API key.");
        }
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
    description: "Show recent log entries",
    usage: "/log [n]  — show last n entries (default: 20)",
    execute: (arg, ctx) => {
      const logDir = join(homedir(), ".code-shell", "logs");
      const dateStr = new Date().toISOString().slice(0, 10);
      const logFile = join(logDir, `${dateStr}.log`);

      if (!existsSync(logFile)) {
        ctx.addStatus(`No logs found for today (${dateStr}).`);
        return;
      }

      try {
        const content = readFileSync(logFile, "utf-8");
        const lines = content
          .trim()
          .split("\n")
          .filter((l) => l.trim());
        const count = Math.max(1, Math.min(parseInt(arg.trim()) || 20, 200));
        const recent = lines.slice(-count);

        const formatted = recent.map((line) => {
          try {
            const e = JSON.parse(line) as {
              t?: string;
              l?: string;
              msg?: string;
              d?: {
                latencyMs?: number;
                usage?: { totalTokens?: number };
                tool?: string;
                stopReason?: string;
              };
            };
            const time = e.t?.split("T")[1]?.slice(0, 8) ?? "";
            const level = (e.l ?? "").toUpperCase().padEnd(5);
            const msg = e.msg ?? "";
            let detail = "";
            const d = e.d;
            if (d) {
              if (d.latencyMs) detail += ` ${d.latencyMs}ms`;
              if (d.usage?.totalTokens) detail += ` ${d.usage.totalTokens}tok`;
              if (d.tool) detail += ` ${d.tool}`;
              if (d.stopReason) detail += ` [${d.stopReason}]`;
            }
            return `  ${time} ${level} ${msg}${detail}`;
          } catch {
            return `  ${line.slice(0, 120)}`;
          }
        });

        ctx.addStatus(`Recent logs (${recent.length}/${lines.length}):\n${formatted.join("\n")}`);
      } catch (err) {
        ctx.addStatus(`Error reading logs: ${(err as Error).message}`);
      }
    },
  },
];
