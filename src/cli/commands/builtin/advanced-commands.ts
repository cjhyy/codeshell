/**
 * Advanced / reserved slash commands
 */

import type { SlashCommand } from "../registry.js";

export const advancedCommands: SlashCommand[] = [
  {
    name: "/voice",
    description: "Toggle voice input mode (reserved)",
    execute: (_arg, ctx) => {
      ctx.addStatus(
        "Voice input is not yet implemented. When available, this will toggle speech-to-text input.",
      );
    },
  },
];
