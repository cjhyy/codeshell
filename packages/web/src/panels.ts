import type {
  GitPanelAppDiscoveryCandidate,
  GitPanelAppDiscoveryIssue,
  PanelAppPreview,
} from "@cjhyy/code-shell-core";

export interface PanelCompatibility {
  supported: boolean;
  reasons: string[];
}

export interface PanelGitSource {
  kind: "git";
  url: string;
  /** The original branch/tag, retained separately from the pinned archive commit. */
  ref: string;
  subdir?: string;
  commit: string;
}

export interface ManagedPanel extends Omit<
  PanelAppPreview,
  "reviewToken" | "alreadyInstalled" | "warnings" | "source"
> {
  packageDigest?: string;
  revision: string;
  bound: boolean;
  enabled: boolean;
  globalDisabled: boolean;
  updatable: boolean;
  source: {
    kind: "git" | "local";
    label: string;
    url?: string;
    ref?: string;
    commit?: string;
    subdir?: string;
  };
  compatibility: PanelCompatibility;
}

export interface PanelPackageIssue {
  id: string;
  revision: string;
  code: "package_unavailable";
  version?: string;
  packageDigest?: string;
  bound: boolean;
  globalDisabled: boolean;
}

export interface PanelSnapshot {
  panels: ManagedPanel[];
  issues?: PanelPackageIssue[];
  workspace: string;
  hasProject: boolean;
  canRestorePackages?: boolean;
}

export interface PanelDiscovery {
  panels: GitPanelAppDiscoveryCandidate[];
  issues: GitPanelAppDiscoveryIssue[];
  source: PanelGitSource;
}

export interface PanelReview {
  reviewToken: string;
  expiresAt: number;
  kind: "install" | "update";
  preview: Omit<PanelAppPreview, "reviewToken">;
  source: PanelGitSource;
  expectedRevision: string | null;
  compatibility: PanelCompatibility;
  /** The installed package selected for this project, when its manifest is available. */
  installedVersion?: string;
  /** Reviewed permissions of that same installed package; an empty array is a known baseline. */
  installedPermissions?: PanelAppPreview["permissions"];
}

/** Trusted native hosts may review local sources without exposing paths to Web routes. */
export type PanelProjectReview = Omit<PanelReview, "source">;

export interface PanelOperationContext {
  ownerId: string;
  authorize: () => boolean | Promise<boolean>;
}

export interface PanelPackageVersion {
  version: string;
  packageDigest: string;
  permissions: PanelAppPreview["permissions"];
  compatibility: PanelCompatibility;
}
export interface PanelPackageHistory {
  appId: string;
  title: PanelAppPreview["title"];
  expectedRevision: string;
  current: { version: string; packageDigest?: string; unavailable?: boolean };
  versions: PanelPackageVersion[];
  unavailablePackages: number;
}
export interface PanelPackageRestoreReview extends PanelPackageVersion {
  appId: string;
  title: PanelAppPreview["title"];
  current: PanelPackageHistory["current"];
  addedPermissions: PanelAppPreview["permissions"];
  expectedRevision: string;
  reviewToken: string;
  expiresAt: number;
}

/** Bounded, domain-neutral requests for the trusted browser's recording chooser. */
export const panelVideoLimits = Object.freeze({
  maxDurationSeconds: 1200,
  maxBytes: 200 * 1024 * 1024,
  defaultDurationSeconds: 300,
  defaultBytes: 64 * 1024 * 1024,
});

export interface PanelVideoOptions {
  source: "camera" | "screen";
  microphone: boolean;
  systemAudio: boolean;
  maxDurationSeconds: number;
  maxBytes: number;
}

export function panelVideoOptions(raw: unknown): PanelVideoOptions {
  const value = raw as Record<string, unknown> | null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        !["source", "microphone", "systemAudio", "maxDurationSeconds", "maxBytes"].includes(key),
    ) ||
    (value.source !== "camera" && value.source !== "screen") ||
    (value.microphone !== undefined && typeof value.microphone !== "boolean") ||
    (value.systemAudio !== undefined && typeof value.systemAudio !== "boolean") ||
    (value.source !== "screen" && value.systemAudio === true)
  )
    throw new Error("视频录制请求无效。");
  const maxDurationSeconds = value.maxDurationSeconds ?? panelVideoLimits.defaultDurationSeconds;
  const maxBytes = value.maxBytes ?? panelVideoLimits.defaultBytes;
  if (
    !Number.isSafeInteger(maxDurationSeconds) ||
    Number(maxDurationSeconds) < 1 ||
    Number(maxDurationSeconds) > panelVideoLimits.maxDurationSeconds ||
    !Number.isSafeInteger(maxBytes) ||
    Number(maxBytes) < 1 ||
    Number(maxBytes) > panelVideoLimits.maxBytes
  )
    throw new Error("视频录制限制无效。");
  return {
    source: value.source as "camera" | "screen",
    microphone: value.microphone !== false,
    systemAudio: value.systemAudio === true,
    maxDurationSeconds: Number(maxDurationSeconds),
    maxBytes: Number(maxBytes),
  };
}
