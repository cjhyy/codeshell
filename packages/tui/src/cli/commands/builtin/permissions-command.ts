/**
 * /permissions command — show and toggle permission mode.
 */

import type { SlashCommand } from "../registry.js";
import type { PermissionMode } from "@cjhyy/code-shell-core";

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
  description: "Show or change permission mode; list active rules",
  usage: "/permissions [mode|rules]",
  execute: async (_arg, ctx) => {
    const configResult = await ctx.client.query("config");
    const config = configResult.data as any;
    const currentMode = config.permissionMode ?? "acceptEdits";

    const arg = _arg.trim();

    // `/permissions rules` — list the effective permission rules (TODO 5.1).
    if (arg === "rules") {
      const rules = (config.permissionRules ?? []) as Array<{
        tool: string;
        decision: string;
        argsPattern?: Record<string, string>;
        reason?: string;
      }>;
      if (rules.length === 0) {
        ctx.addStatus("No permission rules in effect (mode-based decisions only).");
        return;
      }
      const lines = [`Active permission rules (${rules.length}), in match order:`, ""];
      for (const r of rules) {
        const pat = r.argsPattern
          ? " " + Object.entries(r.argsPattern).map(([k, v]) => `${k}~/${v}/`).join(" ")
          : "";
        lines.push(`  [${r.decision}] ${r.tool}${pat}${r.reason ? `  — ${r.reason}` : ""}`);
      }
      ctx.addStatus(lines.join("\n"));
      return;
    }

    if (!arg) {
      const ruleCount = (config.permissionRules ?? []).length;
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
        `Use /permissions <mode> to switch, or /permissions rules to list ${ruleCount} active rule(s).`,
      ];
      ctx.addStatus(lines.join("\n"));
      return;
    }

    const newMode = arg as PermissionMode;
    if (!VALID_MODES.includes(newMode)) {
      ctx.addStatus(`Invalid mode: ${newMode}. Valid: ${VALID_MODES.join(", ")}`);
      return;
    }

    try {
      await ctx.client.query("permission_set", newMode);
      ctx.addStatus(`Permission mode: ${currentMode} → ${newMode} (live)`);
    } catch (err) {
      ctx.addStatus(`Failed to switch mode: ${(err as Error).message}`);
    }
  },
};
