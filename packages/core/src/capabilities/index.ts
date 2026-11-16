import type { AgentPreset } from "../preset/index.js";
import type { SandboxBackend } from "../tool-system/sandbox/index.js";
import type { SessionManager } from "../session/session-manager.js";
import type { ArtifactKind, ArtifactRole } from "../run/types.js";
import type { HookEventName } from "../hooks/events.js";
import type { HookHandler } from "../hooks/registry.js";

/**
 * Contribution types shared by AgentModule engine contributions
 * (src/composition/types.ts). The former CapabilityModule interface and its
 * process-global registry were removed in the composition cutover — product
 * packages now ship AgentModule factories compiled at the host root.
 */

export interface CapabilityEngineHookContribution {
  event: HookEventName;
  handler: HookHandler;
  priority?: number;
  name?: string;
}

export interface CapabilityDynamicContext {
  cwd: string;
  workspace: import("../workspace/workspace-context.js").WorkspaceContext;
  preset: AgentPreset;
}

/**
 * Capability context that is its own section of the context ledger rather
 * than part of the shared capability text.
 */
export interface CapabilityDynamicContextSection {
  /** Lower-case letters, digits and dashes; the ledger key is `capability-<key>`. */
  key: string;
  text: string;
  /**
   * "snapshot-only": a point-in-time snapshot (a git status, say). It is shown
   * when the context is sent whole and never updated afterwards, so its text
   * must say that it is a snapshot that will not update. Without it the
   * section is resent whole whenever its text changes.
   */
  compare?: "snapshot-only";
}

export type CapabilityDynamicContextProvider = (
  context: CapabilityDynamicContext,
) =>
  | string
  | CapabilityDynamicContextSection
  | undefined
  | Promise<string | CapabilityDynamicContextSection | undefined>;

export type CapabilityInstructionBoundaryFinder = (cwd: string) => string | null;

/** Generic host services from which a module may build its private tool service. */
export interface CapabilityToolServiceHost {
  readonly isSubAgent: boolean;
  readonly settings: {
    get(): unknown;
    getForScope(scope: "user" | "project", cwd?: string): unknown;
  };
  resolveSandbox(cwd: string): Promise<SandboxBackend>;
  readShellEnv(cwd?: string): Record<string, string> | undefined;
  getSessionManager(): SessionManager;
}

export interface CapabilityArtifact {
  kind: ArtifactKind;
  role: ArtifactRole;
  title: string;
  locator: string;
  metadata?: Record<string, unknown>;
}

export interface CapabilityArtifactDetectionContext {
  toolName: string;
  args: Record<string, unknown>;
  resultText?: string;
}

export type CapabilityArtifactDetector = (
  context: CapabilityArtifactDetectionContext,
) => CapabilityArtifact | readonly CapabilityArtifact[] | undefined;

export interface CapabilityToolSelectionContext {
  preset: string;
  host?: string;
}

export interface SessionWorkspaceCapability {
  validateRoot(root: string): Promise<boolean>;
  branchExists(mainRoot: string, branch: string): Promise<boolean>;
}

export interface CapabilityFileHistoryContribution {
  toolName: string;
  resolveTargets(args: Record<string, unknown>, cwd: string): readonly string[];
  /** All mutation targets, including new files and both sides of a move. */
  resolveDiffTargets?(args: Record<string, unknown>, cwd: string): readonly string[];
}
