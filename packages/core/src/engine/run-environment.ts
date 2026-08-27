import type { CredentialAccess } from "../credentials/access.js";
import {
  expandPath,
  resolveSandboxBackend,
  type SandboxBackend,
  type SandboxConfig,
} from "../tool-system/sandbox/index.js";
import { resolveSandboxConfig, type SettingsSandbox } from "./sandbox-config.js";
import { sandboxCacheKey } from "./sandbox-cache-key.js";
import type { EngineRuntime } from "./runtime.js";
import type { EngineConfig } from "./types.js";
import { canonicalKey, canonicalPath } from "../workspace/canonical-key.js";
import type { WorkspaceContext } from "../workspace/workspace-context.js";

type EnvironmentSettings = {
  get(): unknown;
  getForScope(scope: "user" | "project", cwd?: string): unknown;
};

export interface RunEnvironmentResolverDeps {
  config: () => EngineConfig;
  settings: () => EnvironmentSettings;
  credentialAccess: Pick<CredentialAccess, "envExposures">;
  runtime?: Pick<EngineRuntime, "resolveSandbox">;
  resolveBackend?: (config: SandboxConfig, cwd: string) => Promise<SandboxBackend>;
}

export interface RunEnvironmentInput {
  cwd: string;
  workspaceContext: WorkspaceContext;
}

function appendWorkspaceRoots(config: SandboxConfig, run: RunEnvironmentInput): SandboxConfig {
  const writableRoots: string[] = [];
  const seen = new Set<string>();
  // Key configured roots after placeholder expansion so `${workspace}` wins
  // over the equivalent primary path. Keep the first spelling and order.
  for (const root of config.writableRoots) {
    const key = canonicalKey(expandPath(root, run.cwd));
    if (seen.has(key)) continue;
    seen.add(key);
    writableRoots.push(root);
  }
  for (const root of run.workspaceContext.roots) {
    const key = canonicalKey(root.path);
    if (seen.has(key)) continue;
    seen.add(key);
    writableRoots.push(canonicalPath(root.path));
  }
  return { ...config, writableRoots };
}

export class RunEnvironmentResolver {
  private readonly sandboxCache = new Map<string, Promise<SandboxBackend>>();
  private readonly resolveBackend: (config: SandboxConfig, cwd: string) => Promise<SandboxBackend>;

  constructor(private readonly deps: RunEnvironmentResolverDeps) {
    this.resolveBackend = deps.resolveBackend ?? resolveSandboxBackend;
  }

  resolveSandboxConfig(run: RunEnvironmentInput): SandboxConfig {
    const { cwd } = run;
    const config = this.deps.config();
    let projectSandbox: SettingsSandbox | undefined;
    let globalSandbox: SettingsSandbox | undefined;
    try {
      const settings = this.deps.settings();
      if (config.isSubAgent !== true) {
        projectSandbox = (settings.getForScope("project", cwd) as { sandbox?: SettingsSandbox })
          .sandbox;
      }
      globalSandbox = (settings.getForScope("user") as { sandbox?: SettingsSandbox }).sandbox;
    } catch {
      // Missing settings fall through to the run default.
    }
    return appendWorkspaceRoots(
      resolveSandboxConfig(config.sandbox, projectSandbox, globalSandbox, config.headless === true),
      run,
    );
  }

  resolveSandbox(run: RunEnvironmentInput): Promise<SandboxBackend> {
    const { cwd } = run;
    const config = this.resolveSandboxConfig(run);
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

  async resolve(run: RunEnvironmentInput): Promise<{
    sandbox: SandboxBackend;
    sandboxConfig: SandboxConfig;
    shellEnv?: Record<string, string>;
  }> {
    const { cwd } = run;
    const sandboxConfig = this.resolveSandboxConfig(run);
    const backend = await this.resolveSandbox(run);
    return {
      sandbox: backend.name === "off" ? backend : { ...backend, network: sandboxConfig.network },
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
}
