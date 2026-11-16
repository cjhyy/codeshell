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
import { dateChangeNotice, resolveSessionDates, type SessionDates } from "./session-date.js";
import { MemoryManager } from "../session/memory.js";
import { scanSkills } from "../skills/index.js";
import {
  buildSkillListingParts,
  type SkillListingOptions,
} from "../tool-system/builtin/skill-prompt.js";
import {
  contextListSection,
  type ContextListParts,
  type ContextSection,
} from "../context/context-ledger.js";
import { resolveAgentPreset, buildPresetSystemPrompt, type AgentPreset } from "../preset/index.js";
import type { BuiltinTool } from "../tool-system/builtin/index.js";
import type { CapabilityDynamicContextProvider } from "../capabilities/index.js";
import { capabilityContextSections } from "./capability-context.js";
import {
  legacySingleRootWorkspace,
  validateWorkspaceContext,
  type WorkspaceContext,
} from "../workspace/workspace-context.js";

export interface ComposerOptions {
  cwd: string;
  /** Run workspace; omitted by legacy callers that only provide cwd. */
  workspace?: WorkspaceContext;
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
  /**
   * 已绑定数据源的 metadata 摘要（名称/scope/状态；无源返回 ""）。只走动态
   * 上下文（不进可缓存 system 前缀），资源内容与 secret 永不注入（ADR §5/§7）。
   */
  sourcesContextProvider?: () => string | Promise<string>;
  toolCatalog?: readonly BuiltinTool[];
  /** Calling guidance for this run's resolved, frozen discovery mode. */
  toolDiscovery?: "call-tool" | "tool-reference";
  /** Eligible names frozen for this cache cycle; independent of eager declarations. */
  behaviorToolNames?: readonly string[];
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
   * Standing brief for this Session (see SessionState.sessionBrief) — team role,
   * teammate Session ids, the lead's playbook. Part of the cached system prefix
   * because it is fixed for the Session's lifetime, unlike the skills listing.
   */
  sessionBrief?: string;
  /**
   * Skills the active digital human declares (`WorkspaceProfile.skills`).
   *
   * Prioritizes installed declarations and warns when a declared skill is absent.
   * `requires` installs per project, so a digital human summoned in a project
   * that never got the install has an instruction telling it to use `/x` while
   * `/x` does not exist — a real session then called `/hyperframes`, got
   * "Skill not found", searched with Glob, and gave up. Stating the gap costs a
   * line and stops the flailing.
   */
  profileDeclaredSkills?: readonly string[];
  skillListing?: SkillListingOptions;
  /** 激活数字人的可移植记忆层根目录（portableMemory=true 时由 engine 传入）。 */
  profileMemoryDir?: string;
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
  /**
   * When true (set from the active behavior profile, e.g. the Pet manager),
   * the injected memory index keeps only memories relevant to this cwd —
   * global-layer project/dream records tied to other projects are dropped.
   * See MemoryManager.buildInjectionIndexParts(currentProjectOnly).
   */
  memoryCurrentProjectOnly?: boolean;
  /**
   * When the session started (epoch ms, SessionState.startedAt). The head
   * context message states this date for the session's whole life, so its
   * bytes — and every cached prefix behind it — survive midnight.
   */
  sessionStartedAt?: number;
  /** Clock for the date; injectable for tests. */
  now?: () => Date;
  /** Isolated runs can omit repository/user instruction discovery entirely. */
  disableInstructions?: boolean;
  /** Isolated runs can omit persistent-memory context entirely. */
  disableMemoryContext?: boolean;
  /** Isolated runs can omit capability-owned volatile context providers. */
  disableCapabilityContext?: boolean;
  /** Isolated runs can omit bound-source metadata. */
  disableSourcesContext?: boolean;
}

type NormalizedComposerOptions = Omit<ComposerOptions, "workspace"> & {
  workspace: WorkspaceContext;
};

