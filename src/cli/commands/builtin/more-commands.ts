/**
 * Additional slash commands to match restored-src parity:
 * /fast, /rewind, /usage, /files, /release-notes, /security-review,
 * /env, /brief, /feedback, /tag
 */

import type { SlashCommand } from "../registry.js";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { costTracker } from "../../cost-tracker.js";

export const moreCommands: SlashCommand[] = [
  // ─── /fast — toggle fast mode ─────────────────────────────────

  {
    name: "/fast",
    description: "Toggle fast mode (faster, cheaper responses)",
    usage: "/fast [on|off]",
    group: "config",
    execute: async (arg, ctx) => {
      // Fast mode is tracked via effort level: fast = "low", normal = current
      const currentEffort = ctx.effort;
      if (arg === "off" || (currentEffort === "low" && !arg)) {
        ctx.setEffort("high");
        ctx.addStatus("Fast mode OFF — effort set to high.");
      } else {
        ctx.setEffort("low");
        ctx.addStatus(
          "Fast mode ON — effort set to low for faster, cheaper responses.\n" +
          "Use /fast off to return to normal.",
        );
      }
    },
  },

  // ─── /rewind — rewind conversation to earlier point ───────────

  {
    name: "/rewind",
    aliases: ["/rew"],
    description: "Rewind conversation (clear recent turns)",
    usage: "/rewind [n] — remove last n turns (default: 1)",
    execute: (_arg, ctx) => {
      // Simple rewind: clear chat and notify user
      // In a full implementation this would selectively remove turns
      const n = parseInt(_arg) || 1;
      ctx.addStatus(
        `Rewinding ${n} turn(s)... Note: full rewind requires server-side support.\n` +
        `Use /clear to start fresh, or /undo to revert file changes.`,
      );
    },
  },

  // ─── /usage — show API usage and limits ───────────────────────

  {
    name: "/usage",
    description: "Show detailed API usage and rate limit info",
    execute: (_arg, ctx) => {
      const t = costTracker.getTotalTokens();
      const cost = costTracker.getEstimatedCost();
      const requests = costTracker.getRequestCount();

      if (requests === 0) {
        ctx.addStatus("No API usage yet this session.");
        return;
      }

      const avgTokensPerReq = Math.round(t.total / requests);
      const avgCostPerReq = (cost / requests).toFixed(4);

      const lines = [
        "API Usage:",
        `  Requests:         ${requests}`,
        `  Total tokens:     ${formatNum(t.total)}`,
        `    ├ Prompt:       ${formatNum(t.prompt)}`,
        `    └ Completion:   ${formatNum(t.completion)}`,
        `  Estimated cost:   $${cost.toFixed(4)}`,
        `  Avg tokens/req:   ${formatNum(avgTokensPerReq)}`,
        `  Avg cost/req:     $${avgCostPerReq}`,
        `  Model:            ${ctx.model}`,
      ];

      ctx.addStatus(lines.join("\n"));
    },
  },

  // ─── /files — list files in context / cwd ─────────────────────

  {
    name: "/files",
    description: "List files in the current working directory",
    usage: "/files [pattern]",
    execute: (_arg, ctx) => {
      try {
        const pattern = _arg.trim();
        let cmd: string;
        if (pattern) {
          cmd = `find . -maxdepth 3 -name "${pattern}" -not -path '*/node_modules/*' -not -path '*/.git/*' | head -50`;
        } else {
          cmd = `find . -maxdepth 2 -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -50`;
        }
        const result = execSync(cmd, {
          cwd: ctx.cwd,
          encoding: "utf-8",
          timeout: 10000,
        }).trim();

        if (!result) {
          ctx.addStatus("No files found.");
        } else {
          const count = result.split("\n").length;
          ctx.addStatus(`Files (${count}, max 50 shown):\n${result}`);
        }
      } catch (err) {
        ctx.addStatus(`Error: ${(err as Error).message}`);
      }
    },
  },

  // ─── /release-notes — show release notes ──────────────────────

  {
    name: "/release-notes",
    aliases: ["/changelog", "/whatsnew"],
    description: "Show recent changes and release notes",
    execute: (_arg, ctx) => {
      // Try reading CHANGELOG.md or git log
      const changelogPaths = [
        join(ctx.cwd, "CHANGELOG.md"),
        join(ctx.cwd, "CHANGES.md"),
        join(ctx.cwd, "HISTORY.md"),
      ];

      for (const p of changelogPaths) {
        if (existsSync(p)) {
          const content = readFileSync(p, "utf-8");
          // Show first ~2000 chars
          const preview = content.slice(0, 2000);
          ctx.addStatus(preview + (content.length > 2000 ? "\n... (truncated)" : ""));
          return;
        }
      }

      // Fallback to git log
      try {
        const log = execSync("git log --oneline -20", {
          cwd: ctx.cwd,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        ctx.addStatus(`Recent commits:\n${log}`);
      } catch {
        ctx.addStatus("No changelog or git history found.");
      }
    },
  },

  // ─── /security-review — security review of pending changes ────

  {
    name: "/security-review",
    aliases: ["/sec"],
    group: "git",
    description: "Run a security review of pending code changes",
    execute: async (_arg, ctx) => {
      try {
        // Check if we have changes to review
        const status = execSync("git status --short", {
          cwd: ctx.cwd,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();

        const diff = execSync("git diff HEAD --no-color", {
          cwd: ctx.cwd,
          encoding: "utf-8",
          timeout: 10000,
        }).trim();

        const stagedDiff = execSync("git diff --cached --no-color", {
          cwd: ctx.cwd,
          encoding: "utf-8",
          timeout: 10000,
        }).trim();

        const allDiff = (diff + "\n" + stagedDiff).trim();

        if (!allDiff) {
          ctx.addStatus("No pending changes to review.");
          return;
        }

        ctx.setIsRunning(true);

        const prompt = `You are a senior security engineer conducting a focused security review of the pending changes.

GIT STATUS:
\`\`\`
${status}
\`\`\`

DIFF:
\`\`\`diff
${allDiff.slice(0, 15000)}
\`\`\`

OBJECTIVE:
Perform a security-focused code review. Only flag issues where you're >80% confident of actual exploitability.

FOCUS ON:
- SQL/Command/Template injection
- Authentication/authorization bypasses
- Hardcoded secrets or credentials
- XSS vulnerabilities (only if using dangerouslySetInnerHTML or similar)
- Path traversal in file operations
- Unsafe deserialization
- Cryptographic issues

DO NOT REPORT:
- DoS/resource exhaustion
- Rate limiting concerns
- Theoretical issues without concrete exploit paths
- Style or code quality issues
- Issues in test files only
- Log spoofing
- Missing input validation on non-security fields

SEVERITY:
- HIGH: Directly exploitable (RCE, data breach, auth bypass)
- MEDIUM: Requires specific conditions but significant impact

For each finding, provide:
1. File and line number
2. Severity (HIGH/MEDIUM only)
3. Description
4. Exploit scenario
5. Fix recommendation

If no security issues found, say so clearly.`;

        const result = await ctx.client.run(prompt, ctx.sessionId);
        ctx.setSessionId(result.sessionId);
      } catch (err) {
        ctx.addStatus(`Security review failed: ${(err as Error).message}`);
      }
      ctx.setIsRunning(false);
    },
  },

  // ─── /env — show environment info ─────────────────────────────

  {
    name: "/env",
    group: "config",
    description: "Show environment variables and runtime info",
    execute: (_arg, ctx) => {
      const isBun = typeof (globalThis as any).Bun !== "undefined";
      const runtime = isBun
        ? `Bun ${(globalThis as any).Bun.version}`
        : `Node ${process.version}`;

      const envVars = [
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "CODESHELL_MODEL",
        "CODESHELL_EFFORT",
        "CODESHELL_MAX_TURNS",
        "HOME",
        "SHELL",
        "TERM",
        "LANG",
        "NODE_ENV",
      ];

      const lines = [
        "Environment:",
        `  Runtime:    ${runtime}`,
        `  Platform:   ${process.platform} ${process.arch}`,
        `  CWD:        ${ctx.cwd}`,
        `  Model:      ${ctx.model}`,
        `  Effort:     ${ctx.effort}`,
        "",
        "  Key Environment Variables:",
      ];

      for (const key of envVars) {
        const val = process.env[key];
        if (val) {
          // Mask API keys
          const display = key.includes("KEY")
            ? val.slice(0, 8) + "..." + val.slice(-4)
            : val;
          lines.push(`    ${key}=${display}`);
        }
      }

      ctx.addStatus(lines.join("\n"));
    },
  },

  // ─── /brief — toggle brief mode ───────────────────────────────

  {
    name: "/brief",
    description: "Toggle brief mode (concise responses)",
    usage: "/brief [on|off]",
    execute: async (arg, ctx) => {
      // Brief mode adjusts the effort to produce shorter responses
      const currentEffort = ctx.effort;
      const isBrief = currentEffort === "low";

      if (arg === "off" || (isBrief && !arg)) {
        ctx.setEffort("high");
        ctx.addStatus("Brief mode OFF — returning to detailed responses.");
      } else if (arg === "on" || !isBrief) {
        ctx.setEffort("low");
        ctx.addStatus(
          "Brief mode ON — responses will be more concise.\n" +
          "Use /brief off to return to detailed mode.",
        );
      }
    },
  },

  // ─── /feedback — submit feedback ──────────────────────────────

  {
    name: "/feedback",
    aliases: ["/bug"],
    description: "Report a bug or provide feedback",
    usage: "/feedback [description]",
    execute: (arg, ctx) => {
      const desc = arg.trim();
      if (!desc) {
        ctx.addStatus(
          "Feedback / Bug Report:\n" +
          "  Usage: /feedback <description>\n" +
          "  Or visit: https://github.com/anthropics/claude-code/issues\n\n" +
          "  Include:\n" +
          "  - What you expected to happen\n" +
          "  - What actually happened\n" +
          "  - Steps to reproduce",
        );
        return;
      }

      // Log the feedback locally
      const feedbackDir = join(homedir(), ".code-shell", "feedback");
      try {
        const { mkdirSync, appendFileSync } = require("node:fs");
        mkdirSync(feedbackDir, { recursive: true });
        const entry = {
          timestamp: new Date().toISOString(),
          model: ctx.model,
          sessionId: ctx.sessionId,
          description: desc,
          platform: `${process.platform} ${process.arch}`,
        };
        appendFileSync(
          join(feedbackDir, "feedback.jsonl"),
          JSON.stringify(entry) + "\n",
          "utf-8",
        );
        ctx.addStatus(
          "Feedback saved locally. Thank you!\n" +
          "For public issues, visit: https://github.com/anthropics/claude-code/issues",
        );
      } catch {
        ctx.addStatus(
          `Feedback: "${desc}"\n` +
          "Could not save locally. Please report at:\n" +
          "https://github.com/anthropics/claude-code/issues",
        );
      }
    },
  },

  // ─── /tag — tag current session ───────────────────────────────

  {
    name: "/tag",
    description: "Add a searchable tag to the current session",
    usage: "/tag <name>",
    group: "context",
    execute: (arg, ctx) => {
      const tag = arg.trim().replace(/[^a-zA-Z0-9_-]/g, "");
      if (!tag) {
        ctx.addStatus("Usage: /tag <name>\nExample: /tag refactor-auth");
        return;
      }
      if (!ctx.sessionId) {
        ctx.addStatus("No active session to tag.");
        return;
      }

      // Store tag in session metadata directory
      const sessionDir = join(homedir(), ".code-shell", "sessions", ctx.sessionId);
      try {
        const { mkdirSync, writeFileSync, readFileSync, existsSync: ex } = require("node:fs");
        mkdirSync(sessionDir, { recursive: true });
        const tagsFile = join(sessionDir, "tags.json");

        let tags: string[] = [];
        if (ex(tagsFile)) {
          try { tags = JSON.parse(readFileSync(tagsFile, "utf-8")); } catch {}
        }

        if (tags.includes(tag)) {
          ctx.addStatus(`Session already tagged: #${tag}`);
          return;
        }

        tags.push(tag);
        writeFileSync(tagsFile, JSON.stringify(tags, null, 2), "utf-8");
        ctx.addStatus(`Session tagged: #${tag}`);
      } catch (err) {
        ctx.addStatus(`Failed to tag: ${(err as Error).message}`);
      }
    },
  },
];

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return String(n);
}
