import { z } from "zod";

export const PLUGIN_PANEL_PERMISSIONS = [
  "context.session",
  "context.workspace",
  "storage",
  "external.open",
  "agent.submitPrompt",
] as const;

export const PLUGIN_PANEL_ICONS = ["panel", "chart", "table", "activity", "plug"] as const;

const SafeRelativePanelPath = z.string().superRefine((value, ctx) => {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("?") ||
    value.includes("#") ||
    value
      .split("/")
      .some(
        (segment) =>
          segment === "" || segment === "." || segment === ".." || segment.startsWith("."),
      ) ||
    !value.toLowerCase().endsWith(".html")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "panel entry must be a POSIX relative .html path without traversal, query, or hash",
    });
  }
});

export const PluginPanelManifestEntry = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    title: z
      .object({
        default: z.string().min(1).max(80),
        en: z.string().min(1).max(80).optional(),
        "zh-CN": z.string().min(1).max(80).optional(),
      })
      .strict(),
    entry: SafeRelativePanelPath,
    icon: z.enum(PLUGIN_PANEL_ICONS).default("panel"),
    placement: z.literal("right-dock").default("right-dock"),
    singleton: z.boolean().default(true),
    permissions: z.array(z.enum(PLUGIN_PANEL_PERMISSIONS)).max(8).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.permissions.includes("agent.submitPrompt") &&
      !value.permissions.includes("context.session")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["permissions"],
        message: "agent.submitPrompt requires context.session",
      });
    }
  });

export const PluginPanelsManifest = z
  .object({
    version: z.literal(1),
    entries: z.array(PluginPanelManifestEntry).max(16),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const [index, entry] of value.entries.entries()) {
      if (ids.has(entry.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "id"],
          message: `duplicate panel id: ${entry.id}`,
        });
      }
      ids.add(entry.id);
    }
  });

export type PluginPanelManifestEntry = z.infer<typeof PluginPanelManifestEntry>;
export type PluginPanelsManifest = z.infer<typeof PluginPanelsManifest>;

/** Codex `.codex-plugin/plugin.json`. v1 reads required fields; unknowns pass through. */
export const CodexPluginManifest = z
  .object({
    name: z.string(),
    version: z.string(),
    description: z.string().optional(),
    // string → relative path to a .mcp.json; object → inline mcpServers map
    mcpServers: z.union([z.string(), z.record(z.any())]).optional(),
    skills: z.string().optional(),
    agents: z.string().optional(),
    panels: PluginPanelsManifest.optional(),
  })
  .passthrough();

export type CodexPluginManifest = z.infer<typeof CodexPluginManifest>;

/** Trusted, normalized manifest written into an installed plugin directory. */
export const CanonicalPluginManifest = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1),
    version: z.string().optional(),
    description: z.string().optional(),
    panels: PluginPanelsManifest.optional(),
  })
  .strict();

export type CanonicalPluginManifest = z.infer<typeof CanonicalPluginManifest>;
export const CANONICAL_PLUGIN_MANIFEST_FILE = ".cs-plugin-manifest.json";

/** `.cs-meta.json` written into every installed plugin dir. */
export const CSMeta = z.object({
  name: z.string(),
  format: z.enum(["cc", "codex"]),
  version: z.string().optional(),
  source: z.string(),
  installedAt: z.string(),
  commit: z.string().optional(), // remote (git) source: the HEAD SHA we installed
});

export type CSMeta = z.infer<typeof CSMeta>;

export class PluginInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginInstallError";
  }
}
