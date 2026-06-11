import { z } from "zod";

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
  })
  .passthrough();

export type CodexPluginManifest = z.infer<typeof CodexPluginManifest>;

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
