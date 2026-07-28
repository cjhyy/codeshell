import { z } from "zod";

export const PANEL_APP_MANIFEST_FILE = ".codeshell-panel/panel.json";

export const PANEL_APP_PERMISSIONS = [
  "context.session",
  "context.workspace",
  "storage",
  "external.open",
  "agent.submitPrompt",
  "workspace.info",
  "workspace.read",
  "workspace.write",
  "notifications.send",
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

const LocalizedTitle = z
  .object({
    default: z.string().min(1).max(80),
    en: z.string().min(1).max(80).optional(),
    "zh-CN": z.string().min(1).max(80).optional(),
  })
  .strict();

/**
 * A Panel App is a Desktop application package, not an agent plugin. It has
 * one app identity and one sandboxed entry point; skills/MCP/hooks are not part
 * of this manifest or installation system.
 */
export const PanelAppManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    version: z.string().min(1).max(80),
    title: LocalizedTitle,
    description: z.string().min(1).max(500).optional(),
    entry: SafePanelAppEntry,
    icon: z.enum(PANEL_APP_ICONS).default("panel"),
    placement: z.literal("right-dock").default("right-dock"),
    singleton: z.boolean().default(true),
    permissions: z.array(z.enum(PANEL_APP_PERMISSIONS)).max(8).default([]),
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
    if (
      (value.permissions.includes("workspace.read") ||
        value.permissions.includes("workspace.write")) &&
      !value.permissions.includes("context.workspace")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["permissions"],
        message: "workspace.read and workspace.write require context.workspace",
      });
    }
  });

export type PanelAppManifest = z.infer<typeof PanelAppManifest>;
