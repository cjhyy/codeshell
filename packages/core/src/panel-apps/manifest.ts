import { z } from "zod";
import { validateToolInputSchemaStrict } from "../tool-system/validation.js";

export const PANEL_APP_MANIFEST_FILE = ".codeshell-panel/panel.json";

export const PANEL_APP_PERMISSIONS = [
  "context.session",
  "context.workspace",
  "storage",
  "external.open",
  "agent.submitPrompt",
  "agent.task",
  "workspace.info",
  "workspace.read",
  "workspace.write",
  "notifications.send",
  "audio.transcribe",
  "credentials.cookies",
  "automations.manage",
  "process",
] as const;

export const PANEL_APP_ICONS = [
  "panel",
  "activity",
  "bar-chart-3",
  "chart",
  "file-text",
  "globe",
  "image",
  "layout-dashboard",
  "line-chart",
  "palette",
  "pie-chart",
  "table",
  "terminal",
] as const;

const SafePanelAppEntry = z.string().superRefine((value, ctx) => {
  if (
    value.length === 0 ||
    value.length > 1_024 ||
    !value.includes("/") ||
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
      message:
        "panel app entry must be a nested, safe POSIX-relative .html path without traversal, query, hash, or hidden segments",
    });
  }
});

const SafePanelAppSkillEntry = z.string().superRefine((value, ctx) => {
  const segments = value.split("/");
  if (
    value.length === 0 ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    segments.length !== 4 ||
    segments[0] !== "agent" ||
    segments[1] !== "skills" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(segments[2] ?? "") ||
    segments[3] !== "SKILL.md"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "panel app skills must use agent/skills/<skill-id>/SKILL.md",
    });
  }
});

const LocalizedTitle = z
  .object({
    default: z.string().min(1).max(80),
    en: z.string().min(1).max(80).optional(),
    "zh-CN": z.string().min(1).max(80).optional(),
  })
  .strict();

export const PanelAppAgentTool = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    description: z.string().min(1).max(500),
    inputSchema: z.record(z.unknown()),
    readOnly: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.inputSchema.type !== "object") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputSchema", "type"],
        message: "panel app tool inputSchema must describe a JSON object",
      });
      return;
    }
    const schemaError = validateToolInputSchemaStrict(value.inputSchema);
    if (schemaError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputSchema"],
        message: `panel app tool inputSchema is invalid: ${schemaError}`,
      });
    }
  });

export const PanelAppAgentContribution = z
  .object({
    tools: z.array(PanelAppAgentTool).max(16).default([]),
    skills: z.array(SafePanelAppSkillEntry).max(8).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const toolNames = new Set<string>();
    for (const [index, tool] of value.tools.entries()) {
      if (toolNames.has(tool.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tools", index, "name"],
          message: `duplicate panel app tool name '${tool.name}'`,
        });
      }
      toolNames.add(tool.name);
    }
    const skillEntries = new Set<string>();
    for (const [index, skill] of value.skills.entries()) {
      if (skillEntries.has(skill)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["skills", index],
          message: `duplicate panel app skill entry '${skill}'`,
        });
      }
      skillEntries.add(skill);
    }
  });

const PanelAppManifestFields = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  version: z.string().min(1).max(80),
  title: LocalizedTitle,
  description: z.string().min(1).max(500).optional(),
  entry: SafePanelAppEntry,
  icon: z.enum(PANEL_APP_ICONS).default("panel"),
  placement: z.literal("right-dock").default("right-dock"),
  singleton: z.boolean().default(true),
  permissions: z.array(z.enum(PANEL_APP_PERMISSIONS)).max(16).default([]),
} as const;

/**
 * Schema v2 keeps one installable Panel App identity while allowing it to
 * declare a narrow Agent surface. UI code still runs in the sandboxed panel;
 * tool handlers are invoked through the host bridge, and bundled skills are
 * read-only prompt resources rather than executable plugin code.
 */
export const PanelAppManifest = z
  .discriminatedUnion("schemaVersion", [
    z
      .object({
        schemaVersion: z.literal(1),
        ...PanelAppManifestFields,
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(2),
        ...PanelAppManifestFields,
        agent: PanelAppAgentContribution.optional(),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    const permissionSet = new Set(value.permissions);
    if (permissionSet.size !== value.permissions.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["permissions"],
        message: "panel app permissions must not contain duplicates",
      });
    }
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
    if (
      (value.permissions.includes("workspace.read") ||
        value.permissions.includes("workspace.write") ||
        value.permissions.includes("audio.transcribe")) &&
      !value.permissions.includes("context.workspace")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["permissions"],
        message: "workspace.read, workspace.write, and audio.transcribe require context.workspace",
      });
    }
    if (
      value.permissions.includes("automations.manage") &&
      (!value.permissions.includes("context.session") ||
        !value.permissions.includes("context.workspace"))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["permissions"],
        message: "automations.manage requires context.session and context.workspace",
      });
    }
  });

export type PanelAppAgentTool = z.infer<typeof PanelAppAgentTool>;
export type PanelAppAgentContribution = z.infer<typeof PanelAppAgentContribution>;
export type PanelAppManifest = z.infer<typeof PanelAppManifest>;
