/**
 * Git workflow slash commands — /commit, /diff, /branch, /review, /pr-comments
 */

import type { SlashCommand } from "../registry.js";
import {
  isGitRepo,
  getCurrentBranch,
  getGitStatus,
  getGitDiff,
  getGitDiffStat,
  getGitLog,
  gitAdd,
  gitCommit,
  gitListBranches,
  gitCheckout,
  ghAvailable,
  ghPrComments,
  buildReviewPrompt,
  parseDimensions,
} from "@cjhyy/code-shell-core";

export const gitCommands: SlashCommand[] = [
  {
    name: "/commit",
    group: "git",
    description: "Generate commit message and commit",
    usage: "/commit [-m message]",
    execute: async (arg, ctx) => {
      if (!isGitRepo(ctx.cwd)) {
        ctx.addStatus("Not a git repository.");
        return;
      }

      const status = getGitStatus(ctx.cwd);
      if (status.length === 0) {
        ctx.addStatus("No changes to commit.");
        return;
      }

      // If -m flag provided, commit directly
      if (arg.startsWith("-m ")) {
        const msg = arg.slice(3).trim().replace(/^["']|["']$/g, "");
        if (!msg) {
          ctx.addStatus("Empty commit message.");
          return;
        }
        try {
          gitAdd(ctx.cwd);
          const result = gitCommit(ctx.cwd, msg);
          ctx.addStatus(result);
        } catch (err) {
          ctx.addStatus(`Commit failed: ${(err as Error).message}`);
        }
        return;
      }

      // Otherwise, send diff to model to generate commit message
      if (!ctx.queryGuard.reserve()) {
        ctx.addStatus("Busy — wait for current turn to finish.");
        return;
      }
      const ac = new AbortController();
      ctx.queryGuard.tryStart(ac);
      try {
        const stat = getGitDiffStat(ctx.cwd);
        const diff = getGitDiff(ctx.cwd);
        const log = getGitLog(ctx.cwd, 5);
        const recentMessages = log.map((l) => l.message).join("\n");

        const prompt =
          `Generate a concise git commit message for the following changes.\n\n` +
          `## Recent commit messages (follow this style):\n${recentMessages}\n\n` +
          `## Diff stat:\n${stat}\n\n` +
          `## Diff (first 3000 chars):\n${diff.slice(0, 3000)}\n\n` +
          `Respond with ONLY the commit message, nothing else. ` +
          `Use conventional commit format if the recent messages use it. ` +
          `Keep it under 72 characters for the first line.`;

        const result = await ctx.client.run(prompt, ctx.sessionId);
        ctx.setSessionId(result.sessionId);

        const commitMsg = result.text.trim().replace(/^["'`]+|["'`]+$/g, "");
        if (commitMsg) {
          gitAdd(ctx.cwd);
          const commitResult = gitCommit(ctx.cwd, commitMsg);
          ctx.addStatus(`${commitResult}`);
        }
      } catch (err) {
        ctx.addStatus(`Commit failed: ${(err as Error).message}`);
      } finally {
        ctx.queryGuard.end();
      }
    },
  },

  {
    name: "/branch",
    group: "git",
    description: "List, create, or switch branches",
    usage: "/branch [name] [--create]",
    execute: (_arg, ctx) => {
      if (!isGitRepo(ctx.cwd)) {
        ctx.addStatus("Not a git repository.");
        return;
      }

      const arg = _arg.trim();
      if (!arg) {
        // List branches
        const branches = gitListBranches(ctx.cwd);
        const lines = branches.map((b) => `  ${b.current ? "* " : "  "}${b.name}`);
        ctx.addStatus("Branches:\n" + lines.join("\n"));
        return;
      }

      try {
        const create = arg.includes("--create") || arg.includes("-c");
        const name = arg.replace(/--create|-c/g, "").trim();
        gitCheckout(ctx.cwd, name, create);
        ctx.addStatus(`Switched to branch: ${name}${create ? " (created)" : ""}`);
      } catch (err) {
        ctx.addStatus(`Branch operation failed: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "/review",
    group: "git",
    description: "Structured code review of the git diff (P0-P3 findings)",
    usage: "/review [file] [--json] [--dimensions=security,perf,...] [--staged]",
    execute: async (arg, ctx) => {
      if (!isGitRepo(ctx.cwd)) {
        ctx.addStatus("Not a git repository.");
        return;
      }

      // Parse flags out of the argument string; the remaining bare token (if
      // any) is treated as a file path to scope the diff to.
      const tokens = arg.split(/\s+/).filter(Boolean);
      const json = tokens.includes("--json");
      const staged = tokens.includes("--staged");
      const dimFlag = tokens.find((t) => t.startsWith("--dimensions="));
      const dimensions = parseDimensions(dimFlag?.split("=")[1]);
      const file = tokens.find((t) => !t.startsWith("--"));

      if (!ctx.queryGuard.reserve()) {
        ctx.addStatus("Busy — wait for current turn to finish.");
        return;
      }
      const ac = new AbortController();
      ctx.queryGuard.tryStart(ac);
      try {
        const diff = getGitDiff(ctx.cwd, {
          ...(file ? { file } : {}),
          ...(staged ? { staged: true } : {}),
        });

        if (!diff) {
          ctx.addStatus(
            staged ? "No staged changes to review." : "No changes to review.",
          );
          return;
        }

        const prompt = buildReviewPrompt({
          content: diff,
          dimensions,
          incremental: true,
          json,
          label: file,
        });

        const result = await ctx.client.run(prompt, ctx.sessionId);
        ctx.setSessionId(result.sessionId);
      } catch (err) {
        ctx.addStatus(`Review failed: ${(err as Error).message}`);
      } finally {
        ctx.queryGuard.end();
      }
    },
  },

  {
    name: "/pr-comments",
    group: "git",
    description: "Fetch PR comments via gh CLI",
    usage: "/pr-comments <PR-url|number>",
    execute: (_arg, ctx) => {
      if (!ghAvailable()) {
        ctx.addStatus("gh CLI is not installed. Install it from https://cli.github.com/");
        return;
      }
      if (!_arg) {
        ctx.addStatus("Usage: /pr-comments <PR-url|number>");
        return;
      }
      try {
        const comments = ghPrComments(ctx.cwd, _arg.trim());
        if (!comments) {
          ctx.addStatus("No comments found.");
        } else {
          ctx.addStatus(comments.slice(0, 5000));
        }
      } catch (err) {
        ctx.addStatus(`Failed to fetch PR comments: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "/autofix-pr",
    group: "git",
    description: "Auto-fix based on PR review comments",
    usage: "/autofix-pr <PR-url|number>",
    execute: async (arg, ctx) => {
      if (!ghAvailable()) {
        ctx.addStatus("gh CLI is not installed.");
        return;
      }
      if (!arg) {
        ctx.addStatus("Usage: /autofix-pr <PR-url|number>");
        return;
      }

      if (!ctx.queryGuard.reserve()) {
        ctx.addStatus("Busy — wait for current turn to finish.");
        return;
      }
      const ac = new AbortController();
      ctx.queryGuard.tryStart(ac);
      try {
        const comments = ghPrComments(ctx.cwd, arg.trim());
        if (!comments) {
          ctx.addStatus("No review comments found.");
          return;
        }

        const prompt =
          `The following are review comments on a PR. ` +
          `Please read each comment, find the relevant code, and fix the issues mentioned.\n\n` +
          `## Review Comments:\n${comments.slice(0, 5000)}\n\n` +
          `Fix all the issues in the codebase. Use the Edit and Read tools.`;

        const result = await ctx.client.run(prompt, ctx.sessionId);
        ctx.setSessionId(result.sessionId);
      } catch (err) {
        ctx.addStatus(`Autofix failed: ${(err as Error).message}`);
      } finally {
        ctx.queryGuard.end();
      }
    },
  },
];
