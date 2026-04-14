/**
 * Prompt composer — assembles system prompt from sections.
 *
 * Following Claude Code's dual-chain architecture:
 *   system chain → API request "system" field
 *   messages chain → API request "messages" field (userContext prepended)
 */

import type { ToolDefinition, Message } from "../types.js";
import { SectionCache, type PromptSection } from "./section-cache.js";
import { scanInstructions, combineInstructions, type ScanOptions } from "./instruction-scanner.js";
import { MemoryManager } from "../session/memory.js";
import { scanSkills, buildSkillListing } from "../skills/index.js";
import { resolveAgentPreset, buildPresetSystemPrompt, type AgentPreset } from "../preset/index.js";

export interface ComposerOptions {
  cwd: string;
  model: string;
  instructionOptions?: ScanOptions;
  /** Resolved preset — used to load section-based prompt. */
  preset?: AgentPreset;
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
}

export class PromptComposer {
  private sectionCache = new SectionCache();
  private cachedInstructions: string | null = null;

  constructor(private readonly options: ComposerOptions) {}

  /**
   * Build the system prompt from sections.
   */
  async buildSystemPrompt(tools: ToolDefinition[]): Promise<string> {
    const sections = this.getSections(tools);
    const resolved = await this.sectionCache.resolve(sections);
    return resolved.join("\n\n");
  }

  /**
   * Build the userContext prefix message (CLAUDE.md content as <system-reminder>).
   */
  buildUserContextMessage(): Message | null {
    const instructions = this.getInstructions();
    const memoryContext = this.getMemoryContext();

    if (!instructions && !memoryContext) return null;

    const currentDate = `Today's date is ${new Date().toISOString().split("T")[0]}.`;

    let content = `<system-reminder>\n${currentDate}\n\n`;
    if (instructions) content += `${instructions}\n\n`;
    if (memoryContext) content += `${memoryContext}\n`;
    content += `</system-reminder>`;

    return { role: "user", content };
  }

  /**
   * Build the systemContext (gitStatus etc.) to append to system prompt.
   * Only injects git status if the resolved preset opts in.
   */
  async buildSystemContext(): Promise<string> {
    const preset = this.options.preset ?? resolveAgentPreset();
    if (!preset.injectGitStatus) return "";

    // gitStatus snapshot
    let gitStatus = "";
    try {
      const { execSync } = await import("node:child_process");
      const branch = execSync("git branch --show-current 2>/dev/null", {
        cwd: this.options.cwd,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      const status = execSync("git status --short 2>/dev/null", {
        cwd: this.options.cwd,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      const log = execSync("git log --oneline -5 2>/dev/null", {
        cwd: this.options.cwd,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      if (branch) {
        gitStatus = `gitStatus: Current branch: ${branch}`;
        if (status) gitStatus += `\n\nStatus:\n${status}`;
        if (log) gitStatus += `\n\nRecent commits:\n${log}`;
      }
    } catch {
      // Not a git repo or git not available
    }

    return gitStatus;
  }

  invalidateCache(sectionName?: string): void {
    this.sectionCache.invalidate(sectionName);
    if (!sectionName) {
      this.cachedInstructions = null;
    }
  }

  private getSections(tools: ToolDefinition[]): PromptSection[] {
    const sections: PromptSection[] = [];

    // Runtime header
    sections.push({
      name: "runtime_header",
      compute: () => {
        const lines = [
          `You are an AI agent powered by ${this.options.model}.`,
          `Working directory: ${this.options.cwd}`,
          `Platform: ${process.platform}`,
          `Shell: ${process.env.SHELL ?? "unknown"}`,
        ];
        return lines.join("\n");
      },
    });

    // Custom system prompt override
    if (this.options.customSystemPrompt) {
      sections.push({
        name: "custom_system",
        compute: () => this.options.customSystemPrompt!,
      });
    }

    // Tool definitions
    if (tools.length > 0) {
      sections.push({
        name: "tool_definitions",
        compute: () => {
          const toolLines = tools.map(
            (t) =>
              `### ${t.name}\n${t.description}\n` +
              `Parameters: ${JSON.stringify(t.inputSchema, null, 2)}`,
          );
          return `# Available Tools\n\n${toolLines.join("\n\n")}`;
        },
      });
    }

    // Behavioral instructions — loaded from preset's section files
    sections.push({
      name: "behavior",
      compute: () => {
        const preset = this.options.preset ?? resolveAgentPreset();
        return buildPresetSystemPrompt(preset);
      },
    });

    // Skills listing
    sections.push({
      name: "skills",
      compute: () => {
        const skills = scanSkills(this.options.cwd);
        return buildSkillListing(skills);
      },
    });

    // Append system prompt
    if (this.options.appendSystemPrompt) {
      sections.push({
        name: "append_system",
        compute: () => this.options.appendSystemPrompt!,
      });
    }

    return sections;
  }

  private getInstructions(): string {
    if (this.cachedInstructions !== null) return this.cachedInstructions;
    const entries = scanInstructions(this.options.cwd, this.options.instructionOptions);
    this.cachedInstructions = combineInstructions(entries);
    return this.cachedInstructions;
  }

  private getMemoryContext(): string {
    try {
      const mm = new MemoryManager(this.options.cwd);
      return mm.buildMemoryContext();
    } catch {
      return "";
    }
  }
}
