import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
import type { PetAttentionEvent } from "../../shared/mimi-attention.js";

/** Retains only the native foreground selection. Counts, peeks and receipt decisions come from Host. */
export class NativeMimiAttention {
  private listeners = new Set<(event: PetAttentionEvent) => void>();
  private active: string | null = null;
  private revision = 0;
  private epoch = 0;
  private countUpdates = 0;
  private enabled = false;
  private removeAbort?: () => void;
  constructor(
    private readonly call: CallShellBusiness,
    private readonly report: (error: unknown) => void,
  ) {}
  subscribe(listener: (event: PetAttentionEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  receive(event: PetAttentionEvent) {
    if (!this.enabled) return;
    if (event.kind === "count") ++this.countUpdates;
    for (const listener of this.listeners) listener(event);
  }
  getSnapshot() {
    return this.call("mimi/attentionSnapshot", {});
  }
  async start() {
    this.enabled = true;
    const epoch = this.epoch;
    const countUpdates = this.countUpdates;
    const snapshot = await this.call("mimi/attentionStart", {
      active: this.active,
      revision: this.revision,
    });
    if (epoch === this.epoch && this.countUpdates === countUpdates)
      this.receive({ kind: "count", ...snapshot });
  }
  reconnect() {
    if (this.enabled) void this.start().catch(this.report);
  }
  disconnect() {
    ++this.epoch;
    this.receive({ kind: "count", surfaceablePendingCount: 0 });
  }
  stop() {
    this.enabled = false;
    this.removeAbort?.();
    ++this.epoch;
  }
  setActiveSession(active: string | null, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.removeAbort?.();
    this.active = active;
    const revision = ++this.revision;
    if (signal && active) {
      const clear = () => {
        if (this.revision === revision) void this.setActiveSession(null).catch(this.report);
      };
      signal.addEventListener("abort", clear, { once: true });
      this.removeAbort = () => signal.removeEventListener("abort", clear);
    } else this.removeAbort = undefined;
    return this.call("mimi/attentionActive", { active, revision }, signal);
  }
  markReceipts(keys: readonly string[], state: "seen" | "dismissed", signal?: AbortSignal) {
    return this.call("mimi/attentionMark", { keys: [...keys], state }, signal);
  }
}
