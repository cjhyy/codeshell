/**
 * Utility slash commands — /copy, /undo, /theme, /hooks, /update
 */

import type { SlashCommand } from "../registry.js";
import { execSync } from "node:child_process";

export const utilityCommands: SlashCommand[] = [
  {
    name: "/copy",
    description: "Copy last assistant response to clipboard",
    execute: (_arg, ctx) => {
      // Find last assistant text in chat log
      const lastAssistant = [...ctx.chatLog]
        .reverse()
        .find((e: any) => e.type === "assistant_text") as any;

      if (!lastAssistant?.text) {
        ctx.addStatus("No assistant response to copy.");
        return;
      }

      try {
        const platform = process.platform;
        let cmd: string;
        if (platform === "darwin") {
          cmd = "pbcopy";
        } else if (platform === "win32") {
          cmd = "clip";
        } else {
          cmd = "xclip -selection clipboard";
        }
        execSync(cmd, { input: lastAssistant.text, timeout: 5000 });
        ctx.addStatus("Copied to clipboard.");
      } catch {
        ctx.addStatus("Failed to copy to clipboard. Command not available.");
      }
    },
  },

  {
    name: "/undo",
    description: "撤销文件修改:/undo 最近一轮对话的改动,/undo all 整会话(先预览,加 confirm 执行)",
    usage: "/undo [all] [confirm]",
    execute: async (arg, ctx) => {
      try {
        const {
          FileHistory,
          latestTurnUndoTargets,
          earliestSnapshotsPerFile,
          renderDiffPreview,
        } = await import("@cjhyy/code-shell-core");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        const { readFileSync, existsSync } = await import("node:fs");

        if (!ctx.sessionId) {
          ctx.addStatus("No active session.");
          return;
        }

        const configResult = await ctx.client.query("config");
        const config = configResult.data as any;
        const sessionDir = join(
          config.sessionStorageDir ?? join(homedir(), ".code-shell", "sessions"),
          ctx.sessionId,
        );
        const history = FileHistory.loadFromDir(sessionDir);

        // Parse "[all] [confirm]" in any order.
        const tokens = (arg ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
        const isAll = tokens.includes("all");
        const confirm = tokens.includes("confirm");

        const readFile = (p: string): string =>
          existsSync(p) ? readFileSync(p, "utf-8") : "";

        if (isAll) {
          // Whole session: each tracked file → its EARLIEST snapshot (content
          // before the first AI edit this session).
          const targets = earliestSnapshotsPerFile(history.getAllSnapshots());
          if (targets.length === 0) {
            ctx.addStatus("没有可撤销的文件修改。");
            return;
          }
          if (!confirm) {
            const MAX_PREVIEW = 5;
            const shown = targets.slice(0, MAX_PREVIEW);
            const blocks = shown.map((t) => {
              const backup = existsSync(t.backupPath) ? readFileSync(t.backupPath, "utf-8") : "";
              const diff = renderDiffPreview(readFile(t.filePath), backup);
              return `\`${t.filePath}\`\n` + (diff ? "```diff\n" + diff + "\n```" : "_(无变化)_");
            });
            const more =
              targets.length > MAX_PREVIEW
                ? `\n\n…以及另外 ${targets.length - MAX_PREVIEW} 个文件。`
                : "";
            ctx.addMessage(
              `**/undo all 预览** — 将把 ${targets.length} 个文件还原到本会话首次编辑前:\n\n` +
                blocks.join("\n\n") +
                more +
                `\n\n运行 \`/undo all confirm\` 执行。`,
            );
            return;
          }
          const results = history.restoreAllToEarliest();
          const failed = results.filter((r) => !r.ok);
          ctx.addStatus(
            failed.length === 0
              ? `已撤销全部 ${results.length} 个文件的本会话修改。`
              : `部分失败:${failed.length}/${results.length}(首个:${failed[0]!.filePath})`,
          );
          return;
        }

        // Turn-level: revert every file the MOST RECENT conversation turn (one
        // user message = one turn) changed, each back to its pre-turn state.
        // Edits from earlier turns stay intact. Files re-edited within the turn
        // still revert to the turn-start baseline (latestTurnUndoTargets picks
        // the earliest snapshot of the latest turn per file).
        const targets = latestTurnUndoTargets(history.getAllSnapshots());
        if (targets.length === 0) {
          ctx.addStatus("没有可撤销的文件修改。");
          return;
        }
        if (!confirm) {
          const MAX_PREVIEW = 5;
          const shown = targets.slice(0, MAX_PREVIEW);
          const blocks = shown.map((t) => {
            const backup = existsSync(t.backupPath) ? readFileSync(t.backupPath, "utf-8") : "";
            const diff = renderDiffPreview(readFile(t.filePath), backup);
            return `\`${t.filePath}\`\n` + (diff ? "```diff\n" + diff + "\n```" : "_(无变化)_");
          });
          const more =
            targets.length > MAX_PREVIEW
              ? `\n\n…以及另外 ${targets.length - MAX_PREVIEW} 个文件。`
              : "";
          const fileWord = targets.length > 1 ? `${targets.length} 个文件` : "1 个文件";
          ctx.addMessage(
            `**/undo 预览** — 将把最近一轮对话改动的 ${fileWord}还原到该轮编辑前:\n\n` +
              blocks.join("\n\n") +
              more +
              `\n\n运行 \`/undo confirm\` 执行;\`/undo all\` 撤销整个会话。`,
          );
          return;
        }
        const results = history.undoLatestTurn(targets);
        const failed = results.filter((r) => !r.ok);
        ctx.addStatus(
          failed.length === 0
            ? `已撤销最近一轮的 ${results.length} 个文件改动。`
            : `部分失败:${failed.length}/${results.length}(首个:${failed[0]!.filePath})`,
        );
      } catch (err) {
        ctx.addStatus(`Undo failed: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "/hooks",
    description: "List registered hooks",
    execute: (_arg, ctx) => {
      // Hook listing requires server-side query support (not yet implemented)
      ctx.addStatus("Hook listing is not yet available via the client protocol.");
    },
  },

  {
    name: "/fullscreen",
    description: "Toggle fullscreen UI mode (alt-screen + ScrollBox) vs flow mode (native terminal scrollback)",
    usage: "/fullscreen [on|off|toggle]",
    execute: (arg, ctx) => {
      if (ctx.fullscreen === undefined || !ctx.setFullscreen) {
        ctx.addStatus("Fullscreen toggle is not wired in this build.");
        return;
      }
      const a = (arg ?? "").trim().toLowerCase();
      let next: boolean;
      if (a === "on" || a === "1" || a === "true") next = true;
      else if (a === "off" || a === "0" || a === "false") next = false;
      else if (a === "" || a === "toggle") next = !ctx.fullscreen;
      else {
        ctx.addStatus(`/fullscreen: unknown arg "${arg}". Use on | off | toggle.`);
        return;
      }
      if (next === ctx.fullscreen) {
        ctx.addStatus(`Fullscreen is already ${next ? "on" : "off"}.`);
        return;
      }
      ctx.setFullscreen(next);
      // Don't addStatus the new mode — the React re-render is what users
      // see. A status line would just add noise to the scrollback.
    },
  },

  {
    name: "/update",
    description: "Check for and install updates",
    execute: async (_arg, ctx) => {
      try {
        const { getCurrentVersion, getUpdateAvailable, getAutoUpdateDisabledReason } =
          await import("@cjhyy/code-shell-core");
        const current = getCurrentVersion();
        const info = getUpdateAvailable();
        const disabledReason = getAutoUpdateDisabledReason();

        if (!info) {
          const tail = disabledReason ? `\nAuto-update is off: ${disabledReason}` : "";
          ctx.addStatus(`code-shell v${current} is up to date.${tail}`);
          return;
        }

        const head = `Update available: ${current} → ${info.latestVersion}`;
        if (info.canAutoInstall) {
          ctx.addStatus(
            `${head}\nWill install on exit. (Or run now: npm install -g @cjhyy/code-shell@${info.latestVersion})`,
          );
        } else {
          ctx.addStatus(`${head}\nRun: sudo npm install -g @cjhyy/code-shell@${info.latestVersion}`);
        }
      } catch (err) {
        ctx.addStatus(`Update check failed: ${(err as Error).message}`);
      }
    },
  },
];
