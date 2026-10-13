import type { PluginMediaDto } from "../../shared/plugin-media";
import type { PluginHookEntry } from "../../preload/types";

const SAFE_PLUGIN_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u;
const COMPOSER_SVG_PREFIX = "data:image/svg+xml;base64,";
const MAX_COMPOSER_SVG_BASE64 = Math.ceil((2 * 1024 * 1024) / 3) * 4;
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

export function safePluginImageDataUrl(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_PLUGIN_IMAGE_DATA_URL.test(value) ? value : undefined;
}

/** Main validates SVG bytes; this only permits its bounded image transport. */
export function safePluginComposerIconDataUrl(value: unknown): string | undefined {
  const raster = safePluginImageDataUrl(value);
  if (raster) return raster;
  if (typeof value !== "string" || !value.startsWith(COMPOSER_SVG_PREFIX)) return undefined;
  const base64 = value.slice(COMPOSER_SVG_PREFIX.length);
  if (
    !base64.length ||
    base64.length > MAX_COMPOSER_SVG_BASE64 ||
    base64.length % 4 ||
    !CANONICAL_BASE64.test(base64)
  )
    return undefined;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  if ((base64.length / 4) * 3 - padding > 2 * 1024 * 1024) return undefined;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const last = alphabet.indexOf(base64[base64.length - padding - 1]);
  if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) return undefined;
  return value;
}

export function pluginLogoSources(media: PluginMediaDto | null | undefined): {
  light?: string;
  dark?: string;
} {
  const composerIcon = safePluginComposerIconDataUrl(media?.composerIconDataUrl);
  const darkLogo = safePluginImageDataUrl(media?.logoDarkDataUrl);
  const light = safePluginImageDataUrl(media?.logoDataUrl) ?? composerIcon ?? darkLogo;
  const dark = darkLogo ?? light;
  return { light, dark };
}

export function pluginScreenshotDataUrls(media: PluginMediaDto | null | undefined): string[] {
  return (media?.screenshotDataUrls ?? [])
    .map(safePluginImageDataUrl)
    .filter((value): value is string => typeof value === "string")
    .slice(0, 3);
}

export function shouldLoadPluginListMedia(mediaAvailability: {
  composerIcon: boolean;
  logo: boolean;
  logoDark: boolean;
}): boolean {
  return mediaAvailability.logo || mediaAvailability.logoDark || mediaAvailability.composerIcon;
}

export type PluginHookApprovalSummary = "approved" | "pending" | "changed" | "legacy";

export function summarizePluginHookApproval(
  hooks: Pick<PluginHookEntry, "approval">[],
): PluginHookApprovalSummary | null {
  const executable = hooks.filter((hook) => hook.approval !== "none");
  if (executable.length === 0) return null;
  if (executable.some((hook) => hook.approval === "changed")) return "changed";
  if (executable.some((hook) => hook.approval === "pending")) return "pending";
  if (executable.some((hook) => hook.approval === "legacy")) return "legacy";
  return "approved";
}

export async function changePluginHookApproval(
  api: Pick<Window["codeshell"], "approvePluginHooks" | "revokePluginHooks">,
  action: "approve" | "revoke",
  installKey: string,
): Promise<void> {
  if (action === "approve") await api.approvePluginHooks(installKey);
  else await api.revokePluginHooks(installKey);
}

export async function changePluginMcpApproval(
  api: Pick<Window["codeshell"], "approvePluginMcp" | "revokePluginMcp">,
  action: "approve" | "revoke",
  installKey: string,
): Promise<void> {
  if (action === "approve") await api.approvePluginMcp(installKey);
  else await api.revokePluginMcp(installKey);
}

export type PluginLegalLinkKind = "website" | "privacy" | "terms";

export function pluginLegalLinks(metadata: {
  websiteURL?: string;
  privacyPolicyURL?: string;
  termsOfServiceURL?: string;
}): Array<{ kind: PluginLegalLinkKind; url: string }> {
  const values: Array<[PluginLegalLinkKind, string | undefined]> = [
    ["website", metadata.websiteURL],
    ["privacy", metadata.privacyPolicyURL],
    ["terms", metadata.termsOfServiceURL],
  ];
  return values.flatMap(([kind, value]) => {
    if (!value) return [];
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname && !url.username && !url.password
        ? [{ kind, url: value }]
        : [];
    } catch {
      return [];
    }
  });
}
