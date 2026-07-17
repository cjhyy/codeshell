import type { PluginMediaDto } from "../../shared/plugin-media";
import type { PluginHookEntry } from "../../preload/types";

const SAFE_PLUGIN_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u;

export function safePluginImageDataUrl(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_PLUGIN_IMAGE_DATA_URL.test(value) ? value : undefined;
}

export function pluginLogoSources(media: PluginMediaDto | null | undefined): {
  light?: string;
  dark?: string;
} {
  const composerIcon = safePluginImageDataUrl(media?.composerIconDataUrl);
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
