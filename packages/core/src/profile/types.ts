/**
 * WorkspaceProfile（数字人）— harness 元机制的数据定义。
 * 引用现有窄 AgentPreset，不修改它；plugins/skills/mcp/agents 在激活时
 * 展开为 capabilityOverrides 形状的 force-enable 快照（见 activation.ts）。
 * 设计稿：docs/superpowers/specs/2026-07-15-workspace-profile-design.md
 */
import { z } from "zod";

/** 目录名即机器标识：小写字母/数字开头，可含 - _，防路径逃逸。 */
export const WORKSPACE_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const WorkspaceProfileSchema = z.object({
  name: z.string().regex(WORKSPACE_PROFILE_NAME_RE),
  label: z.string().min(1),
  description: z.string().optional(),
  /** 引用现有 AgentPreset 名（如 "general"）；不在 schema 层校验存在性，解析时才校验。 */
  basePreset: z.string().min(1),
  plugins: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  mcp: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),
  /** 数字人主指令，注入系统提示（优先级低于本地 CLAUDE.md，高于 preset sections）。 */
  mainInstruction: z.string().optional(),
  /** true → 挂载 profiles/<name>/ 为第二记忆层（跟数字人走）。 */
  portableMemory: z.boolean().default(false),
  version: z.string().optional(),
});

export type WorkspaceProfile = z.infer<typeof WorkspaceProfileSchema>;
