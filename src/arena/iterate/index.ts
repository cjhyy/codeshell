/**
 * Arena Iterate — multi-model authoring loop.
 *
 * Public API for the iterate mode.
 */

export { IterativeArena } from "./iterative-arena.js";
export { defaultConvergence, diffRatio } from "./convergence.js";
export { codeFormat, documentFormat, getFormat } from "./formats/index.js";
export type { FormatPack } from "./formats/index.js";
export type {
  AuthorRotation,
  CheckpointAction,
  CheckpointContext,
  CheckpointFn,
  ConvergenceSignal,
  Critique,
  CritiqueCategory,
  CritiqueSeverity,
  Draft,
  DraftCandidate,
  IterateConfig,
  IterateFormat,
  IterateProgressEvent,
  IterateResult,
  IterateSubject,
  Round,
  StoppedReason,
} from "./types.js";
