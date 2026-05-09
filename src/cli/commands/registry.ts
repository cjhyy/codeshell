/**
 * Slash command registry — replaces the monolithic switch-case in App.tsx.
 *
 * Commands are registered with a name, aliases, and an execute function.
 * The registry handles parsing, dispatch, and help generation.
 */

import type { AgentClient } from "../../protocol/client.js";
import type { TaskInfo } from "../../types.js";

/** A reconstructed chat entry for loading into the UI. */
export interface RestoredChatEntry {
  type: "user" | "assistant_text" | "tool_start" | "tool_result" | "status";
  text?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  error?: string;
}

/** Context passed to every slash command handler. */
export interface CommandContext {
  client: AgentClient;
  cwd: string;
  model: string;
  setModel: (model: string) => void;
  sessionId: string | undefined;
  setSessionId: (id: string) => void;
  setIsRunning: (running: boolean) => void;
  addStatus: (msg: string) => void;
  /** Add a message that renders with full markdown formatting (like assistant output). */
  addMessage: (text: string) => void;
  /** Set context that will be prepended to the next user message sent to the engine. */
  setNextContext: (text: string) => void;
  exit: () => void;
  // State accessors
  effort: string;
  setEffort: (e: string) => void;
  tasks: TaskInfo[];
  clearChat: () => void;
  chatLog: unknown[];
  /** Load restored chat entries into the UI (used by /resume). */
  loadChatEntries?: (entries: RestoredChatEntry[]) => void;
  /** Open the Ink onboarding wizard (used by /login). */
  startOnboarding?: () => void;
  /** Open the Ink model selector (used by /model with no args). */
  openModelSelector?: () => void;
  /** Open the Ink session picker (used by /resume with no args). */
  openSessionPicker?: () => void;
}

export type CommandGroup = "core" | "git" | "context" | "config" | "advanced";

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  group?: CommandGroup;
  execute: (arg: string, ctx: CommandContext) => void | Promise<void>;
}

export class CommandRegistry {
  private commands = new Map<string, SlashCommand>();

  register(cmd: SlashCommand): void {
    this.commands.set(cmd.name, cmd);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        this.commands.set(alias, cmd);
      }
    }
  }

  registerAll(cmds: SlashCommand[]): void {
    for (const cmd of cmds) this.register(cmd);
  }

  get(name: string): SlashCommand | undefined {
    return this.commands.get(name);
  }

  dispatch(input: string, ctx: CommandContext): void | Promise<void> {
    const parts = input.split(/\s+/);
    const name = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ").trim();
    const cmd = this.commands.get(name);
    if (!cmd) {
      ctx.addStatus(`Unknown command: ${name}. Type /help for available commands.`);
      return;
    }
    return cmd.execute(arg, ctx);
  }

  /** Generate grouped help text from all registered commands. */
  helpText(): string {
    const seen = new Set<string>();
    const groups = new Map<string, SlashCommand[]>();

    const groupLabels: Record<string, string> = {
      core: "Core",
      git: "Git & Code Review",
      context: "Context & Memory",
      config: "Configuration",
      advanced: "Advanced",
    };

    for (const cmd of this.commands.values()) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      const g = cmd.group ?? "core";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(cmd);
    }

    const lines: string[] = [
      "Available Commands:",
      "",
    ];

    for (const [groupKey, label] of Object.entries(groupLabels)) {
      const cmds = groups.get(groupKey);
      if (!cmds || cmds.length === 0) continue;
      lines.push(`  ${label}:`);
      for (const cmd of cmds.sort((a, b) => a.name.localeCompare(b.name))) {
        const aliases = cmd.aliases?.length ? ` (${cmd.aliases.join(", ")})` : "";
        lines.push(`    ${cmd.name.padEnd(16)} ${cmd.description}${aliases}`);
      }
      lines.push("");
    }

    lines.push("  Shift+Tab to cycle permission mode · Ctrl+C to cancel/exit");

    return lines.join("\n");
  }

  listNames(): string[] {
    const seen = new Set<string>();
    for (const cmd of this.commands.values()) seen.add(cmd.name);
    return [...seen].sort();
  }

  /** Return deduplicated list of { name, description } sorted by name. */
  listCommands(): Array<{ name: string; description: string }> {
    const seen = new Set<string>();
    const result: Array<{ name: string; description: string }> = [];
    for (const cmd of this.commands.values()) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      result.push({ name: cmd.name, description: cmd.description });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
}
