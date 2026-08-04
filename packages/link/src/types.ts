export interface LinkLocalizedText {
  zh: string;
  en: string;
}

export type LinkProviderCategory = "developer" | "communication" | "work" | "design";
export type LinkProviderIcon = "github" | "figma" | "notes" | "conversation";
export type LinkProviderAccent =
  | "neutral"
  | "orange"
  | "rose"
  | "violet"
  | "fuchsia"
  | "indigo"
  | "red"
  | "amber";
export type LinkExecutionRuntime = "local" | "server";
export type LinkSecretLocation = "device" | "server";
export type LinkAuthKind = "token" | "oauth";
export type LinkMethodAvailability = "available" | "coming-soon";
export type LinkPermissionLevel = "required" | "optional";

/**
 * A provider-owned CLI login that Link can bind to without exporting or
 * copying the provider token. The host is responsible for allowlisting the
 * command and arguments; manifests are presentation metadata only.
 */
export interface LinkCliSessionAuth {
  kind: "cli-session";
  command: string;
  displayName: LinkLocalizedText;
  summary: LinkLocalizedText;
  installUrl: string;
  privacyNote: LinkLocalizedText;
}

/**
 * A provider-hosted login that a desktop host can complete without a local
 * CLI or Link Server. Client IDs are host configuration and are deliberately
 * not embedded in the portable manifest.
 */
export interface LinkBrowserAuth {
  kind: "browser-oauth";
  flow: "device-code" | "authorization-code-pkce";
  displayName: LinkLocalizedText;
  summary: LinkLocalizedText;
  docsUrl: string;
  privacyNote: LinkLocalizedText;
}

export interface LinkPermissionGuide {
  id: string;
  label: string;
  level: LinkPermissionLevel;
  description?: LinkLocalizedText;
}

export interface LinkAuthGuide {
  title: LinkLocalizedText;
  summary: LinkLocalizedText;
  createCredentialUrl: string;
  docsUrl: string;
  permissions: LinkPermissionGuide[];
  steps: LinkLocalizedText[];
  note?: LinkLocalizedText;
}

export interface LinkConnectionMethodManifest {
  id: string;
  displayName: LinkLocalizedText;
  executionRuntime: LinkExecutionRuntime;
  secretLocation: LinkSecretLocation;
  authKind: LinkAuthKind;
  availability: LinkMethodAvailability;
  oauthProfileId?: string;
  tokenLabel?: string;
  tokenPlaceholder?: string;
  authGuide?: LinkAuthGuide;
  /** Preferred provider-hosted login when the desktop host has a public client id. */
  browserAuth?: LinkBrowserAuth;
  /** Optional zero-copy local login shown before the manual-token fallback. */
  quickAuth?: LinkCliSessionAuth;
}

/**
 * Serializable provider metadata shared by local executors, a future Link server,
 * and host UIs. It deliberately contains no CodeShell or framework dependency.
 */
export interface LinkProviderManifest {
  id: string;
  displayName: string;
  category: LinkProviderCategory;
  description: LinkLocalizedText;
  brandText: string;
  icon: LinkProviderIcon;
  accent: LinkProviderAccent;
  featured?: boolean;
  connectionMethods: LinkConnectionMethodManifest[];
  actionIds: string[];
}
