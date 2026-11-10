import type { Engine } from "../engine/engine.js";

type EngineMethodName = {
  [Key in keyof Engine]: Engine[Key] extends (...args: never[]) => unknown ? Key : never;
}[keyof Engine];

// Fixtures may return partial registries/results or explicitly omit a capability.
// Provided method implementations must be callable.
type FakeEngineOverrides = {
  [Key in keyof Engine]?: Engine[Key] extends (...args: never[]) => unknown
    ? (...args: never[]) => unknown
    : Engine[Key];
};

type FakeEngineDefaults = {
  [Key in EngineMethodName]: Engine[Key];
};

function unexpected(method: EngineMethodName): () => never {
  return () => {
    throw new Error(`Unexpected fake Engine.${method}() call; provide an override`);
  };
}

// A static, exhaustive method table makes new Engine setters a one-file change.
// Do not use a Proxy: unknown properties (especially then) must stay undefined.
const defaults = {
  getLoadedInstructionSnapshots: unexpected("getLoadedInstructionSnapshots"),
  reloadHooks: unexpected("reloadHooks"),
  ready: unexpected("ready"),
  reloadModelPool: unexpected("reloadModelPool"),
  registerCustomTool: unexpected("registerCustomTool"),
  queryCapability: unexpected("queryCapability"),
  setAskUser: () => {},
  setAskUserAsync: () => {},
  setAgentControlStateListener: () => {},
  setAgentDirectionsDeliveredListener: () => {},
  setBrowserBridge: () => {},
  setChildHostBindings: () => {},
  setWorkspaceBridge: () => {},
  setPanelBridge: () => {},
  setSessionMessageRouter: () => {},
  enqueueSteer: unexpected("enqueueSteer"),
  unsteer: unexpected("unsteer"),
  setInjectCredential: () => {},
  isHeadless: () => true,
  sessionExistsOnDisk: unexpected("sessionExistsOnDisk"),
  forkSession: unexpected("forkSession"),
  selectContextPackage: unexpected("selectContextPackage"),
  createSummaryFork: unexpected("createSummaryFork"),
  summarizeContextPackage: unexpected("summarizeContextPackage"),
  restoreSessionModel: unexpected("restoreSessionModel"),
  run: unexpected("run"),
  getToolRegistry: unexpected("getToolRegistry"),
  getRuntimeToolRegistry: unexpected("getRuntimeToolRegistry"),
  resolveModelEntry: unexpected("resolveModelEntry"),
  switchModel: unexpected("switchModel"),
  resetSessionUsage: unexpected("resetSessionUsage"),
  getModelPool: unexpected("getModelPool"),
  getCurrentModel: unexpected("getCurrentModel"),
  getHookRegistry: unexpected("getHookRegistry"),
  getSessionManager: unexpected("getSessionManager"),
  getUsageSummary: unexpected("getUsageSummary"),
  recordExternalUsage: unexpected("recordExternalUsage"),
  resolveSessionRunWorkspace: unexpected("resolveSessionRunWorkspace"),
  prepareSessionCloseFinalization: unexpected("prepareSessionCloseFinalization"),
  getConfig: unexpected("getConfig"),
  getComposition: unexpected("getComposition"),
  dispose: unexpected("dispose"),
  refreshRuntimeConfig: unexpected("refreshRuntimeConfig"),
  getGoal: unexpected("getGoal"),
  isGoalContinuationBlocked: unexpected("isGoalContinuationBlocked"),
  canResumeGoalInPlace: unexpected("canResumeGoalInPlace"),
  updateGoal: unexpected("updateGoal"),
  clearGoal: unexpected("clearGoal"),
  setSessionWorkspace: () => null,
  migrateSessionMainRoot: unexpected("migrateSessionMainRoot"),
  releaseSessionWorkspace: unexpected("releaseSessionWorkspace"),
  injectContext: unexpected("injectContext"),
  forceCompact: unexpected("forceCompact"),
  archiveTurnRange: unexpected("archiveTurnRange"),
  appendArchiveMarker: unexpected("appendArchiveMarker"),
  updateConfig: unexpected("updateConfig"),
  readSetting: unexpected("readSetting"),
  setPermissionMode: () => {},
  getPermissionMode: unexpected("getPermissionMode"),
  extendGoalRun: unexpected("extendGoalRun"),
  getPermissionRules: unexpected("getPermissionRules"),
  setPlanMode: () => {},
  buildToolContext: unexpected("buildToolContext"),
  getEffectiveDisabledLists: unexpected("getEffectiveDisabledLists"),
  getFeatureFlags: unexpected("getFeatureFlags"),
} satisfies FakeEngineDefaults;

/**
 * Internal test helper. Overrides retain extra fixture-specific state while
 * Engine methods keep their public types. The single nominal Engine cast is
 * centralized here, never in protocol tests.
 * No Engine or composition runtime is imported or constructed.
 */
export function createFakeEngine<Overrides extends FakeEngineOverrides = Record<never, never>>(
  overrides?: Overrides,
): Engine & Omit<Overrides, keyof Engine> {
  return { ...defaults, ...overrides } as unknown as Engine & Omit<Overrides, keyof Engine>;
}
