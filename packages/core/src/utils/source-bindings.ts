import { z } from "zod";

export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const WorkspaceSourceBindingSchema = z.object({
  sourceId: z.string().regex(SOURCE_ID_RE),
  /** 显式勾选的 scope id；空数组 = 什么都不可见（不是"全部"）。 */
  scopes: z
    .array(
      z
        .string()
        .min(1)
        .max(512)
        .refine((value) => !value.includes("\0")),
    )
    .max(1_000)
    .refine((scopes) => new Set(scopes).size === scopes.length, "source scopes must be unique"),
  /** ask（默认，ReadSource 每次审批）| deny（只许 list metadata，禁读内容）。无 allow 档（ADR §1.2）。 */
  readPolicy: z.enum(["ask", "deny"]).default("ask"),
  /** Project-owned reference preference; it never grants access or changes search scores. */
  priority: z.enum(["normal", "high"]).optional(),
});
export type WorkspaceSourceBinding = z.infer<typeof WorkspaceSourceBindingSchema>;

/** Optional Profile allowlist: omission preserves bindings; [] denies every source. */
export const ProfileSourceAccessSchema = z
  .array(WorkspaceSourceBindingSchema)
  .max(1_000)
  .refine((items) => new Set(items.map((item) => item.sourceId)).size === items.length, {
    message: "profile source ids must be unique",
  });
export type ProfileSourceAccess = z.infer<typeof ProfileSourceAccessSchema>;
