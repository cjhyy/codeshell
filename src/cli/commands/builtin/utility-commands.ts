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
    description: "Revert the last file change",
    execute: async (_arg, ctx) => {
      try {
        const { FileHistory } = await import("../../../session/file-history.js");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");

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
        const tracked = history.getTrackedFiles();
        if (tracked.length === 0) {
          ctx.addStatus("No file changes to undo.");
          return;
        }
        // Restore the most recently tracked file
        const lastFile = tracked[tracked.length - 1];
        const restored = history.restoreLatest(lastFile);
        if (restored) {
          ctx.addStatus(`Restored: ${lastFile}`);
        } else {
          ctx.addStatus("No file changes to undo.");
        }
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
    name: "/update",
    description: "Check for and install updates",
    execute: async (_arg, ctx) => {
      try {
        const { getCurrentVersion, getUpdateAvailable, getAutoUpdateDisabledReason } =
          await import("../../updater.js");
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
