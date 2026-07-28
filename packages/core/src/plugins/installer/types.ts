import { z } from "zod";

const PluginLocalizedTitle = z
  .object({
    default: z.string().min(1).max(120),
    en: z.string().min(1).max(120).optional(),
    "zh-CN": z.string().min(1).max(120).optional(),
  })
  .strict();

export const PluginAutomationTemplate = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    title: PluginLocalizedTitle,
    description: z.string().min(1).max(500).optional(),
    schedule: z.string().min(1).max(128),
    prompt: z.string().min(1).max(32_768),
    timezone: z.string().min(1).max(100).optional(),
    permissionLevel: z.enum(["read-only", "workspace-write", "full"]).default("read-only"),
    workspace: z.enum(["current", "none"]).default("current"),
  })
  .strict();

export const PluginAutomationsManifest = z
  .object({
    version: z.literal(1),
    templates: z.array(PluginAutomationTemplate).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const [index, template] of value.templates.entries()) {
      if (ids.has(template.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["templates", index, "id"],
          message: `duplicate automation template id: ${template.id}`,
        });
      }
      ids.add(template.id);
    }
  });

export type PluginAutomationTemplate = z.infer<typeof PluginAutomationTemplate>;
export type PluginAutomationsManifest = z.infer<typeof PluginAutomationsManifest>;

const CodexHooksDeclaration = z.union([
  z.string(),
  z.record(z.any()),
  z.array(z.union([z.string(), z.record(z.any())])),
]);

const HttpsPluginUrl = z
  .string()
  .url()
  .max(2048)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
      } catch {
        return false;
      }
    },
    { message: "plugin interface URL must use https" },
  );

export const PluginInterfaceMetadata = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    shortDescription: z.string().min(1).max(300).optional(),
    longDescription: z.string().min(1).max(4000).optional(),
    developerName: z.string().min(1).max(160).optional(),
    category: z.string().min(1).max(100).optional(),
    capabilities: z.array(z.string().min(1).max(80)).max(32).optional(),
    websiteURL: HttpsPluginUrl.optional(),
    privacyPolicyURL: HttpsPluginUrl.optional(),
    termsOfServiceURL: HttpsPluginUrl.optional(),
    defaultPrompt: z.array(z.string().min(1).max(128)).max(3).optional(),
    brandColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    composerIcon: z.string().min(1).max(512).optional(),
    logo: z.string().min(1).max(512).optional(),
    logoDark: z.string().min(1).max(512).optional(),
    screenshots: z.array(z.string().min(1).max(512)).max(3).optional(),
  })
  .strip();

export type PluginInterfaceMetadata = z.infer<typeof PluginInterfaceMetadata>;

/** CodeShell-only manifest overlay kept outside `.codex-plugin/plugin.json`. */
export const CodeShellPluginOverlay = z
  .object({
    schemaVersion: z.literal(1),
    automations: PluginAutomationsManifest.optional(),
  })
  .strict();

export type CodeShellPluginOverlay = z.infer<typeof CodeShellPluginOverlay>;
export const CODESHELL_PLUGIN_OVERLAY_FILE = ".codeshell-plugin/plugin.json";

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
    hooks: CodexHooksDeclaration.optional(),
    interface: PluginInterfaceMetadata.passthrough().optional(),
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
    interface: PluginInterfaceMetadata.optional(),
    automations: PluginAutomationsManifest.optional(),
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
