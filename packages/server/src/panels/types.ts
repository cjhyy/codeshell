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
}

/** Trusted native hosts may review local sources without exposing paths to Web routes. */
export interface PanelProjectReview extends Omit<PanelReview, "source"> {
  installedVersion?: string;
}

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
