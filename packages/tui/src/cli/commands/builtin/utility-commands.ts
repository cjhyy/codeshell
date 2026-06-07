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
    description: "撤销最近一次文件修改(先预览,/undo confirm 执行)",
    usage: "/undo [confirm]",
    execute: async (arg, ctx) => {
      try {
        const { FileHistory, latestUndoTarget, renderDiffPreview } = await import(
          "@cjhyy/code-shell-core"
        );
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
        // The most recent modification across ALL files (by snapshot timestamp),
        // not "last tracked path" — that's the single step /undo reverts to.
        const target = latestUndoTarget(history.getAllSnapshots());
        if (!target) {
          ctx.addStatus("没有可撤销的文件修改。");
          return;
        }

        // Snapshot backup = the file's content BEFORE the last edit (what we'd
        // restore). Current disk content = what we'd overwrite.
        const backupContent = existsSync(target.backupPath)
          ? readFileSync(target.backupPath, "utf-8")
          : null;
        if (backupContent === null) {
          ctx.addStatus(`撤销失败:备份已丢失 (${target.backupPath})`);
          return;
        }
        const currentContent = existsSync(target.filePath)
          ? readFileSync(target.filePath, "utf-8")
          : "";

        const confirm = (arg ?? "").trim().toLowerCase() === "confirm";
        if (!confirm) {
          // Preview only. Diff is current→backup, i.e. "what undo will change".
          const preview = renderDiffPreview(currentContent, backupContent);
          const body =
            `**/undo 预览** — 将把以下文件还原到上次编辑前:\n\n` +
            `\`${target.filePath}\`\n\n` +
            (preview
              ? "```diff\n" + preview + "\n```\n"
              : "_(磁盘内容与备份一致,撤销无变化)_\n") +
            `\n运行 \`/undo confirm\` 执行撤销。`;
          ctx.addMessage(body);
          return;
        }

        const restored = history.restoreLatest(target.filePath);
        ctx.addStatus(restored ? `已撤销:${target.filePath}` : "撤销失败。");
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
