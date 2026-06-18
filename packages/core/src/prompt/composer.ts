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
import { scanSkills } from "../skills/index.js";
import { buildSkillListing } from "../tool-system/builtin/skill-prompt.js";
import { resolveAgentPreset, buildPresetSystemPrompt, type AgentPreset } from "../preset/index.js";

export interface ComposerOptions {
  cwd: string;
  model: string;
  instructionOptions?: ScanOptions;
  /** Resolved preset — used to load section-based prompt. */
  preset?: AgentPreset;
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  /** User's preferred response language (free text), injected as a stable system section. */
  responseLanguage?: string;
  /** How to address the user / short profile (free text). */
  userProfile?: string;
  /**
   * Skill names (full names including any "<plugin>:" prefix) the user
   * has disabled in settings. Filtered out of the LLM's skills listing
   * so the prompt matches what the skill builtin tool will actually
   * dispatch — see scanSkills(opts.disabledSkills) and skillTool.
   */
  disabledSkills?: string[];
  /**
   * Plugin names the user has totally disabled. Coarser knob than
   * disabledSkills — every skill whose namespaced name starts with
   * `${pluginName}:` is filtered. See scanSkills(opts.disabledPlugins).
   */
  disabledPlugins?: string[];
  /**
   * Sub-agent skill allowlist (hard isolation). When set, only these skills
   * appear in the LLM's skills listing — applied on top of the disabled
   * lists. Undefined → the full (non-disabled) pool. Mirrors
   * scanSkills(opts.skillAllowlist) so the prompt matches the Skill tool's
   * dispatch gate.
   */
  skillAllowlist?: string[];
  /**
   * settings.memories.maxAge (days). When > 0, memories whose file mtime is
   * older than this are dropped from the injected memory context (TODO 8.1).
   * Undefined/0 → inject all.
   */
  memoriesMaxAgeDays?: number;
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

    // Local date, not UTC — toISOString() is UTC and would show the wrong
    // "today" for users whose timezone has crossed midnight (review-2026-05-30).
    const now = new Date();
    const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const currentDate = `Today's date is ${ymd}.`;

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

    // Tool listing — name + one-line description only. The full JSON schema
    // is NOT repeated here: the provider clients already send it in the
    // native `tools` field (Anthropic tools / OpenAI functions), so dumping
    // `Parameters: {...}` into the system prompt sent every tool's schema
    // twice — a large, per-request token cost for no added model signal.
    if (tools.length > 0) {
      sections.push({
        name: "tool_definitions",
        compute: () => {
          const toolLines = tools.map(
            (t) => `### ${t.name}\n${t.description}`,
          );
          return `# Available Tools\n\n${toolLines.join("\n\n")}`;
        },
      });
    }

    // Behavioral instructions — loaded from preset's section files. Pass the
    // turn's effective tool names so tool-gated sections (e.g. "browser") drop
    // when their tools are disabled: browser capability = tools + instructions
    // as one on/off unit.
    const activeToolNames = tools.map((t) => t.name);
    sections.push({
      name: "behavior",
      compute: () => {
        const preset = this.options.preset ?? resolveAgentPreset();
        return buildPresetSystemPrompt(preset, activeToolNames);
      },
    });

    // Skills listing
    sections.push({
      name: "skills",
      compute: () => {
        const skills = scanSkills(this.options.cwd, {
          disabledSkills: this.options.disabledSkills,
          disabledPlugins: this.options.disabledPlugins,
          skillAllowlist: this.options.skillAllowlist,
        });
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

    // Personalization — stable user preferences (language + how to address
    // the user). Placed in the cacheable system prefix because it doesn't
    // change per-turn. Only emitted when at least one field is set.
    const { responseLanguage, userProfile } = this.options;
    if (responseLanguage || userProfile) {
      sections.push({
        name: "personalization",
        compute: () => {
          const lines = ["# User & Response Preferences"];
          if (userProfile) lines.push(`- About the user: ${userProfile}`);
          if (responseLanguage) lines.push(`- Response language: ${responseLanguage}`);
          return lines.join("\n");
        },
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
      return mm.buildMemoryContext({ maxAgeDays: this.options.memoriesMaxAgeDays });
    } catch {
      return "";
    }
  }
}
