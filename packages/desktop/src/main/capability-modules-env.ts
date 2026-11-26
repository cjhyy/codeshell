/** Build the capability list afresh for each Desktop worker spawn. */
import {
  SettingsManager,
  isFeatureEnabled,
  type FeatureFlagOverrides,
} from "@cjhyy/code-shell-core/extension";

export interface CoreCapabilityModuleUrls {
  readonly coding: string;
  readonly pet: string;
  readonly links?: string;
}

/** Resolve optional capabilities only after their user-level flag is enabled. */
export function composeCapabilityModulesEnv(
  urls: CoreCapabilityModuleUrls,
  flags: FeatureFlagOverrides,
  resolveOptimizationLab: () => string,
): string {
  const entries = [`${urls.coding}#createCodingModule`, `${urls.pet}#createPetModule`];
  if (urls.links) entries.push(`${urls.links}#createLinkProviderModule`);
  if (isFeatureEnabled(flags, "optimization_lab")) {
    entries.push(`${resolveOptimizationLab()}#createOptimizationLabModule`);
  }
  return entries.join(",");
}

/** Worker-wide module switches for one Desktop worker spawn. */
export interface WorkerModuleEnv {
  CODE_SHELL_CAPABILITY_MODULES: string;
  /** Always present, so a value inherited from a shell is cleared when the flag is off. */
  CODE_SHELL_NATIVE_PLUGINS: "host" | undefined;
}

/** The capability list plus whether approved native plugins load in this worker. */
export function composeWorkerModuleEnv(
  urls: CoreCapabilityModuleUrls,
  flags: FeatureFlagOverrides,
  resolveOptimizationLab: () => string,
): WorkerModuleEnv {
  return {
    CODE_SHELL_CAPABILITY_MODULES: composeCapabilityModulesEnv(urls, flags, resolveOptimizationLab),
    CODE_SHELL_NATIVE_PLUGINS: isFeatureEnabled(flags, "native_plugins") ? "host" : undefined,
  };
}

/** Matches main/index.ts: worker-wide module flags come only from user settings. */
export function readUserFeatureFlags(cwd: string): FeatureFlagOverrides {
  return new SettingsManager(cwd, "full").getForScope("user").featureFlags ?? {};
}
