import type { ShellBusinessOperations } from "../../shared/shell-business-contracts.js";

export interface BusinessGrant {
  readonly requestId: string;
  readonly permit: Int32Array;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
type Method<K extends keyof ShellBusinessOperations> = (
  input: ShellBusinessOperations[K]["input"],
  grant: BusinessGrant,
) => ShellBusinessOperations[K]["result"] | Promise<ShellBusinessOperations[K]["result"]>;
export type BusinessMethods = { [K in keyof ShellBusinessOperations]: Method<K> };

/** Called by the durable owner after acquiring its lock, before any effect. */
export function claimBusinessCommit(permit: Int32Array): void {
  if (Atomics.compareExchange(permit, 0, 0, 1) !== 0) throw new Error("Document write was revoked");
}

export class HostBusinessCalls<T extends Partial<BusinessMethods> = BusinessMethods> {
  private readonly pending = new Map<string, { permit: Int32Array; controller: AbortController }>();
  constructor(private readonly methods: T) {}

  async run(id: string, method: string, input: unknown): Promise<unknown> {
    if (!Object.hasOwn(this.methods, method)) throw new Error("Unknown private business method");
    if (this.pending.has(id) || this.pending.size >= 512)
      throw new Error("Too many pending business calls");
    const state = {
      permit: new Int32Array(new SharedArrayBuffer(4)),
      controller: new AbortController(),
    };
    this.pending.set(id, state);
    const assertCurrent = () => {
      if (state.controller.signal.aborted) throw new Error("Document no longer owns the operation");
    };
    try {
      // Only Main can address this table. Each implementation validates its domain input.
      const run = this.methods[method as keyof T] as (
        value: unknown,
        grant: BusinessGrant,
      ) => unknown;
      const value = await run(input, {
        requestId: id,
        permit: state.permit,
        signal: state.controller.signal,
        assertCurrent,
      });
      assertCurrent();
      return value;
    } finally {
      this.pending.delete(id);
    }
  }

  revoke(id: string) {
    const state = this.pending.get(id);
    if (state) {
      Atomics.compareExchange(state.permit, 0, 0, -1);
      state.controller.abort();
    }
  }
  close() {
    for (const id of this.pending.keys()) this.revoke(id);
  }
}
