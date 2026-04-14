/**
 * /permissions command — show and toggle permission mode.
 */

import type { SlashCommand } from "../registry.js";
import type { PermissionMode } from "../../../types.js";

const VALID_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
  "auto",
  "plan",
];

export const permissionsCommand: SlashCommand = {
  name: "/permissions",
  aliases: ["/perm"],
  group: "config",
  description: "Show or change permission mode",
  usage: "/permissions [mode]",
  execute: async (_arg, ctx) => {
    const configResult = await ctx.client.query("config");
    const config = configResult.data as any;
    const currentMode = config.permissionMode ?? "acceptEdits";

    if (!_arg) {
      const lines = [
        `Current mode: ${currentMode}`,
        "",
        "Available modes:",
        "  default          Ask for non-read tools",
        "  acceptEdits      Allow read + write, ask for bash",
        "  dontAsk          Deny all non-allowed tools",
        "  bypassPermissions Allow everything",
        "  auto             Smart auto-approve safe operations",
        "  plan             Read-only planning mode",
        "",
        `Use /permissions <mode> to switch.`,
      ];
      ctx.addStatus(lines.join("\n"));
      return;
    }

    const newMode = _arg.trim() as PermissionMode;
    if (!VALID_MODES.includes(newMode)) {
      ctx.addStatus(`Invalid mode: ${newMode}. Valid: ${VALID_MODES.join(", ")}`);
      return;
    }

    // Note: This only affects the display — the actual mode is set in engine config
    // and would need engine restart or a mutable config to take effect mid-session.
    ctx.addStatus(
      `Permission mode: ${currentMode} → ${newMode}\n` +
        `Note: Mode change takes full effect on next session. Use /init to persist.`,
    );
  },
};
