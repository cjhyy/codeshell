import {
  externalSessionCwdEnabled,
  normalizeExternalSessionCwd,
  type ExternalSessionDiscoveryScope,
  type RecentExternalSession,
} from "@cjhyy/code-shell-capability-coding/orchestration";
import type { ExternalCli } from "./external-session-adapter.js";

export type ExternalSessionVisibilityKey =
  | "showExternalCodexSessions"
  | "showExternalClaudeSessions";

type SettingsRecord = Record<string, unknown> | null | undefined;
type OverrideState = "inherit" | "on" | "off";

const VISIBILITY_KEYS: Record<ExternalCli, ExternalSessionVisibilityKey> = {
  codex: "showExternalCodexSessions",
  claude: "showExternalClaudeSessions",
};

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function projectOverride(
  settings: SettingsRecord,
  key: ExternalSessionVisibilityKey,
): OverrideState | undefined {
  const capabilityOverrides = objectOf(settings?.capabilityOverrides);
  const pet = objectOf(capabilityOverrides.pet);
  const value = pet[key];
  return value === "on" || value === "off" || value === "inherit" ? value : undefined;
}

/** Fold one project's tri-state Pet override over the user/global baseline. */
export function resolveExternalSessionVisibility(
  cli: ExternalCli,
  userSettings: SettingsRecord,
  projectSettings?: SettingsRecord,
): boolean {
  const key = VISIBILITY_KEYS[cli];
  const baseline = objectOf(userSettings?.pet)[key] === true;
  const override = projectOverride(projectSettings, key);
  if (override === "on") return true;
  if (override === "off") return false;
  return baseline;
}

/** Only visibility writes need to rescan/stop the live external-session sources. */
export function touchesExternalSessionVisibility(
  scope: "user" | "project",
  patch: SettingsRecord,
): boolean {
  if (scope === "user") {
    const pet = objectOf(patch?.pet);
    return Object.values(VISIBILITY_KEYS).some((key) => key in pet);
  }
  const overrides = objectOf(patch?.capabilityOverrides);
  const pet = objectOf(overrides.pet);
  return Object.values(VISIBILITY_KEYS).some((key) => key in pet);
}

export interface ControlledExternalSessionAdapter {
  start(): void;
  stop(): void;
  scanOnce(): Promise<void>;
}

export interface ExternalSessionVisibilityControllerOptions {
  readUserSettings: () => SettingsRecord;
  readProjectSettings: (cwd: string) => SettingsRecord;
  listProjectCwds: () => Promise<string[]>;
  createAdapter: (
    cli: ExternalCli,
    getDiscoveryScope: () => ExternalSessionDiscoveryScope,
    includeSession: (session: RecentExternalSession) => boolean,
  ) => ControlledExternalSessionAdapter;
  onSourceDisabled?: (cli: ExternalCli) => void;
  onReconcileError?: (cli: ExternalCli, error: unknown) => void;
}

/**
 * Owns the source-level lifecycle for Codex and Claude session adapters.
 *
 * A source is not constructed at all when both the global baseline and every
 * known project are disabled. Once running, records are admitted only when the
 * setting resolved for their own cwd is enabled, so an overridden-off project
 * is removed before the adapter starts tailing its transcript.
 */
export class ExternalSessionVisibilityController {
  private readonly adapters = new Map<ExternalCli, ControlledExternalSessionAdapter>();
  private readonly discoveryScopes = new Map<ExternalCli, ExternalSessionDiscoveryScope>();
  private reconcileTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: ExternalSessionVisibilityControllerOptions) {}

  reconcile(): Promise<void> {
    const next = this.reconcileTail.catch(() => {}).then(() => this.reconcileNow());
    this.reconcileTail = next;
    return next;
  }

  shutdown(): void {
    this.disposed = true;
    for (const adapter of this.adapters.values()) adapter.stop();
    this.adapters.clear();
  }

  private safeUserSettings(): SettingsRecord {
    try {
      return this.options.readUserSettings();
    } catch {
      return {};
    }
  }

  private safeProjectSettings(cwd: string): SettingsRecord {
    try {
      return this.options.readProjectSettings(cwd);
    } catch {
      return {};
    }
  }

  private discoveryScope(cli: ExternalCli): ExternalSessionDiscoveryScope {
    return (
      this.discoveryScopes.get(cli) ?? {
        includeUnregistered: false,
        projectRoots: [],
      }
    );
  }

  private async reconcileNow(): Promise<void> {
    if (this.disposed) return;
    const userSettings = this.safeUserSettings();
    const projectCwds = [
      ...new Set(
        (await this.options.listProjectCwds().catch(() => [])).map((cwd) =>
          normalizeExternalSessionCwd(cwd),
        ),
      ),
    ];
    const projectSettings = new Map(
      projectCwds.map((cwd) => [cwd, this.safeProjectSettings(cwd)] as const),
    );
    if (this.disposed) return;

    for (const cli of ["codex", "claude"] as const) {
      const scope: ExternalSessionDiscoveryScope = {
        includeUnregistered: resolveExternalSessionVisibility(cli, userSettings),
        projectRoots: projectCwds.map((cwd) => ({
          cwd,
          enabled: resolveExternalSessionVisibility(cli, userSettings, projectSettings.get(cwd)),
        })),
      };
      this.discoveryScopes.set(cli, scope);
      const sourceEnabled =
        scope.includeUnregistered || scope.projectRoots.some((root) => root.enabled);
      const running = this.adapters.get(cli);

      if (sourceEnabled && !running) {
        const adapter = this.options.createAdapter(
          cli,
          () => this.discoveryScope(cli),
          (session) => externalSessionCwdEnabled(session.cwd, this.discoveryScope(cli)),
        );
        this.adapters.set(cli, adapter);
        adapter.start();
      } else if (!sourceEnabled && running) {
        running.stop();
        this.adapters.delete(cli);
        this.options.onSourceDisabled?.(cli);
      } else if (sourceEnabled && running) {
        // Apply a project override immediately instead of waiting for the next
        // periodic scan. scanOnce also purges records that just became hidden,
        // but a settings:set IPC must not wait for a full ~/.codex scan.
        void running.scanOnce().catch((error) => this.options.onReconcileError?.(cli, error));
      }
    }
  }
}
