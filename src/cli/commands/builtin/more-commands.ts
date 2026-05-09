/**
 * Additional slash commands — /files, /release-notes, /security-review, /feedback
 */

import type { SlashCommand } from "../registry.js";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const moreCommands: SlashCommand[] = [
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

  {
    name: "/release-notes",
    aliases: ["/changelog", "/whatsnew"],
    description: "Show recent changes and release notes",
    execute: (_arg, ctx) => {
      const changelogPaths = [
        join(ctx.cwd, "CHANGELOG.md"),
        join(ctx.cwd, "CHANGES.md"),
        join(ctx.cwd, "HISTORY.md"),
      ];
      for (const p of changelogPaths) {
        if (existsSync(p)) {
          const content = readFileSync(p, "utf-8");
          ctx.addStatus(content.slice(0, 2000) + (content.length > 2000 ? "\n... (truncated)" : ""));
          return;
        }
      }
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

  {
    name: "/security-review",
    aliases: ["/sec"],
    group: "git",
    description: "Run a security review of pending changes",
    execute: async (_arg, ctx) => {
      try {
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
        const prompt = `You are a senior security engineer. Review the pending diff for security issues.

GIT STATUS:
\`\`\`
${status}
\`\`\`

DIFF:
\`\`\`diff
${allDiff.slice(0, 15000)}
\`\`\`

Focus on: SQL/Command injection, auth bypass, hardcoded secrets, XSS, path traversal, unsafe deserialization, crypto issues.
For each finding provide: file:line, severity (HIGH/MEDIUM), description, exploit scenario, fix.
If no issues found, say so clearly.`;

        const result = await ctx.client.run(prompt, ctx.sessionId);
        ctx.setSessionId(result.sessionId);
      } catch (err) {
        ctx.addStatus(`Security review failed: ${(err as Error).message}`);
      }
      ctx.setIsRunning(false);
    },
  },

  {
    name: "/feedback",
    aliases: ["/bug"],
    description: "Report a bug or provide feedback",
    usage: "/feedback [description]",
    execute: (arg, ctx) => {
      const desc = arg.trim();
      if (!desc) {
        ctx.addStatus(
          "Usage: /feedback <description>\n" +
          "Include what you expected, what happened, steps to reproduce.",
        );
        return;
      }
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
        appendFileSync(join(feedbackDir, "feedback.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
        ctx.addStatus("Feedback saved. Thank you!");
      } catch {
        ctx.addStatus(`Feedback noted: "${desc}". Could not save locally.`);
      }
    },
  },
];
