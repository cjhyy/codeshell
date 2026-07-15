/**
 * Workspace 数据源三层模型的数据定义。语义决策见
 * docs/todo/workspace-datasource-binding-adr.md（ADR-1/2/4）。
 * project settings 只存 binding（ref/scope/readPolicy），绝不存 secret。
 */
import { z } from "zod";

export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const SOURCE_KINDS = ["mock", "mcp-resource", "local-files"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SourceDefinitionSchema = z.object({
  id: z.string().regex(SOURCE_ID_RE),
  kind: z.enum(SOURCE_KINDS),
  label: z.string().min(1),
  description: z.string().optional(),
  /** 按 kind 的 adapter 配置（如 mcp-resource: { server }）。 */
  adapterConfig: z.record(z.unknown()).default({}),
  /** 指向全局 CredentialStore 的 id；local-files/mock 不需要。 */
  credentialRef: z.string().optional(),
  enabled: z.boolean().default(true),
});
export type SourceDefinition = z.infer<typeof SourceDefinitionSchema>;

export const WorkspaceSourceBindingSchema = z.object({
  sourceId: z.string().regex(SOURCE_ID_RE),
  /** 显式勾选的 scope id；空数组 = 什么都不可见（不是"全部"）。 */
  scopes: z.array(z.string()),
  /** ask（默认，ReadSource 每次审批）| deny（只许 list metadata，禁读内容）。无 allow 档（ADR §1.2）。 */
  readPolicy: z.enum(["ask", "deny"]).default("ask"),
});
export type WorkspaceSourceBinding = z.infer<typeof WorkspaceSourceBindingSchema>;

/** adapter 返回的 scope/resource/content 形状（运行时对象，不落盘）。 */
export interface SourceScope {
  id: string;
  label: string;
  description?: string;
}

export interface SourceResourceMeta {
  id: string;
  scopeId: string;
  name: string;
  sizeBytes?: number;
  mimeType?: string;
}

export interface SourceContent {
  resourceId: string;
  text: string;
  truncated: boolean;
}
