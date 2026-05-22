/**
 * CostStateStore — an opaque snapshot/restore hook that Engine uses to
 * persist session-level cost state across `run({ sessionId })` calls.
 *
 * Engine itself doesn't compute prices or format summaries; it just hands
 * the state blob to whatever store was injected. The CLI's `costTracker`
 * is one concrete implementation; a SaaS backend might implement this
 * against a database instead.
 *
 * Default: no store is injected, and cost state is not persisted. Engine
 * continues to report per-run token usage via `EngineResult.usage` and
 * `LLMClientBase.getUsage()` — this hook is only for the
 * "resume-and-keep-counting" scenario.
 */

/** Arbitrary serializable snapshot — opaque to Engine. */
export type CostStateSnapshot = unknown;

export interface CostStateStore {
  /** Serialize current cost state for persistence. */
  serialize(): CostStateSnapshot;
  /** Restore previously-serialized cost state. */
  restore(state: CostStateSnapshot): void;
}
