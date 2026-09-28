/** Build the capability list afresh for each Desktop worker spawn. */
import {
  SettingsManager,
  isFeatureEnabled,
  type FeatureFlagOverrides,
} from "@cjhyy/code-shell-core/extension";

export interface CoreCapabilityModuleUrls {
  readonly coding: string;
  readonly arena: string;
  readonly pet: string;
}

/** Resolve optional capabilities only after their user-level flag is enabled. */
export function composeCapabilityModulesEnv(
  urls: CoreCapabilityModuleUrls,
  flags: FeatureFlagOverrides,
  resolveOptimizationLab: () => string,
): string {
  const entries = [
    `${urls.coding}#createCodingModule`,
    `${urls.arena}#createArenaModule`,
    `${urls.pet}#createPetModule`,
  ];
  if (isFeatureEnabled(flags, "optimization_lab")) {
    entries.push(`${resolveOptimizationLab()}#createOptimizationLabModule`);
  }
  return entries.join(",");
}

/** Matches main/index.ts: worker-wide module flags come only from user settings. */
export function readUserFeatureFlags(cwd: string): FeatureFlagOverrides {
  return new SettingsManager(cwd, "full").getForScope("user").featureFlags ?? {};
}
