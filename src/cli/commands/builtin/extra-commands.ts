/**
 * Extra slash commands — /dream, /login, /logout, /mcp, /context, /stats,
 * /summary, /skills, /agents, /theme, /output-style
 */

import type { SlashCommand } from "../registry.js";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const extraCommands: SlashCommand[] = [
  // ─── /dream — organize and consolidate memories ────────────────

  {
    name: "/dream",
    group: "context",
    description: "Organize, consolidate, and clean up memories",
    execute: async (_arg, ctx) => {
      ctx.setIsRunning(true);
      try {
        const { MemoryManager } = await import("../../../session/memory.js");
        const mm = new MemoryManager(ctx.cwd);
        const entries = mm.loadAll();

        if (entries.length === 0) {
          ctx.addStatus("No memories to organize.");
          ctx.setIsRunning(false);
          return;
        }

        // Build a prompt that reads all memories and asks the model to organize them
        const memoryDump = entries
          .map((e) => `## [${e.type}] ${e.name}\n${e.description}\n\n${e.content}`)
          .join("\n\n---\n\n");

        const prompt =
          `You have access to the user's persistent memory system. Below are all current memories.\n\n` +
          `${memoryDump}\n\n` +
          `Please analyze these memories and:\n` +
          `1. Identify any duplicates or near-duplicates — merge them\n` +
          `2. Identify outdated or stale memories — suggest removing them\n` +
          `3. Consolidate related memories into cleaner, more concise entries\n` +
          `4. Ensure each memory has a clear, specific description\n` +
          `5. Re-categorize any mistyped memories (user/feedback/project/reference)\n\n` +
          `For each change, use the Write tool to update the memory files in the memory directory.\n` +
          `Memory directory: ${join(homedir(), ".code-shell", "projects", ctx.cwd.replace(/[/\\:]/g, "-").replace(/^-/, ""), "memory")}\n\n` +
          `After making changes, provide a summary of what you organized.`;

        const result = await ctx.client.run(prompt, ctx.sessionId);
        ctx.setSessionId(result.sessionId);
      } catch (err) {
        ctx.addStatus(`Dream failed: ${(err as Error).message}`);
      }
      ctx.setIsRunning(false);
    },
  },

  // ─── /models — model pool management ───────────────────────────

  {
    name: "/models",
    group: "config",
    description: "Manage the model pool",
    usage: "/models [add <model>|remove <key>]",
    execute: async (arg, ctx) => {
      const parts = arg.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase();

      if (sub === "add" && parts[1]) {
        // Add a model to pool via settings
        const modelPath = parts[1];
        const settingsDir = join(homedir(), ".code-shell");
        const settingsFile = join(settingsDir, "settings.json");
        mkdirSync(settingsDir, { recursive: true });

        let settings: Record<string, any> = {};
        if (existsSync(settingsFile)) {
          try { settings = JSON.parse(readFileSync(settingsFile, "utf-8")); } catch {}
        }

        if (!settings.models) settings.models = [];
        const existing = settings.models.find((m: any) => m.model === modelPath);
        if (existing) {
          ctx.addStatus(`Model "${modelPath}" already in pool as "${existing.key}".`);
          return;
        }

        // Derive key
        const slash = modelPath.lastIndexOf("/");
        const base = slash >= 0 ? modelPath.slice(slash + 1) : modelPath;
        let key = base.split("-")[0] ?? base;
        // Ensure unique
        const keys = new Set(settings.models.map((m: any) => m.key));
        let candidate = key;
        let n = 2;
        while (keys.has(candidate)) { candidate = `${key}${n++}`; }
        key = candidate;

        settings.models.push({
          key,
          label: base,
          provider: settings.model?.provider ?? "openai",
          model: modelPath,
          baseUrl: settings.model?.baseUrl,
          apiKey: settings.model?.apiKey,
        });
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf-8");
        ctx.addStatus(`✓ Added "${modelPath}" as "${key}". Restart to apply.`);
        return;
      }

      if (sub === "remove" && parts[1]) {
        const key = parts[1];
        const settingsFile = join(homedir(), ".code-shell", "settings.json");
        if (!existsSync(settingsFile)) { ctx.addStatus("No settings found."); return; }
        try {
          const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
          const before = settings.models?.length ?? 0;
          settings.models = (settings.models ?? []).filter((m: any) => m.key !== key);
          if (settings.models.length === before) {
            ctx.addStatus(`Key "${key}" not found in pool.`);
            return;
          }
          // Also remove from arena if present
          if (settings.arena?.participants) {
            settings.arena.participants = settings.arena.participants.filter(
              (p: any) => p !== key && p?.key !== key,
            );
          }
          writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf-8");
          ctx.addStatus(`✓ Removed "${key}" from pool. Restart to apply.`);
        } catch (err) {
          ctx.addStatus(`Error: ${(err as Error).message}`);
        }
        return;
      }

      // Default: list pool from server
      try {
        const result = await ctx.client.query("models");
        const models = (result.data as any[]) ?? [];
        if (models.length === 0) {
          ctx.addStatus(
            "Model pool is empty.\n" +
            "Add models during /login setup or use: /models add <model-path>",
          );
          return;
        }
        const lines = models.map((m: any) => {
          const active = m.active ? chalk.green(" ← active") : "";
          return `  ${chalk.cyan(m.key.padEnd(16))} ${m.model}${active}`;
        });
        ctx.addStatus(
          `Model Pool (${models.length}):\n${lines.join("\n")}\n\n` +
          `Switch:  /model <key>\n` +
          `Add:     /models add <model-path>\n` +
          `Remove:  /models remove <key>`,
        );
      } catch (err) {
        ctx.addStatus(`Error: ${(err as Error).message}`);
      }
    },
  },

  // ─── /login /logout — API key management ───────────────────────

  {
    name: "/login",
    group: "config",
    description: "Reconfigure API key and provider interactively",
    usage: "/login [api-key]",
    execute: async (arg, ctx) => {
      const key = arg.trim();
      if (key) {
        // Quick mode: just save the key directly
        const settingsDir = join(homedir(), ".code-shell");
        const settingsFile = join(settingsDir, "settings.json");
        mkdirSync(settingsDir, { recursive: true });

        let settings: Record<string, any> = {};
        if (existsSync(settingsFile)) {
          try { settings = JSON.parse(readFileSync(settingsFile, "utf-8")); } catch {}
        }
        if (!settings.model) settings.model = {};
        settings.model.apiKey = key;
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf-8");
        ctx.addStatus("✓ API key 已保存。重启 code-shell 生效。");
        return;
      }
      // Interactive mode: run full onboarding wizard
      ctx.addStatus("启动配置向导... (完成后需要重启 code-shell)");
      try {
        const { reconfigure } = await import("../../onboarding.js");
        await reconfigure();
        ctx.addStatus("✓ 配置完成。请重启 code-shell 以使新配置生效。");
      } catch (err) {
        ctx.addStatus(`配置失败: ${(err as Error).message}`);
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
        ctx.addStatus("没有已保存的配置。");
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
          ctx.addStatus("✓ API key 和 Arena 配置已清除。重启后会进入配置向导。");
        } else {
          ctx.addStatus("没有已保存的 API key。");
        }
      } catch (err) {
        ctx.addStatus(`失败: ${(err as Error).message}`);
      }
    },
  },

  // ─── /mcp — MCP server management ─────────────────────────────

  {
    name: "/mcp",
    group: "config",
    description: "Manage MCP servers",
    usage: "/mcp [list|status]",
    execute: async (_arg, ctx) => {
      const configResult = await ctx.client.query("config");
      const config = configResult.data as any;
      const servers = config.mcpServers ?? {};
      const names = Object.keys(servers);

      if (names.length === 0) {
        ctx.addStatus(
          "No MCP servers configured.\n" +
          "Add to .code-shell/settings.json or ~/.code-shell/settings.json:\n" +
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

  // ─── /context — show context window usage ──────────────────────

  {
    name: "/context",
    group: "context",
    description: "Show context window usage",
    execute: async (_arg, ctx) => {
      const { estimateStringTokens } = await import("../../../context/token-counter.js");
      const configResult = await ctx.client.query("config");
      const config = configResult.data as any;
      const maxTokens = config.maxContextTokens ?? 200_000;

      // Rough estimate based on session
      const { costTracker } = await import("../../cost-tracker.js");
      const tokens = costTracker.getTotalTokens();
      const lastPromptTokens = tokens.prompt; // Approximate current context size

      const percent = ((lastPromptTokens / maxTokens) * 100).toFixed(1);
      const width = 30;
      const filled = Math.round((lastPromptTokens / maxTokens) * width);
      const bar = "█".repeat(Math.min(filled, width)) + "░".repeat(Math.max(0, width - filled));

      const color = Number(percent) > 80 ? "!" : Number(percent) > 60 ? "~" : "";

      ctx.addStatus(
        `Context Window:\n` +
        `  [${bar}] ${percent}%\n` +
        `  Used:  ~${formatNum(lastPromptTokens)} tokens\n` +
        `  Max:   ${formatNum(maxTokens)} tokens\n` +
        `  Free:  ~${formatNum(maxTokens - lastPromptTokens)} tokens`,
      );
    },
  },

  // ─── /stats — detailed usage statistics ────────────────────────

  {
    name: "/stats",
    description: "Show detailed usage statistics",
    execute: async (_arg, ctx) => {
      const { costTracker } = await import("../../cost-tracker.js");
      ctx.addStatus(costTracker.formatSummary());
    },
  },

  // ─── /summary — summarize current session ──────────────────────

  {
    name: "/summary",
    group: "context",
    description: "Generate a summary of the current session",
    execute: async (_arg, ctx) => {
      if (!ctx.sessionId) {
        ctx.addStatus("No active session.");
        return;
      }
      ctx.setIsRunning(true);
      try {
        const prompt =
          "Summarize our conversation so far in 3-5 bullet points. " +
          "Focus on: what was asked, what was done, key decisions made, and any outstanding items.";
        const result = await ctx.client.run(prompt, ctx.sessionId);
        ctx.setSessionId(result.sessionId);
      } catch (err) {
        ctx.addStatus(`Summary failed: ${(err as Error).message}`);
      }
      ctx.setIsRunning(false);
    },
  },

  // ─── /skills — list registered skills ──────────────────────────

  {
    name: "/skills",
    group: "config",
    description: "List registered skills",
    execute: async (_arg, ctx) => {
      try {
        const { scanSkills } = await import("../../../skills/index.js");
        const skills = scanSkills(ctx.cwd);
        if (skills.length === 0) {
          ctx.addStatus(
            "No skills found.\n" +
            "Add .md files to .code-shell/skills/ or ~/.code-shell/skills/",
          );
          return;
        }
        const lines = skills.map((s: any) => `  ${s.name} — ${s.description ?? "(no description)"}`);
        ctx.addStatus(`Skills (${skills.length}):\n${lines.join("\n")}`);
      } catch (err) {
        ctx.addStatus(`Failed to scan skills: ${(err as Error).message}`);
      }
    },
  },

  // ─── /agents — list active sub-agents ──────────────────────────

  {
    name: "/agents",
    description: "List active sub-agents",
    execute: async (_arg, ctx) => {
      const { agentCoordinator } = await import("../../../agent/coordinator.js");
      const agents = agentCoordinator.list();
      if (agents.length === 0) {
        ctx.addStatus("No agents running.");
        return;
      }
      const lines = agents.map((a) => {
        const dur = a.completedAt
          ? `${((a.completedAt - a.startedAt) / 1000).toFixed(1)}s`
          : `${((Date.now() - a.startedAt) / 1000).toFixed(1)}s...`;
        return `  ${a.status === "running" ? "◉" : a.status === "completed" ? "✓" : "✗"} ${a.name} [${a.status}] — ${a.description} (${dur})`;
      });
      ctx.addStatus(`Agents (${agents.length}):\n${lines.join("\n")}`);
    },
  },

  // ─── /theme — switch color theme ───────────────────────────────

  {
    name: "/theme",
    group: "config",
    description: "Switch color theme",
    usage: "/theme [default|dark|light|minimal]",
    execute: (arg, ctx) => {
      const themes = ["default", "dark", "light", "minimal"];
      if (!arg || !themes.includes(arg)) {
        ctx.addStatus(`Available themes: ${themes.join(", ")}\nUsage: /theme <name>`);
        return;
      }
      // Store preference in settings
      const settingsDir = join(homedir(), ".code-shell");
      const settingsFile = join(settingsDir, "settings.json");
      mkdirSync(settingsDir, { recursive: true });

      let settings: Record<string, any> = {};
      if (existsSync(settingsFile)) {
        try { settings = JSON.parse(readFileSync(settingsFile, "utf-8")); } catch {}
      }
      settings.theme = arg;
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf-8");
      ctx.addStatus(`Theme set to: ${arg}. Takes effect on next startup.`);
    },
  },

  // ─── /output-style — switch output verbosity ───────────────────

  {
    name: "/output-style",
    aliases: ["/output"],
    group: "config",
    description: "Switch output style",
    usage: "/output-style [verbose|concise|streaming]",
    execute: (arg, ctx) => {
      const styles = ["verbose", "concise", "streaming"];
      if (!arg || !styles.includes(arg)) {
        ctx.addStatus(`Available styles: ${styles.join(", ")}\nUsage: /output-style <style>`);
        return;
      }
      ctx.addStatus(`Output style set to: ${arg}`);
    },
  },

  // ─── /log — view recent logs ───────────────────────────────────

  {
    name: "/log",
    aliases: ["/logs"],
    description: "Show recent log entries (API calls, tool executions)",
    usage: "/log [n]  — show last n entries (default: 10)",
    execute: (_arg, ctx) => {
      try {
        const { readFileSync, existsSync: ex } = require("node:fs");
        const { join: j } = require("node:path");
        const { homedir: hd } = require("node:os");
        const logDir = j(hd(), ".code-shell", "logs");
        const dateStr = new Date().toISOString().split("T")[0];
        const logFile = j(logDir, `${dateStr}.log`);

        if (!ex(logFile)) {
          ctx.addStatus("No logs found for today.");
          return;
        }

        const content = readFileSync(logFile, "utf-8");
        const lines = content.trim().split("\n").filter((l: string) => l.trim());
        const count = _arg ? parseInt(_arg) || 10 : 10;
        const recent = lines.slice(-count);

        const formatted = recent.map((line: string) => {
          try {
            const entry = JSON.parse(line);
            const time = (entry.t as string).split("T")[1]?.slice(0, 8) ?? "";
            const level = (entry.l as string).toUpperCase().padEnd(5);
            const msg = entry.msg as string;
            const data = entry.d;

            let detail = "";
            if (data) {
              if (data.latencyMs) detail += ` ${data.latencyMs}ms`;
              if (data.usage?.totalTokens) detail += ` ${formatNum(data.usage.totalTokens)}tok`;
              if (data.tool) detail += ` ${data.tool}`;
              if (data.stopReason) detail += ` [${data.stopReason}]`;
            }

            return `  ${time} ${level} ${msg}${detail}`;
          } catch {
            return `  ${line.slice(0, 100)}`;
          }
        });

        ctx.addStatus(`Recent logs (${recent.length}/${lines.length}):\n${formatted.join("\n")}`);
      } catch (err) {
        ctx.addStatus(`Error reading logs: ${(err as Error).message}`);
      }
    },
  },

  // ─── /plan — toggle plan mode ─────────────────────────────────

  {
    name: "/plan",
    description: "Toggle plan mode (read-only exploration, plan output as text)",
    execute: (_arg, ctx) => {
      const { isInPlanMode, setInPlanMode } = require("../../../tool-system/builtin/plan.js");
      const current = isInPlanMode();
      setInPlanMode(!current);
      if (!current) {
        ctx.addStatus(
          "Plan mode ON — the agent can only explore (read-only) and must output its plan as text.\n" +
          "Use /plan again to exit plan mode."
        );
      } else {
        ctx.addStatus("Plan mode OFF — the agent can now write and edit files.");
      }
    },
  },
];

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return String(n);
}
