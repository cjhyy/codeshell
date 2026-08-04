/**
 * Desktop presentation adapter for the framework-independent Link manifests.
 * Provider content arrives through preload IPC; this module only maps portable
 * icon/accent/category identifiers onto renderer presentation primitives.
 */
import type { TranslationKey } from "../i18n";
import type { LocalLinkProviderView } from "../../preload/types";

export type LinkExecutionRuntime = "local" | "server";

export interface LinkAuthGuide {
  title: string;
  summary: string;
  createCredentialUrl: string;
  docsUrl: string;
  permissions: Array<{
    id: string;
    label: string;
    level: "required" | "optional";
    description?: string;
  }>;
  steps: string[];
  note?: string;
}

export interface LinkConnectionMethod {
  id: string;
  displayName: string;
  executionRuntime: LinkExecutionRuntime;
  secretLocation: "device" | "server";
  authKind: "token" | "oauth";
  availability: "available" | "coming-soon";
  oauthProfileId?: string;
  tokenLabel?: string;
  tokenPlaceholder?: string;
  authGuide?: LinkAuthGuide;
  quickAuth?: {
    kind: "cli-session";
    command: string;
    displayName: string;
    summary: string;
    installUrl: string;
    privacyNote: string;
  };
  browserAuth?: {
    kind: "browser-oauth";
    flow: "device-code" | "authorization-code-pkce";
    displayName: string;
    summary: string;
    docsUrl: string;
    privacyNote: string;
  };
}

export interface LinkIntegration {
  id: string;
  name: string;
  description: string;
  brandText: string;
  icon: "github" | "figma" | "notes" | "conversation";
  brandClass: string;
  featured?: boolean;
  connectionMethods: LinkConnectionMethod[];
}

export interface LinkCategory {
  id: LocalLinkProviderView["category"];
  titleKey: TranslationKey;
  items: LinkIntegration[];
}

const CATEGORY_ORDER: LocalLinkProviderView["category"][] = [
  "developer",
  "communication",
  "work",
  "design",
];

const CATEGORY_TITLE_KEYS: Record<LocalLinkProviderView["category"], TranslationKey> = {
  developer: "ext.link.catDeveloper",
  communication: "ext.link.catCommunication",
  work: "ext.link.catWork",
  design: "ext.link.catDesign",
};

const ACCENT_CLASSES: Record<LocalLinkProviderView["accent"], string> = {
  neutral: "bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950",
  orange: "bg-orange-500/12 text-orange-600 dark:text-orange-400",
  rose: "bg-rose-500/12 text-rose-600 dark:text-rose-400",
  violet: "bg-violet-500/12 text-violet-600 dark:text-violet-400",
  fuchsia: "bg-fuchsia-500/12 text-fuchsia-600 dark:text-fuchsia-400",
  indigo: "bg-indigo-500/12 text-indigo-600 dark:text-indigo-400",
  red: "bg-red-500/12 text-red-600 dark:text-red-400",
  amber: "bg-amber-500/12 text-amber-600 dark:text-amber-400",
};

export function buildLinkCatalog(
  providers: LocalLinkProviderView[],
  language: "zh" | "en",
): LinkCategory[] {
  return CATEGORY_ORDER.map((category) => ({
    id: category,
    titleKey: CATEGORY_TITLE_KEYS[category],
    items: providers
      .filter((provider) => provider.category === category)
      .map((provider) => ({
        id: provider.id,
        name: provider.displayName,
        description: provider.description[language],
        brandText: provider.brandText,
        icon: provider.icon,
        brandClass: ACCENT_CLASSES[provider.accent],
        featured: provider.featured,
        connectionMethods: provider.connectionMethods.map((method) => ({
          ...method,
          displayName: method.displayName[language],
          authGuide: method.authGuide
            ? {
                ...method.authGuide,
                title: method.authGuide.title[language],
                summary: method.authGuide.summary[language],
                permissions: method.authGuide.permissions.map((permission) => ({
                  ...permission,
                  description: permission.description?.[language],
                })),
                steps: method.authGuide.steps.map((step) => step[language]),
                note: method.authGuide.note?.[language],
              }
            : undefined,
          quickAuth: method.quickAuth
            ? {
                ...method.quickAuth,
                displayName: method.quickAuth.displayName[language],
                summary: method.quickAuth.summary[language],
                privacyNote: method.quickAuth.privacyNote[language],
              }
            : undefined,
          browserAuth: method.browserAuth
            ? {
                ...method.browserAuth,
                displayName: method.browserAuth.displayName[language],
                summary: method.browserAuth.summary[language],
                privacyNote: method.browserAuth.privacyNote[language],
              }
            : undefined,
        })),
      })),
  })).filter((category) => category.items.length > 0);
}
