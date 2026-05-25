import type { ModelPool } from "../llm/model-pool.js";

export interface EngineRuntimeOptions {
  modelPool: ModelPool;
}

/**
 * Shared read-only resources used by all Engine instances in a worker.
 * Mutable per-session state stays on Engine itself.
 */
export class EngineRuntime {
  readonly modelPool: ModelPool;

  constructor(opts: EngineRuntimeOptions) {
    this.modelPool = opts.modelPool;
  }
}
