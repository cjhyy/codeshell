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

export interface PanelSnapshot {
  panels: ManagedPanel[];
  workspace: string;
  hasProject: boolean;
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

export interface PanelOperationContext {
  ownerId: string;
  authorize: () => boolean | Promise<boolean>;
}
