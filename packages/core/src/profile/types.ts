/**
 * WorkspaceProfile（数字人）— harness 元机制的数据定义。
 * 引用现有窄 AgentPreset，不修改它；plugins/skills/mcp/agents 在激活时
 * 展开为 capabilityOverrides 形状的 force-enable 快照（见 activation.ts）。
 * 设计稿：docs/superpowers/specs/2026-07-15-workspace-profile-design.md
 */
import { z } from "zod";

/** 目录名即机器标识：小写字母/数字开头，可含 - _，防路径逃逸。 */
export const WORKSPACE_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * `owner/repo`。收紧到 GitHub 允许的字符集，且两段都不能以 `-`/`.` 开头 ——
 * 这个值会作为参数传给 `npx skills add`，必须挡住 `--flag`、`../` 一类注入。
 */
export const SKILL_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** 纯数字点分版本，避免把任意字符串塞进版本比较。 */
export const TOOL_VERSION_RE = /^\d+(\.\d+){0,2}$/;

/** 持久化与提示注入的防滥用边界；Desktop 编辑器应保持相同上限。 */
export const WORKSPACE_PROFILE_LIMITS = {
  label: 120,
  description: 4_096,
  basePreset: 128,
  mainInstruction: 32_768,
  version: 128,
  capabilityCount: 128,
  capabilityName: 256,
  /** requires.skills / requires.tools 各自的条目上限。 */
  requirementCount: 16,
} as const;

const capabilityNameSchema = z.string().min(1).max(WORKSPACE_PROFILE_LIMITS.capabilityName);
const capabilityListSchema = z
  .array(capabilityNameSchema)
  .max(WORKSPACE_PROFILE_LIMITS.capabilityCount)
  .refine((items) => new Set(items).size === items.length, {
    message: "capability entries must be unique",
  });

/**
 * 依赖来源：数字人自带的「怎么把能力弄来」声明。
 *
 * 与 plugins/skills/mcp/agents 的分工：那四个是 force-enable 开关（只能打开
 * 磁盘上已存在的东西），`requires` 才是获取步骤。没有 `requires` 的旧 profile
 * 行为完全不变。
 *
 * 解析、冲突预检与安装见 requirements.ts —— 安装涉及克隆远程仓库与执行
 * `npx skills add`，必须先经用户确认，绝不静默执行。
 */
const skillRequirementSchema = z.object({
  /** 目前只支持 github；保留判别字段以便后续扩展。 */
  source: z.literal("github"),
  /** `owner/repo` 形式。 */
  repo: z.string().regex(SKILL_REPO_RE),
  /** 只装这些 skill；省略表示装全部（`--all`）。 */
  skills: capabilityListSchema.optional(),
  /**
   * project → `<cwd>/.agents/skills`（scanner 认）。
   * user 级 `npx skills add -g` 落在 `~/.claude/skills`，**不在 scanner 的三个根里**，
   * 装了会扫不到，故不开放该 scope。
   */
  scope: z.literal("project").default("project"),
  /** 仓库根有 SKILL.md 时也继续深搜子目录。 */
  fullDepth: z.boolean().default(false),
});

/** 装不了、只能检测的外部命令（ffmpeg / node …）。缺失时提前失败，而不是渲染到一半才炸。 */
const toolRequirementSchema = z.object({
  bin: z.string().min(1).max(WORKSPACE_PROFILE_LIMITS.capabilityName),
  /** 形如 "22"、"22.1"、"22.1.0"，与 `--version` 输出的首个版本号比较。 */
  minVersion: z.string().regex(TOOL_VERSION_RE).optional(),
  /** 缺失时展示给用户的安装建议，例如 "brew install ffmpeg"。 */
  hint: z.string().max(WORKSPACE_PROFILE_LIMITS.capabilityName).optional(),
});

export const WorkspaceProfileRequirementsSchema = z.object({
  skills: z
    .array(skillRequirementSchema)
    .max(WORKSPACE_PROFILE_LIMITS.requirementCount)
    .default([]),
  tools: z.array(toolRequirementSchema).max(WORKSPACE_PROFILE_LIMITS.requirementCount).default([]),
});

export type SkillRequirement = z.infer<typeof skillRequirementSchema>;
export type ToolRequirement = z.infer<typeof toolRequirementSchema>;
export type WorkspaceProfileRequirements = z.infer<typeof WorkspaceProfileRequirementsSchema>;

export const WorkspaceProfileSchema = z.object({
  name: z.string().regex(WORKSPACE_PROFILE_NAME_RE),
  label: z.string().min(1).max(WORKSPACE_PROFILE_LIMITS.label),
  description: z.string().max(WORKSPACE_PROFILE_LIMITS.description).optional(),
  /** 引用现有 AgentPreset 名（如 "general"）；不在 schema 层校验存在性，解析时才校验。 */
  basePreset: z.string().min(1).max(WORKSPACE_PROFILE_LIMITS.basePreset),
  /** 可选：省略即旧行为（只 enable，不获取）。 */
  requires: WorkspaceProfileRequirementsSchema.optional(),
  /**
   * true → 独占工作面：激活时把**未声明**的 skill/plugin/mcp/agent 显式关掉，
   * 而不是与用户已开启的取并集。
   *
   * 默认 false（并集）是安全的：数字人只保证「该有的能力一定在」，绝不静默
   * 关掉用户手动开的东西。独占是更强的意图——「切到这个数字人就只用这套工具」
   * ——上下文更干净，但代价是用户会发现自己开的东西不见了，所以必须显式声明。
   * 注意：用户在项目 settings 里手写的 override 优先级仍然最高（见 overlay.ts）。
   */
  exclusiveCapabilities: z.boolean().default(false),
  plugins: capabilityListSchema.default([]),
  skills: capabilityListSchema.default([]),
  mcp: capabilityListSchema.default([]),
  agents: capabilityListSchema.default([]),
  /** 数字人主指令，注入系统提示（优先级低于本地 CLAUDE.md，高于 preset sections）。 */
  mainInstruction: z.string().max(WORKSPACE_PROFILE_LIMITS.mainInstruction).optional(),
  /** true → 挂载 profiles/<name>/ 为第二记忆层（跟数字人走）。 */
  portableMemory: z.boolean().default(false),
  version: z.string().max(WORKSPACE_PROFILE_LIMITS.version).optional(),
});

export type WorkspaceProfile = z.infer<typeof WorkspaceProfileSchema>;

/**
 * 写入侧类型：带 `.default()` 的字段（`exclusiveCapabilities`、`portableMemory`、
 * 四个 capability 列表）在这里是可选的。
 *
 * 为什么需要它：`WorkspaceProfile` 是 schema 的**输出**类型，defaults 已解析，
 * 所以每个字段都是必填。但接受「未解析的 profile 再 parse」的函数
 * （如 `saveWorkspaceProfile`）实际契约是**输入**类型——用输出类型标注会强迫每个
 * 调用方手写它本来就想让 schema 填的默认值。schema 新增一个带 default 的字段时，
 * 这个错配会让所有既有调用方一起报错（`exclusiveCapabilities` 就是这么发生的）。
 */
export type WorkspaceProfileInput = z.input<typeof WorkspaceProfileSchema>;
