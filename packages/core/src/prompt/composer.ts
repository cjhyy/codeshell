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
import type { BuiltinTool } from "../tool-system/builtin/index.js";
import type { CapabilityDynamicContextProvider } from "../capabilities/index.js";

export interface ComposerOptions {
  cwd: string;
  model: string;
  instructionOptions?: ScanOptions;
  /** Resolved preset — used to load section-based prompt. */
  preset?: AgentPreset;
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  /** Prompt text and tool metadata supplied by this Engine's capability modules. */
  capabilityPromptSections?: Readonly<Record<string, string>>;
  /** Per-turn context owned by installed capability modules. */
  dynamicContextProviders?: readonly CapabilityDynamicContextProvider[];
  toolCatalog?: readonly BuiltinTool[];
  /** User's preferred response language (free text), injected as a stable system section. */
  responseLanguage?: string;
  /** How to address the user / short profile (free text). */
  userProfile?: string;
  /**
   * 激活数字人（WorkspaceProfile）的主指令。排序在 preset behavior 之后、
   * appendSystemPrompt 之前 —— 本地 CLAUDE.md（user-context 消息）与用户
   * append 都比它更“具体/优先”。来源：engine 经 resolveActiveWorkspaceProfile
   * 解析后传入；composer 不自行读盘。
   */
  profileMainInstruction?: string;
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
  /** Volatile goal state used only in the trailing dynamic-context message. */
  goalToolState?: { hasGoal: boolean };
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

    // NOTE: memory is intentionally NOT here. It used to be, but memory mutates
    // constantly (extraction, recall usage++/lastUsed, approve/demote), and this
    // message sits in the cacheable system prefix — so every memory change
    // invalidated the whole prefix and re-billed it. Memory now rides
    // buildDynamicContextMessage (tail, past the cache breakpoint), same as the
    // skills listing and other volatile capability context which have the identical problem.
    if (!instructions) return null;

    // Local date, not UTC — toISOString() is UTC and would show the wrong
    // "today" for users whose timezone has crossed midnight (review-2026-05-30).
    const now = new Date();
    const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const currentDate = `Today's date is ${ymd}.`;

    let content = `<system-reminder>\n${currentDate}\n\n`;
    content += `${instructions}\n`;
    content += `</system-reminder>`;

    return { role: "user", content };
  }

  /** Build volatile context contributed by installed capability modules. */
  async buildSystemContext(): Promise<string> {
    const preset = this.options.preset ?? resolveAgentPreset();
    const parts = await Promise.all(
      (this.options.dynamicContextProviders ?? []).map(async (provider) => {
        try {
          return await provider({ cwd: this.options.cwd, preset });
        } catch {
          // A capability's optional context must not make a turn fail.
          return undefined;
        }
      }),
    );
    return parts.filter((part): part is string => Boolean(part)).join("\n\n");
  }

  /**
   * Per-turn dynamic context, delivered as a trailing <system-reminder> user
   * message rather than baked into the system prefix.
   *
   * Holds things that change *within* a session — the skills listing plus
   * capability-owned volatile context. Keeping them out of the
   * system prompt means installing a skill or editing a file no longer
   * invalidates the cached system prefix. Placed at the END of the messages
   * array (after the user task) so it sits past the conversation's cache
   * breakpoint — a change here never re-bills the history prefix.
   */
  async buildDynamicContextMessage(): Promise<Message | null> {
    const skills = scanSkills(this.options.cwd, {
      disabledSkills: this.options.disabledSkills,
      disabledPlugins: this.options.disabledPlugins,
      skillAllowlist: this.options.skillAllowlist,
    });
    const skillsListing = buildSkillListing(skills);
    const capabilityContext = await this.buildSystemContext();
    // Memory rides here (tail, past the cache breakpoint) — not the system
    // prefix — so a memory change (extraction / recall usage++ / approve) never
    // re-bills the cached prefix. See buildUserContextMessage for the rationale.
    const memoryContext = this.getMemoryContext();
    const goalToolContext = this.buildGoalToolContext();

    const parts = [skillsListing, capabilityContext, memoryContext, goalToolContext].filter(
      Boolean,
    );
    if (parts.length === 0) return null;

    return {
      role: "user",
      content: `<system-reminder>\n${parts.join("\n\n")}\n</system-reminder>`,
    };
  }

  private buildGoalToolContext(): string {
    if (!this.options.goalToolState) return "";
    return this.options.goalToolState.hasGoal
      ? "当前存在 active goal。只有在目标完全完成时才可调用 complete_goal；只有用户明确要求取消/停止/放弃该目标时才可调用 cancel_goal。"
      : "当前没有 active goal。不要调用 complete_goal/cancel_goal；如果误调用，系统会拒绝。";
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
          const toolLines = tools.map((t) => `### ${t.name}\n${t.description}`);
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
      // cacheBreak: this section's content varies by activeToolNames (tool-gated
      // sections like "browser" drop when their tools are off). The cache is
      // keyed by section NAME only, so without cacheBreak a reused composer could
      // serve a stale behavior block across an on/off change. Recompute always —
      // it's a cheap string join, and it makes the browser on/off unit correct
      // regardless of composer lifetime.
      cacheBreak: true,
      compute: () => {
        const preset = this.options.preset ?? resolveAgentPreset();
        return buildPresetSystemPrompt(preset, {
          activeToolNames,
          platform: process.platform,
          promptSections: this.options.capabilityPromptSections,
          toolCatalog: this.options.toolCatalog,
        });
      },
    });

    // 数字人主指令 —— 见 profileMainInstruction 的 doc comment。
    if (this.options.profileMainInstruction) {
      sections.push({
        name: "profile_main_instruction",
        compute: () =>
          `# Digital-Human Main Instruction\n\n${this.options.profileMainInstruction!}`,
      });
    }

    // Skills listing is intentionally NOT a system section: it changes when a
    // skill is installed/disabled, which would invalidate the whole cached
    // system prefix on every change. It rides in the per-turn dynamic-context
    // message instead (buildDynamicContextMessage). Same reasoning keeps the
    // capability-owned volatile context out of the system prefix — see buildSystemContext's
    // callers.

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
      // Two-layer injection (用户拍板): a compact index merging GLOBAL +
      // PROJECT memories. Global memories are now surfaced every session
      // regardless of cwd (the fix for "global memory never shows up"); the
      // model reads full bodies on demand via MemoryRead.
      return MemoryManager.buildInjectionIndex({
        projectDir: this.options.cwd,
        maxAgeDays: this.options.memoriesMaxAgeDays,
      });
    } catch {
      return "";
    }
  }
}
