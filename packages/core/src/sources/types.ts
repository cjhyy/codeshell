/**
 * Workspace 数据源三层模型的数据定义。语义决策见
 * docs/todo/workspace-datasource-binding-adr.md（ADR-1/2/4）。
 * project settings 只存 binding（ref/scope/readPolicy），绝不存 secret。
 */
import { z } from "zod";
import { SOURCE_ID_RE } from "../utils/source-bindings.js";
export {
  SOURCE_ID_RE,
  WorkspaceSourceBindingSchema,
  ProfileSourceAccessSchema,
  type WorkspaceSourceBinding,
  type ProfileSourceAccess,
} from "../utils/source-bindings.js";

export const SOURCE_KINDS = ["mock", "mcp-resource", "local-files", "link", "collection"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SourceDefinitionSchema = z.object({
  id: z.string().regex(SOURCE_ID_RE),
  kind: z.enum(SOURCE_KINDS),
  label: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => !value.includes("\0")),
  description: z
    .string()
    .max(4_096)
    .refine((value) => !value.includes("\0"))
    .optional(),
  /** 按 kind 的 adapter 配置（如 mcp-resource: { server }）。 */
  adapterConfig: z.record(z.unknown()).default({}),
  /** 指向全局 CredentialStore 的 id；local-files/mock 不需要。 */
  credentialRef: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.-]+$/)
    .optional(),
  enabled: z.boolean().default(true),
});
export type SourceDefinition = z.infer<typeof SourceDefinitionSchema>;

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
