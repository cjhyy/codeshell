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
  /** The Session this context is built for; absent for legacy callers. */
  session?: {
    id: string;
    kind?: string;
    profileId?: string;
    isSubAgent: boolean;
  };
  /** This run's behavior-profile parameters. In-process providers only. */
  runParams?: Readonly<Record<string, unknown>>;
}

/**
 * Capability context that is its own section of the context ledger rather
 * than part of the shared capability text.
 */
export interface CapabilityDynamicContextSection {
  /** Lower-case letters, digits and dashes; the ledger key is `capability-<key>`. */
  key: string;
  /** Whole-text sections only; a list section's text is built from its parts. */
  text?: string;
  /**
   * A list section: one entry per item, so an update sends only the entries
   * that were added, replaced or removed. `header` and `footer` frame them.
   */
  items?: readonly { id: string; text: string; label?: string }[];
  header?: string;
  footer?: string;
  /**
   * "snapshot-only": a point-in-time snapshot (a git status, say). It is shown
   * when the context is sent whole and never updated afterwards, so its text
   * must say that it is a snapshot that will not update.
   * "ids" (list sections): a ranked or windowed view. Compared by entry id
   * only, so an entry's row is never resent while it stays; `knownIds` lists
   * every entry that still exists, shown or not.
   * Without either, a changed section is updated: entries for a list, the
   * whole text otherwise.
   */
  compare?: "snapshot-only" | "ids";
  knownIds?: readonly string[];
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
