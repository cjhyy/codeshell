export * from "./types.js";
export { LifetimeScope } from "./lifetime.js";
export type { ModuleScopeKind, Disposable, DisposableLike, Dispose } from "./lifetime.js";
export { CORE_AGENT_MODULE } from "./core-module.js";
export { compileComposition } from "./compiler.js";
export { toCompositionSnapshot, computeCompositionDigest } from "./snapshot.js";
export {
  compositionPromptSections,
  compositionToolCatalog,
  presetInjectedTools,
  registerAlwaysTools,
  resolveCompositionInstructionBoundary,
  resolvePresetFromComposition,
} from "./resolve-preset.js";