export class PromptComposer {
  private sectionCache = new SectionCache();
  private cachedInstructions: string | null = null;
  private readonly options: NormalizedComposerOptions;

  constructor(options: ComposerOptions) {
    this.options = {
      ...options,
      ...(options.behaviorToolNames !== undefined
        ? { behaviorToolNames: [...options.behaviorToolNames] }
        : {}),
      workspace:
        options.workspace === undefined
          ? legacySingleRootWorkspace(options.cwd)
          : validateWorkspaceContext(options.workspace),
    };
  }

  /**
   * Build the system prompt from sections.
   */
  async buildSystemPrompt(
    tools: ToolDefinition[],
    behaviorToolNames = this.options.behaviorToolNames,
  ): Promise<string> {
    const sections = this.getSections(tools, behaviorToolNames);
    const resolved = await this.sectionCache.resolve(sections);
    return resolved.join("\n\n");
  }

  /**
   * Build the userContext prefix message (CLAUDE.md content as <system-reminder>).
   */
  buildUserContextMessage(): Message | null {
    if (this.options.disableInstructions === true) return null;
    const instructions = this.getInstructions();

    // NOTE: memory is intentionally NOT here. It used to be, but memory mutates
    // constantly (extraction, recall usage++/lastUsed, approve/demote), and this
    // message sits in the cacheable system prefix — so every memory change
    // invalidated the whole prefix and re-billed it. Memory now rides
    // buildDynamicContextSections (tail, past the cache breakpoint), same as the
    // skills listing and other volatile capability context which have the identical problem.
    if (!instructions) return null;

    // The session's start date (local, not UTC), so this message — the head
    // of every cached prefix — does not change at midnight. A later "today"
    // is announced through the context ledger: see buildDateChangeNotice.
    const currentDate = `Today's date is ${this.sessionDates().headDate}.`;

    let content = `<system-reminder>\n${currentDate}\n\n`;
    content += `${instructions}\n`;
    content += `</system-reminder>`;

    return { role: "user", content };
  }

  private sessionDates(): SessionDates {
    return resolveSessionDates(this.options.sessionStartedAt, this.options.now?.() ?? new Date());
  }

  /**
   * Text for the context ledger's "date" section: empty unless today's local
   * date differs from the one frozen in the head message (and there is a head
   * message stating one).
   */
  buildDateChangeNotice(): string {
    if (this.options.disableInstructions === true || !this.getInstructions()) return "";
    const { changedTo } = this.sessionDates();
    return changedTo === undefined ? "" : dateChangeNotice(changedTo);
  }

  /** Volatile context contributed by installed capability modules, as ledger sections. */
  private async buildCapabilitySections(): Promise<ContextSection[]> {
    if (this.options.disableCapabilityContext === true) return [];
    const preset = this.options.preset ?? resolveAgentPreset();
    const parts = await Promise.all(
      (this.options.dynamicContextProviders ?? []).map(async (provider) => {
        try {
          return await provider({
            cwd: this.options.cwd,
            workspace: this.options.workspace,
            preset,
          });
        } catch {
          // A capability's optional context must not make a turn fail.
          return undefined;
        }
      }),
    );
    return capabilityContextSections(parts);
  }

  /**
   * Declared-but-absent skills, stated plainly. Rides the dynamic context (not
   * the cached system prefix) because it depends on what is installed right now.
   */
  private buildDeclaredSkillGap(available: readonly { name: string }[]): string {
    const declared = this.options.profileDeclaredSkills;
    if (!declared || declared.length === 0) return "";
    const present = new Set(available.map((skill) => skill.name));
    const missing = declared.filter((name) => !present.has(name));
    if (missing.length === 0) return "";
    return [
      "<digital-human-capability-gap>",
      `This digital human declares skills that are NOT installed in this workspace: ${missing.join(", ")}.`,
      "Do not call them and do not hunt for their files — they are absent, not hidden.",
      "Work with the tools you do have, and tell the user which capability is missing if it blocks the task.",
      "</digital-human-capability-gap>",
    ].join("\n");
  }

