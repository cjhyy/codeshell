export interface PluginDisplayMetadata {
  displayName: string;
  description?: string;
  longDescription?: string;
  developerName?: string;
  category?: string;
  capabilities?: string[];
  websiteURL?: string;
  privacyPolicyURL?: string;
  termsOfServiceURL?: string;
  defaultPrompt?: string[];
  brandColor?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalTextList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return strings.length > 0 ? strings : undefined;
}

function optionalHttpsUrl(value: unknown): string | undefined {
  const text = optionalText(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password
      ? text
      : undefined;
  } catch {
    return undefined;
  }
}

/** Normalize trusted canonical or best-effort legacy author metadata for UI. */
export function normalizePluginDisplayMetadata(
  name: string,
  manifestValue: unknown,
): PluginDisplayMetadata {
  const manifest = record(manifestValue);
  const metadata = record(manifest.interface);
  const brandColor =
    typeof metadata.brandColor === "string" && /^#[0-9a-fA-F]{6}$/.test(metadata.brandColor)
      ? metadata.brandColor
      : undefined;
  return {
    displayName: optionalText(metadata.displayName) ?? name,
    description: optionalText(metadata.shortDescription) ?? optionalText(manifest.description),
    longDescription: optionalText(metadata.longDescription),
    developerName: optionalText(metadata.developerName),
    category: optionalText(metadata.category),
    capabilities: optionalTextList(metadata.capabilities),
    websiteURL: optionalHttpsUrl(metadata.websiteURL),
    privacyPolicyURL: optionalHttpsUrl(metadata.privacyPolicyURL),
    termsOfServiceURL: optionalHttpsUrl(metadata.termsOfServiceURL),
    defaultPrompt: optionalTextList(metadata.defaultPrompt),
    brandColor,
  };
}
