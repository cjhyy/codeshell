import { canonicalOperationValue } from "./ledger.js";
import { OperationFailure } from "./controller.js";

export type CapabilityChannel = "link" | "mcp" | "cli" | "browser";
export interface CapabilityIntent {
  service: string;
  intent: string;
  risk: "read" | "write";
  account: string;
}
export interface CapabilityBinding {
  channel: CapabilityChannel;
  bindingId: string;
  account: string;
  /** Public authority snapshot, excluding tokens and rotating secrets. */
  authority: unknown;
}
export interface CapabilityAdapter {
  channel: CapabilityChannel;
  /** Trusted, bounded, read-only discovery; undefined means this adapter cannot serve it. */
  discover(intent: Readonly<CapabilityIntent>): Promise<CapabilityBinding | undefined>;
}
const priority: readonly CapabilityChannel[] = ["link", "mcp", "cli", "browser"];

/** Run-local sticky resolution. Callers supply reviewed adapters, never executable model input. */
export class CapabilityResolver {
  private readonly selected = new Map<
    string,
    { adapter: CapabilityAdapter; binding: CapabilityBinding }
  >();
  private readonly generations = new Map<string, number>();
  private readonly pending = new Map<string, Promise<CapabilityBinding>>();

  async resolve(
    intent: CapabilityIntent,
    adapters: readonly CapabilityAdapter[],
  ): Promise<CapabilityBinding> {
    const snapshot = JSON.parse(canonicalOperationValue(intent)) as CapabilityIntent;
    const key = canonicalOperationValue(snapshot);
    const pending = this.pending.get(key);
    if (pending) return structuredClone(await pending);
    const generation = this.generations.get(key) ?? 0;
    const current = () => {
      if ((this.generations.get(key) ?? 0) !== generation)
        throw new OperationFailure("stale_reference");
    };
    const candidates = [...adapters];
    const task = Promise.resolve().then(async () => {
      current();
      const previous = this.selected.get(key);
      if (previous) {
        const live = await previous.adapter.discover(Object.freeze(snapshot));
        current();
        if (!live || canonicalOperationValue(live) !== canonicalOperationValue(previous.binding))
          throw new OperationFailure("stale_reference");
        return previous.binding;
      }
      for (const channel of priority) {
        for (const adapter of candidates.filter((candidate) => candidate.channel === channel)) {
          const binding = await adapter.discover(Object.freeze(snapshot));
          current();
          if (!binding) continue;
          if (
            binding.channel !== channel ||
            binding.account !== snapshot.account ||
            !binding.bindingId
          )
            throw new OperationFailure("authentication");
          const fixed = JSON.parse(canonicalOperationValue(binding)) as CapabilityBinding;
          this.selected.set(key, { adapter, binding: fixed });
          return fixed;
        }
      }
      throw new OperationFailure("unsupported");
    });
    this.pending.set(key, task);
    try {
      return structuredClone(await task);
    } finally {
      if (this.pending.get(key) === task) this.pending.delete(key);
    }
  }

  /** Trusted caller must invalidate and preflight again after an authority change. */
  invalidate(intent: CapabilityIntent): void {
    const key = canonicalOperationValue(intent);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.selected.delete(key);
    this.pending.delete(key);
  }
}

/** Generic repeat-error budget. It never authorizes retrying a non-idempotent write. */
export class OperationErrorBudget {
  private readonly fingerprints = new Map<string, number>();
  private readonly strategies = new Set<string>();
  private browserRestarts = 0;
  observe(input: {
    fingerprint: string;
    strategy: string;
    pollingWithStopCondition?: boolean;
  }): boolean {
    if (input.pollingWithStopCondition) return true;
    if (
      !input.fingerprint ||
      input.fingerprint.length > 500 ||
      !input.strategy ||
      input.strategy.length > 100
    )
      return false;
    const count = (this.fingerprints.get(input.fingerprint) ?? 0) + 1;
    this.fingerprints.set(input.fingerprint, count);
    this.strategies.add(input.strategy);
    return count <= 2 && this.strategies.size <= 2 && this.fingerprints.size <= 100;
  }
  restartBrowser(): boolean {
    return ++this.browserRestarts <= 1;
  }
}