  /**
   * The workspace the dynamic context is scoped to: skills and memory are read
   * from the working directory, sources from the project. Context told under a
   * different scope must not stay visible (engine/run-context-ledger.ts).
   */
  contextScope(): string {
    return JSON.stringify([this.options.cwd, this.options.workspace.projectId]);
  }

  /**
   * Dynamic context, delivered as <system-reminder> user messages rather than
   * baked into the system prefix.
   *
   * Holds things that change *within* a session — the skills listing, memory
   * and capability-owned context. Keeping them out of the system prompt means
   * installing a skill or editing a file no longer invalidates the cached
   * system prefix. The engine sends the sections through the context ledger
   * (engine/run-context-ledger.ts): a snapshot once, then only what changed,
   * always appended so earlier history is never rewritten.
   *
   * The dynamic context as ordered sections (empty ones omitted, except a
   * skills section whose listing did not fit). The context ledger renders a
   * snapshot or resends only what changed since the model was last told.
   */
  async buildDynamicContextSections(): Promise<ContextSection[]> {
    const skills = scanSkills(this.options.cwd, {
      disabledSkills: this.options.disabledSkills,
      disabledPlugins: this.options.disabledPlugins,
      skillAllowlist: this.options.skillAllowlist,
    });
    const skillsListing = buildSkillListingParts(skills, {
      ...this.options.skillListing,
      preferredSkills: this.options.skillAllowlist,
      declaredSkills: this.options.profileDeclaredSkills,
    });
    const declaredSkillGap = this.buildDeclaredSkillGap(skills);
    // Capability and sources context are independent I/O — resolve them
    // concurrently instead of serially.
    const [capabilitySections, sourcesContext] = await Promise.all([
      this.buildCapabilitySections(),
      (async () => {
        if (this.options.disableSourcesContext === true) return "";
        try {
          return (await this.options.sourcesContextProvider?.()) ?? "";
        } catch {
          // Optional metadata context must not make a turn fail.
          return "";
        }
      })(),
    ]);
    // Memory rides here (tail, past the cache breakpoint) — not the system
    // prefix — so a memory change (extraction / recall usage++ / approve) never
    // re-bills the cached prefix. See buildUserContextMessage for the rationale.
    const memoryIndex = this.getMemoryIndex();

    const sections: ContextSection[] = [
      // The listing is ranked and budgeted per run; only installs and removals
      // are context changes worth telling the model about.
      ...(skillsListing
        ? [
            {
              ...contextListSection("skills", skillsListing),
              compare: "ids" as const,
              knownIds: skills.map((skill) => skill.name),
            },
          ]
        : skills.length > 0
          ? [
              // No listing fits the budget this run, but the skills exist:
              // the section stays (empty) so it is not announced as removed.
              {
                key: "skills",
                text: "",
                compare: "ids" as const,
                knownIds: skills.map((skill) => skill.name),
              },
            ]
          : []),
      { key: "skill-gap", text: declaredSkillGap },
      ...capabilitySections,
      ...(memoryIndex ? [contextListSection("memory", memoryIndex)] : []),
      { key: "sources", text: sourcesContext },
      { key: "goal-tool", text: this.buildGoalToolContext() },
    ];
    return sections.filter(
      (section) => Boolean(section.text) || (section.knownIds?.length ?? 0) > 0,
    );
  }

  private buildGoalToolContext(): string {
    if (!this.options.goalToolState) return "";
    return this.options.goalToolState.hasGoal
      ? "Goal 工具状态：本会话存在一个持久 Goal。只有在该 Goal 完全完成时才可调用 complete_goal；只有用户明确要求取消/停止/放弃该 Goal 时才可调用 cancel_goal。此状态不代表后台任务或其他 Session 的运行状态，不要把它改写成系统是否空闲。"
      : "Goal 工具状态：本会话没有持久 Goal，因此不要调用 complete_goal/cancel_goal；如果误调用，系统会拒绝。这只描述 Goal 工具的可用状态，不代表没有后台任务、没有运行中的 Session 或系统正在待命，也不要向用户复述为任务状态。";
  }

