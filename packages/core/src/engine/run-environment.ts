import type { CredentialAccess } from "../credentials/access.js";
import {
  resolveSandboxBackend,
  type SandboxBackend,
  type SandboxConfig,
} from "../tool-system/sandbox/index.js";
import { resolveSandboxConfig, type SettingsSandbox } from "./sandbox-config.js";
import { sandboxCacheKey } from "./sandbox-cache-key.js";
import type { EngineRuntime } from "./runtime.js";
import type { EngineConfig } from "./types.js";

type EnvironmentSettings = {
  get(): unknown;
  getForScope(scope: "user" | "project", cwd?: string): unknown;
};
type SetupScripts = { default?: string; macos?: string; linux?: string; windows?: string };

export interface RunEnvironmentResolverDeps {
  config: () => EngineConfig;
  settings: () => EnvironmentSettings;
  credentialAccess: Pick<CredentialAccess, "envExposures">;
  runtime?: Pick<EngineRuntime, "resolveSandbox">;
  resolveBackend?: (config: SandboxConfig, cwd: string) => Promise<SandboxBackend>;
}

export class RunEnvironmentResolver {
  private readonly sandboxCache = new Map<string, Promise<SandboxBackend>>();
  private readonly resolveBackend: (
    config: SandboxConfig,
    cwd: string,
  ) => Promise<SandboxBackend>;

  constructor(private readonly deps: RunEnvironmentResolverDeps) {
    this.resolveBackend = deps.resolveBackend ?? resolveSandboxBackend;
  }

  resolveSandboxConfig(cwd: string): SandboxConfig {
    const config = this.deps.config();
    let projectSandbox: SettingsSandbox | undefined;
    let globalSandbox: SettingsSandbox | undefined;
    try {
      const settings = this.deps.settings();
      if (config.isSubAgent !== true) {
        projectSandbox = (
          settings.getForScope("project", cwd) as { sandbox?: SettingsSandbox }
        ).sandbox;
      }
      globalSandbox = (settings.getForScope("user") as { sandbox?: SettingsSandbox }).sandbox;
    } catch {
      // Missing settings fall through to the run default.
    }
    return resolveSandboxConfig(
      config.sandbox,
      projectSandbox,
      globalSandbox,
      config.headless === true,
    );
  }

  resolveSandbox(cwd: string): Promise<SandboxBackend> {
    const config = this.resolveSandboxConfig(cwd);
    if (this.deps.runtime) return this.deps.runtime.resolveSandbox(config, cwd);

    const key = sandboxCacheKey(config, cwd);
    let cached = this.sandboxCache.get(key);
    if (!cached) {
      cached = this.resolveBackend(config, cwd);
      cached.catch(() => {
        if (this.sandboxCache.get(key) === cached) this.sandboxCache.delete(key);
      });
      this.sandboxCache.set(key, cached);
    }
    return cached;
  }

  async resolve(cwd: string): Promise<{
    sandbox: SandboxBackend;
    sandboxConfig: SandboxConfig;
    shellEnv?: Record<string, string>;
  }> {
    const sandboxConfig = this.resolveSandboxConfig(cwd);
    const backend = await this.resolveSandbox(cwd);
    return {
      sandbox:
        backend.name === "off" ? backend : { ...backend, network: sandboxConfig.network },
      sandboxConfig,
      shellEnv: this.readShellEnv(cwd),
    };
  }

  readShellEnv(cwd?: string): Record<string, string> | undefined {
    if (!cwd) return undefined;
    const config = this.deps.config();
    const merged: Record<string, string> = {};
    const layer = (env: Record<string, string> | undefined) => {
      for (const [key, value] of Object.entries(env ?? {})) {
        if (typeof value === "string") merged[key] = value;
      }
    };
    try {
      const settings = this.deps.settings().get() as {
        env?: Record<string, string>;
        localEnvironment?: { env?: Record<string, string> };
      };
      layer(settings.localEnvironment?.env);
      const scope = (config.settingsScope ?? "project") === "full" ? "full" : "project";
      layer(this.deps.credentialAccess.envExposures(cwd, scope));
      layer(settings.env);
    } catch {
      return undefined;
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  readWorktreeSetupScripts(cwd?: string): SetupScripts | undefined {
    if (this.deps.config().isSubAgent === true || !cwd) return undefined;
    try {
      const scoped = this.deps.settings().getForScope("project", cwd) as {
        localEnvironment?: { setupScripts?: SetupScripts };
      };
      return scoped.localEnvironment?.setupScripts;
    } catch {
      return undefined;
    }
  }

  readWorktreeBranchPrefix(cwd?: string): string | undefined {
    if (this.deps.config().isSubAgent === true || !cwd) return undefined;
    try {
      return (this.deps.settings().get() as { worktree?: { branchPrefix?: string } }).worktree
        ?.branchPrefix;
    } catch {
      return undefined;
    }
  }

  async resolveWorktreeSetupSandbox(cwd: string): Promise<SandboxBackend | undefined> {
    if (!cwd) return undefined;
    const environment = await this.resolve(cwd);
    return environment.sandbox;
  }
}