  invalidateCache(sectionName?: string): void {
    this.sectionCache.invalidate(sectionName);
    if (!sectionName) {
      this.cachedInstructions = null;
    }
  }

  private getSections(
    tools: ToolDefinition[],
    behaviorToolNames: readonly string[] | undefined,
  ): PromptSection[] {
    const sections: PromptSection[] = [];

    // Runtime header
    sections.push({
      name: "runtime_header",
      compute: () => {
        const lines = [
          `You are an AI agent powered by ${this.options.model}.`,
          `Working directory: ${this.options.cwd}`,
          `Workspace roots (${this.options.workspace.roots.length}):`,
          ...this.options.workspace.roots.map(
            (root) => `- [${root.role}] ${root.path} (rootId: ${root.id})`,
          ),
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

    // List only the frozen tool surface; discovery appends schemas to history.
    if (tools.length > 0) {
      sections.push({
        name: "tool_definitions",
        // A reused composer must reflect the current run's visible tool names.
        cacheBreak: true,
        compute: () => {
          const discoveryGuidance = !tools.some((tool) => tool.name === "ToolSearch")
            ? ""
            : this.options.toolDiscovery === "tool-reference"
              ? ' Use ToolSearch for other available tools: keyword searches return compact metadata; "select:ToolName" loads native references when available and returns full schema text otherwise. Call tools loaded through native references by their exact names. For schemas shown as text, including late or changed tools, use CallTool with the exact name and an args object matching inputSchema. Selection does not grant permission.'
              : ' Use ToolSearch for other available tools: keyword searches return compact metadata; "select:ToolName" returns its full schema. Then use CallTool with the exact name and an args object matching that schema. Selection does not grant permission.';
          return `# Available Tools\n\nDescriptions and input schemas for active tools are provided in the tools field.${discoveryGuidance}\n${tools.map((tool) => tool.name).join(", ")}`;
        },
      });
    }

    // Discovery can defer declarations without deferring their usage instructions.
    // Engine callers supply the cycle's frozen eligible names; legacy/preview
    // callers continue to gate behavior with the visible definitions they provide.
    const activeToolNames = behaviorToolNames ?? tools.map((t) => t.name);
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

    // Standing Session brief — see sessionBrief's doc comment. Placed after the
    // digital human's own instruction (who you are) because it narrows that role
    // to this Session (what you are doing here, with whom).
    if (this.options.sessionBrief) {
      sections.push({
        name: "session_brief",
        compute: () => `# Session Brief\n\n${this.options.sessionBrief!}`,
      });
    }

    // Skills listing is intentionally NOT a system section: it changes when a
    // skill is installed/disabled, which would invalidate the whole cached
    // system prefix on every change. It rides in the per-turn dynamic-context
    // message instead (buildDynamicContextSections). Same reasoning keeps the
    // capability-owned volatile context out of the system prefix — see
    // buildCapabilitySections.

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

  private getMemoryIndex(): ContextListParts | null {
    if (this.options.disableMemoryContext === true) return null;
    try {
      // Three-layer injection (用户拍板): a compact index merging GLOBAL +
      // DIGITAL-HUMAN + PROJECT memories. Global memories are surfaced every
      // session; the portable middle layer is present only when the active
      // workspace profile opts in.
      return MemoryManager.buildInjectionIndexParts({
        projectDir: this.options.cwd,
        profileDir: this.options.profileMemoryDir,
        maxAgeDays: this.options.memoriesMaxAgeDays,
        currentProjectOnly: this.options.memoryCurrentProjectOnly,
      });
    } catch {
      return null;
    }
  }
}
